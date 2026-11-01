package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AuthRequiredError is a 401/403 from the MCP server. ResourceMetadata is the
// RFC 9728 URL from WWW-Authenticate (may be empty).
type AuthRequiredError struct {
	Status           int
	ResourceMetadata string
	Scope            string
	OAuthError       string
}

func (e *AuthRequiredError) Error() string {
	if e.Status == http.StatusForbidden {
		return "mcp: server refused the credential (403 " + clip(e.OAuthError, 60) + ")"
	}
	return "mcp: server requires authorization (401)"
}

// HTTPTransport is the Streamable HTTP transport (2025-06-18 §Transports).
// One instance is one logical connection: it initializes lazily, carries the
// Mcp-Session-Id and MCP-Protocol-Version headers, re-initializes once on a
// 404 for an expired session, and sends notifications/cancelled when the
// caller's context ends mid-request.
type HTTPTransport struct {
	URL  string
	HTTP *http.Client
	// Token returns the bearer to send ("" = none). It is called per request so
	// a refreshed token is picked up; its value is never logged.
	Token            func(ctx context.Context) (string, error)
	MaxResponseBytes int64

	mu        sync.Mutex
	inited    bool
	sessionID string
	version   string
	nextID    int64
}

// Call implements Transport.
func (t *HTTPTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := t.ensureInit(ctx); err != nil {
		return nil, err
	}
	res, err := t.roundTrip(ctx, method, params)
	var exp *sessionExpiredError
	if errors.As(err, &exp) {
		t.mu.Lock()
		t.inited, t.sessionID = false, ""
		t.mu.Unlock()
		if err := t.ensureInit(ctx); err != nil {
			return nil, err
		}
		return t.roundTrip(ctx, method, params)
	}
	return res, err
}

// Close terminates the session (DELETE); a 405 means the server does not allow it.
func (t *HTTPTransport) Close(ctx context.Context) error {
	t.mu.Lock()
	sid := t.sessionID
	t.inited, t.sessionID = false, ""
	t.mu.Unlock()
	if sid == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, t.URL, nil)
	if err != nil {
		return err
	}
	if err := t.headers(ctx, req, sid); err != nil {
		return err
	}
	resp, err := t.HTTP.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

type sessionExpiredError struct{}

func (*sessionExpiredError) Error() string { return "mcp: session expired" }

func (t *HTTPTransport) ensureInit(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.inited {
		return nil
	}
	// initialize is never cancelled (lifecycle rule), and carries no session id.
	id := t.newIDLocked()
	resp, sid, err := t.post(ctx, request(id, "initialize", initializeParams()), "", "")
	if err != nil {
		return err
	}
	raw, err := resultOf(*resp)
	if err != nil {
		return err
	}
	v, err := checkInitialize(raw)
	if err != nil {
		return err
	}
	t.sessionID, t.version = sid, v
	if _, _, err := t.post(ctx, notification("notifications/initialized", nil), sid, v); err != nil {
		return err
	}
	t.inited = true
	return nil
}

func (t *HTTPTransport) newIDLocked() string {
	t.nextID++
	return strconv.FormatInt(t.nextID, 10)
}

func (t *HTTPTransport) roundTrip(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	id, sid, v := t.newIDLocked(), t.sessionID, t.version
	t.mu.Unlock()
	resp, _, err := t.post(ctx, request(id, method, params), sid, v)
	if err != nil {
		if ctx.Err() != nil {
			t.cancel(id, sid, v)
		}
		return nil, err
	}
	return resultOf(*resp)
}

// cancel sends notifications/cancelled on a short detached context.
func (t *HTTPTransport) cancel(id, sid, v string) {
	ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	_, _, _ = t.post(ctx, notification("notifications/cancelled",
		map[string]any{"requestId": json.RawMessage(id), "reason": "client cancelled"}), sid, v)
}

func (t *HTTPTransport) headers(ctx context.Context, req *http.Request, sid string) error {
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	if t.version != "" {
		req.Header.Set("MCP-Protocol-Version", t.version)
	}
	if t.Token != nil {
		tok, err := t.Token(ctx)
		if err != nil {
			return err
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	return nil
}

// post sends one message. For a request it returns the matching response
// (from a JSON body or an SSE stream); for a notification, (nil, sid, nil).
func (t *HTTPTransport) post(ctx context.Context, msg rpcMessage, sid, version string) (*rpcMessage, string, error) {
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.URL, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	if version != "" {
		req.Header.Set("MCP-Protocol-Version", version)
	}
	if t.Token != nil {
		tok, err := t.Token(ctx)
		if err != nil {
			return nil, "", err
		}
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	resp, err := t.HTTP.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("mcp: post: %w", err)
	}
	defer resp.Body.Close()
	newSID := resp.Header.Get("Mcp-Session-Id")
	if newSID == "" {
		newSID = sid
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		p := ParseWWWAuthenticate(resp.Header.Get("WWW-Authenticate"))
		return nil, "", &AuthRequiredError{Status: resp.StatusCode, ResourceMetadata: p["resource_metadata"],
			Scope: p["scope"], OAuthError: p["error"]}
	case resp.StatusCode == http.StatusNotFound && sid != "":
		return nil, "", &sessionExpiredError{}
	case msg.ID == nil:
		if resp.StatusCode/100 != 2 {
			return nil, "", fmt.Errorf("mcp: notification rejected: HTTP %d", resp.StatusCode)
		}
		return nil, newSID, nil
	case resp.StatusCode/100 != 2:
		return nil, "", fmt.Errorf("mcp: HTTP %d", resp.StatusCode)
	}
	limit := t.MaxResponseBytes
	if limit <= 0 {
		limit = DefaultMaxRespLen
	}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	switch ct {
	case "application/json":
		b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil {
			return nil, "", err
		}
		if int64(len(b)) > limit {
			return nil, "", ErrResponseTooLarge
		}
		var m rpcMessage
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, "", fmt.Errorf("mcp: decode response: %w", err)
		}
		if !sameID(m.ID, msg.ID) {
			return nil, "", errors.New("mcp: response id does not match request")
		}
		return &m, newSID, nil
	case "text/event-stream":
		m, err := readSSEResponse(resp.Body, msg.ID, limit)
		return m, newSID, err
	}
	return nil, "", fmt.Errorf("mcp: unexpected content type %q", clip(ct, 60))
}

// readSSEResponse reads an SSE stream until the response to id arrives.
// Server notifications and requests on the stream are skipped (PAL declares
// no client capabilities). Total bytes read are capped at limit.
func readSSEResponse(r io.Reader, id json.RawMessage, limit int64) (*rpcMessage, error) {
	lr := &io.LimitedReader{R: r, N: limit + 1}
	sc := bufio.NewScanner(lr)
	sc.Buffer(make([]byte, 0, 64<<10), int(limit)+1)
	var data strings.Builder
	flush := func() (*rpcMessage, bool) {
		defer data.Reset()
		if data.Len() == 0 {
			return nil, false
		}
		var m rpcMessage
		if json.Unmarshal([]byte(data.String()), &m) != nil || m.Method != "" {
			return nil, false
		}
		return &m, sameID(m.ID, id)
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if m, ok := flush(); ok {
				return m, nil
			}
			continue
		}
		if v, ok := strings.CutPrefix(line, "data:"); ok {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(v, " "))
		}
	}
	if lr.N <= 0 {
		return nil, ErrResponseTooLarge
	}
	if m, ok := flush(); ok {
		return m, nil
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return nil, ErrResponseTooLarge
		}
		return nil, fmt.Errorf("mcp: read event stream: %w", err)
	}
	return nil, errors.New("mcp: event stream ended without a response")
}

// ParseWWWAuthenticate extracts the auth-params of a Bearer challenge
// (RFC 6750 §3 / RFC 9728 §5.1). Parameter names are lowercased.
func ParseWWWAuthenticate(h string) map[string]string {
	out := map[string]string{}
	scheme, rest, _ := strings.Cut(strings.TrimSpace(h), " ")
	if !strings.EqualFold(scheme, "bearer") {
		return out
	}
	for rest = strings.TrimSpace(rest); rest != ""; rest = strings.TrimSpace(rest) {
		k, after, ok := strings.Cut(rest, "=")
		if !ok {
			break
		}
		k = strings.ToLower(strings.TrimSpace(k))
		var v string
		if strings.HasPrefix(after, `"`) {
			end := 1
			var b strings.Builder
			for ; end < len(after) && after[end] != '"'; end++ {
				if after[end] == '\\' && end+1 < len(after) {
					end++
				}
				b.WriteByte(after[end])
			}
			v, rest = b.String(), strings.TrimPrefix(after[min(end+1, len(after)):], ",")
			rest = strings.TrimLeft(rest, " ,")
		} else {
			v, rest, _ = strings.Cut(after, ",")
			v = strings.TrimSpace(v)
		}
		out[k] = v
	}
	return out
}

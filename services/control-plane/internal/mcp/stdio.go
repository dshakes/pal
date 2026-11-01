package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// ExecFunc runs command+argv INSIDE a tenant microVM and streams its stdout to
// onStdout. Returning a non-nil error from onStdout stops the exec early. The
// control-plane wires this to RuntimeManager.Exec; there is deliberately no
// host implementation (invariant #5: an MCP server process is untrusted code).
type ExecFunc func(ctx context.Context, command string, argv []string, onStdout func([]byte) error) error

// StdioTransport speaks the stdio transport to a server started inside a VM.
// Exec is one-shot, so every Call is its own process: initialize →
// notifications/initialized → the request, newline-delimited on stdin, and the
// process is stopped as soon as the response line arrives. Stdin is held open
// (sleep) for up to Timeout so servers that exit on EOF still answer.
type StdioTransport struct {
	// Command is the server command line, run by /bin/sh inside the VM.
	Command          string
	Exec             ExecFunc
	Timeout          time.Duration
	MaxResponseBytes int64
}

// stdioScript feeds $1 (base64 of the JSON-RPC lines) to the server ($2),
// keeps stdin open for $3 seconds, and bounds the whole thing with timeout.
const stdioScript = `{ printf '%s' "$1" | base64 -d; sleep "$3"; } | timeout "$3" /bin/sh -c "$2"`

var errStdioDone = errors.New("mcp: stdio response received")

// Call implements Transport.
func (t *StdioTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if t.Exec == nil {
		return nil, errors.New("mcp: stdio servers run only inside a sandbox VM; none is bound")
	}
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	limit := t.MaxResponseBytes
	if limit <= 0 {
		limit = DefaultMaxRespLen
	}
	const initID, reqID = `"pal-init"`, `"pal-req"`
	var in bytes.Buffer
	for _, m := range []rpcMessage{
		request(initID, "initialize", initializeParams()),
		notification("notifications/initialized", nil),
		request(reqID, method, params),
	} {
		b, err := json.Marshal(m)
		if err != nil {
			return nil, err
		}
		in.Write(b)
		in.WriteByte('\n')
	}
	secs := strconv.Itoa(int(timeout / time.Second))
	argv := []string{"-c", stdioScript, "pal-mcp", base64.StdEncoding.EncodeToString(in.Bytes()), t.Command, secs}

	ctx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	var (
		buf     []byte
		total   int64
		inited  bool
		result  json.RawMessage
		callErr error
	)
	err := t.Exec(ctx, "/bin/sh", argv, func(chunk []byte) error {
		total += int64(len(chunk))
		if total > limit {
			return ErrResponseTooLarge
		}
		buf = append(buf, chunk...)
		for {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				return nil
			}
			line := bytes.TrimSpace(buf[:i])
			buf = buf[i+1:]
			var m rpcMessage
			if len(line) == 0 || json.Unmarshal(line, &m) != nil || m.Method != "" {
				continue // server log lines / notifications / requests
			}
			switch {
			case sameID(m.ID, json.RawMessage(initID)):
				raw, err := resultOf(m)
				if err == nil {
					_, err = checkInitialize(raw)
				}
				if err != nil {
					callErr = err
					return errStdioDone
				}
				inited = true
			case sameID(m.ID, json.RawMessage(reqID)):
				if !inited {
					callErr = errors.New("mcp: stdio server answered before initialize")
					return errStdioDone
				}
				result, callErr = resultOf(m)
				return errStdioDone
			}
		}
	})
	switch {
	case errors.Is(err, errStdioDone):
		return result, callErr
	case err != nil:
		return nil, fmt.Errorf("mcp: stdio exec: %w", err)
	}
	return nil, errors.New("mcp: stdio server exited without a response")
}

// Close implements Transport; each Call is already its own process.
func (t *StdioTransport) Close(context.Context) error { return nil }

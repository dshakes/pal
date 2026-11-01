package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// This file implements the client side of MCP authorization (2025-06-18
// §Authorization): protected-resource metadata discovery (RFC 9728),
// authorization-server metadata discovery (RFC 8414 / OIDC fallback), dynamic
// client registration (RFC 7591), authorization code + PKCE S256, and the
// `resource` parameter (RFC 8707) on both the authorization and token requests.

const maxMetadataBytes = 64 << 10

// ProtectedResourceMetadata is the subset of RFC 9728 §2 PAL uses.
type ProtectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported,omitempty"`
}

// AuthServerMetadata is the subset of RFC 8414 §2 PAL uses.
type AuthServerMetadata struct {
	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorization_endpoint"`
	TokenEndpoint                 string   `json:"token_endpoint"`
	RegistrationEndpoint          string   `json:"registration_endpoint,omitempty"`
	CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported,omitempty"`
}

// Token is a token-endpoint response. Never log it.
type Token struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int64  `json:"expires_in,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

// CanonicalResource returns the RFC 8707 resource identifier for an MCP server
// URL: lowercase scheme and host, no fragment, no trailing slash.
func CanonicalResource(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("mcp: %q is not an absolute URL", raw)
	}
	u.Scheme, u.Host, u.Fragment, u.RawFragment = strings.ToLower(u.Scheme), strings.ToLower(u.Host), "", ""
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawPath = ""
	return u.String(), nil
}

func origin(u *url.URL) string { return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) }

// DiscoverResource fetches the protected-resource metadata for mcpURL. hint is
// the resource_metadata URL from WWW-Authenticate ("" → RFC 9728 well-known
// location, path-inserted then root). The metadata must describe a resource
// on the same origin whose path prefixes the MCP URL — a server cannot point
// PAL's credential at a different resource.
func DiscoverResource(ctx context.Context, hc *http.Client, p DialPolicy, mcpURL, hint string) (*ProtectedResourceMetadata, error) {
	mu, err := p.CheckURL(mcpURL)
	if err != nil {
		return nil, err
	}
	var candidates []string
	if hint != "" {
		hu, err := p.CheckURL(hint)
		if err != nil {
			return nil, err
		}
		if origin(hu) != origin(mu) {
			return nil, errors.New("mcp: resource_metadata is on a different origin than the MCP server")
		}
		candidates = []string{hint}
	} else {
		path := strings.TrimSuffix(mu.EscapedPath(), "/")
		if path != "" {
			candidates = append(candidates, origin(mu)+"/.well-known/oauth-protected-resource"+path)
		}
		candidates = append(candidates, origin(mu)+"/.well-known/oauth-protected-resource")
	}
	var lastErr error
	for _, c := range candidates {
		var m ProtectedResourceMetadata
		if lastErr = getJSON(ctx, hc, c, &m); lastErr != nil {
			continue
		}
		want, _ := CanonicalResource(mcpURL)
		got, err := CanonicalResource(m.Resource)
		if err != nil || !(got == want || strings.HasPrefix(want, got+"/") || got == origin(mu)) {
			return nil, errors.New("mcp: protected-resource metadata names a different resource")
		}
		if len(m.AuthorizationServers) == 0 {
			return nil, errors.New("mcp: protected-resource metadata lists no authorization server")
		}
		return &m, nil
	}
	return nil, fmt.Errorf("mcp: protected-resource metadata not found: %w", lastErr)
}

// DiscoverAuthServer fetches RFC 8414 metadata for issuer, falling back to
// OpenID Connect discovery, and checks the issuer matches (RFC 8414 §3.3) and
// that PKCE S256 is supported when the server says what it supports.
func DiscoverAuthServer(ctx context.Context, hc *http.Client, p DialPolicy, issuer string) (*AuthServerMetadata, error) {
	iu, err := p.CheckURL(issuer)
	if err != nil {
		return nil, err
	}
	o, path := origin(iu), strings.TrimSuffix(iu.EscapedPath(), "/")
	candidates := []string{o + "/.well-known/oauth-authorization-server" + path, o + "/.well-known/openid-configuration" + path}
	if path != "" {
		candidates = append(candidates, o+path+"/.well-known/openid-configuration")
	}
	var lastErr error
	for _, c := range candidates {
		var m AuthServerMetadata
		if lastErr = getJSON(ctx, hc, c, &m); lastErr != nil {
			continue
		}
		if strings.TrimSuffix(m.Issuer, "/") != strings.TrimSuffix(issuer, "/") {
			return nil, errors.New("mcp: authorization server metadata issuer mismatch")
		}
		if len(m.CodeChallengeMethodsSupported) > 0 && !slices.Contains(m.CodeChallengeMethodsSupported, "S256") {
			return nil, errors.New("mcp: authorization server does not support PKCE S256")
		}
		for _, e := range []string{m.AuthorizationEndpoint, m.TokenEndpoint} {
			if _, err := p.CheckURL(e); err != nil {
				return nil, fmt.Errorf("mcp: authorization server endpoint refused: %w", err)
			}
		}
		if m.RegistrationEndpoint != "" {
			if _, err := p.CheckURL(m.RegistrationEndpoint); err != nil {
				return nil, fmt.Errorf("mcp: registration endpoint refused: %w", err)
			}
		}
		return &m, nil
	}
	return nil, fmt.Errorf("mcp: authorization server metadata not found: %w", lastErr)
}

// RegisterClient performs RFC 7591 dynamic registration of a public client.
func RegisterClient(ctx context.Context, hc *http.Client, as *AuthServerMetadata, redirectURI string) (clientID, clientSecret string, err error) {
	if as.RegistrationEndpoint == "" {
		return "", "", errors.New("mcp: authorization server has no registration endpoint; configure a client id")
	}
	body, _ := json.Marshal(map[string]any{
		"client_name":                "PAL",
		"redirect_uris":              []string{redirectURI},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, as.RegistrationEndpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	var res struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := doJSON(hc, req, &res); err != nil {
		return "", "", fmt.Errorf("mcp: client registration: %w", err)
	}
	if res.ClientID == "" {
		return "", "", errors.New("mcp: client registration returned no client_id")
	}
	return res.ClientID, res.ClientSecret, nil
}

// NewPKCE returns a 43-char S256 verifier and its challenge.
func NewPKCE() (verifier, challenge string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// RandomState returns an unguessable OAuth state value.
func RandomState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// AuthorizeURL builds the authorization request (code + PKCE + resource).
func AuthorizeURL(as *AuthServerMetadata, clientID, redirectURI, state, challenge, resource, scope string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {clientID},
		"redirect_uri":          {redirectURI},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"resource":              {resource},
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	sep := "?"
	if strings.Contains(as.AuthorizationEndpoint, "?") {
		sep = "&"
	}
	return as.AuthorizationEndpoint + sep + q.Encode()
}

// ExchangeCode redeems an authorization code.
func ExchangeCode(ctx context.Context, hc *http.Client, as *AuthServerMetadata, clientID, clientSecret, code, verifier, redirectURI, resource string) (*Token, error) {
	return tokenRequest(ctx, hc, as, clientID, clientSecret, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURI},
		"resource":      {resource},
	})
}

// Refresh redeems a refresh token (keeping the resource binding).
func Refresh(ctx context.Context, hc *http.Client, as *AuthServerMetadata, clientID, clientSecret, refreshToken, resource string) (*Token, error) {
	return tokenRequest(ctx, hc, as, clientID, clientSecret, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"resource":      {resource},
	})
}

func tokenRequest(ctx context.Context, hc *http.Client, as *AuthServerMetadata, clientID, clientSecret string, form url.Values) (*Token, error) {
	if clientSecret == "" {
		form.Set("client_id", clientID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, as.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if clientSecret != "" {
		req.SetBasicAuth(url.QueryEscape(clientID), url.QueryEscape(clientSecret))
	}
	var t Token
	if err := doJSON(hc, req, &t); err != nil {
		return nil, fmt.Errorf("mcp: token endpoint: %w", err)
	}
	if t.AccessToken == "" {
		return nil, errors.New("mcp: token endpoint returned no access_token")
	}
	if t.TokenType != "" && !strings.EqualFold(t.TokenType, "bearer") {
		return nil, errors.New("mcp: token endpoint returned a non-bearer token")
	}
	return &t, nil
}

func getJSON(ctx context.Context, hc *http.Client, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	return doJSON(hc, req, out)
}

// doJSON performs req and decodes a bounded JSON body. Error bodies are never
// echoed (an OAuth error body can contain the submitted code / token).
func doJSON(hc *http.Client, req *http.Request, out any) error {
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return fmt.Errorf("HTTP %d %s", resp.StatusCode, clip(e.Error, 40))
	}
	if len(b) > maxMetadataBytes {
		return ErrResponseTooLarge
	}
	return json.Unmarshal(b, out)
}

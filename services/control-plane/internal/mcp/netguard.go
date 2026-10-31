package mcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// DialPolicy decides which addresses an outbound MCP/OAuth connection may
// reach. Link-local (cloud metadata), unspecified and multicast are ALWAYS
// refused; loopback and private ranges only when explicitly allowed.
type DialPolicy struct {
	AllowPrivate  bool // RFC 1918 / ULA / CGNAT
	AllowLoopback bool
	RequireHTTPS  bool
}

// ErrBlockedAddress is returned when a dial targets a refused address.
var ErrBlockedAddress = errors.New("mcp: destination address is not allowed (SSRF guard)")

// Allowed reports whether ip may be dialled under p.
func (p DialPolicy) Allowed(ip net.IP) bool {
	switch {
	case ip == nil, ip.IsUnspecified(), ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast(),
		ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return false
	case ip.IsLoopback():
		return p.AllowLoopback
	case ip.IsPrivate(), cgnat.Contains(ip):
		return p.AllowPrivate
	}
	return true
}

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// CheckURL validates an MCP server / OAuth endpoint URL statically. The
// address check proper happens at dial time (DNS-rebinding safe).
func (p DialPolicy) CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("mcp: invalid URL: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if p.RequireHTTPS {
			return nil, errors.New("mcp: URL must use https")
		}
	default:
		return nil, errors.New("mcp: URL must use http(s)")
	}
	if u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("mcp: URL must have a host and no userinfo or fragment")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !p.Allowed(ip) {
		return nil, ErrBlockedAddress
	}
	return u, nil
}

// NewHTTPClient returns a client that checks every dialled IP against p,
// ignores proxy env vars (a proxy would hide the real destination), refuses
// redirects (one could point at an internal host) and has a total timeout.
func (p DialPolicy) NewHTTPClient(timeout time.Duration) *http.Client {
	d := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if !p.Allowed(net.ParseIP(host)) {
				return ErrBlockedAddress
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           func(ctx context.Context, n, a string) (net.Conn, error) { return d.DialContext(ctx, n, a) },
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: timeout,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       90 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("mcp: redirects are not followed")
		},
	}
}

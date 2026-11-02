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
	// AllowFakeIP lifts the benchmarking range 198.18.0.0/15, where fake-IP
	// proxies (Clash, Surge) map every hostname on a dev machine. DEV ONLY:
	// set it only on the non-prod policies; it lifts nothing else.
	AllowFakeIP bool
}

// ErrBlockedAddress is returned when a dial targets a refused address.
var ErrBlockedAddress = errors.New("mcp: destination address is not allowed (SSRF guard)")

// Allowed reports whether ip may be dialled under p.
func (p DialPolicy) Allowed(ip net.IP) bool {
	// 6to4 (2002::/16) carries an IPv4 address in bytes 2-5 and reaches it via
	// a relay: judge the embedded address, so 2002:7f00:1:: is loopback.
	if ip.To4() == nil && sixToFour.Contains(ip) {
		b := ip.To16()
		return p.Allowed(net.IPv4(b[2], b[3], b[4], b[5]))
	}
	// Teredo (2001::/32) tunnels to an IPv4 server (bytes 4-7) and an
	// obfuscated IPv4 client (bytes 12-15, XOR 0xff): judge both embedded
	// addresses, so a Teredo literal cannot smuggle loopback/private/metadata.
	if ip.To4() == nil && teredo.Contains(ip) {
		b := ip.To16()
		return p.Allowed(net.IPv4(b[4], b[5], b[6], b[7])) &&
			p.Allowed(net.IPv4(^b[12], ^b[13], ^b[14], ^b[15]))
	}
	if p.AllowFakeIP && fakeIP.Contains(ip) {
		return true
	}
	for _, n := range alwaysRefused {
		if n.Contains(ip) {
			return false
		}
	}
	switch {
	case ip == nil, ip.IsUnspecified(), ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast(),
		ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return false
	case ip.IsLoopback():
		return p.AllowLoopback
	case ip.IsPrivate(), cgnat.Contains(ip), nat64.Contains(ip):
		return p.AllowPrivate
	}
	return true
}

var (
	// alwaysRefused are never a legitimate public destination, whatever the
	// policy: benchmarking (198.18.0.0/15), IETF protocol assignments
	// (192.0.0.0/24), reserved + broadcast (240.0.0.0/4), and the Azure
	// wireserver (168.63.129.16, metadata-class: it hands out VM config).
	alwaysRefused = []*net.IPNet{
		{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)},
		{IP: net.IPv4(192, 0, 0, 0), Mask: net.CIDRMask(24, 32)},
		{IP: net.IPv4(240, 0, 0, 0), Mask: net.CIDRMask(4, 32)},
		{IP: net.IPv4(168, 63, 129, 16), Mask: net.CIDRMask(32, 32)},
	}
	fakeIP    = alwaysRefused[0] // 198.18.0.0/15
	sixToFour = &net.IPNet{IP: net.ParseIP("2002::"), Mask: net.CIDRMask(16, 128)}
	teredo    = &net.IPNet{IP: net.ParseIP("2001::"), Mask: net.CIDRMask(32, 128)}
	cgnat     = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
	// nat64 (64:ff9b::/96) can reach any IPv4 address, internal ones included.
	nat64 = &net.IPNet{IP: net.ParseIP("64:ff9b::"), Mask: net.CIDRMask(96, 128)}
)

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

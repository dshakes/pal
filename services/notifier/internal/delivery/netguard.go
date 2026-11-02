package delivery

// SSRF guard for deliverers that POST to a tenant-supplied URL (webhook,
// Slack, Discord). The address policy is copied from the control-plane's
// internal/mcp/netguard.go (separate Go module, so no import); change both
// together.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// dialPolicy decides which addresses an outbound delivery may reach.
// Link-local (cloud metadata), unspecified, multicast and the alwaysRefused
// ranges are refused everywhere; loopback/private only when allowed.
type dialPolicy struct {
	AllowPrivate  bool // RFC 1918 / ULA / CGNAT / NAT64
	AllowLoopback bool
	AllowFakeIP   bool // 198.18.0.0/15 (Clash/Surge fake-IP); dev only
	RequireHTTPS  bool
}

// errBlockedAddress is returned when a delivery targets a refused address.
var errBlockedAddress = errors.New("notifier: destination address is not allowed (SSRF guard)")

// IsProd mirrors the platform's PAL_ENV convention.
func IsProd() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PAL_ENV"))) {
	case "prod", "production", "staging":
		return true
	}
	return false
}

// deliveryDialPolicy: prod requires https and refuses loopback/private.
// PAL_NOTIFIER_ALLOW_PRIVATE=1 lifts the private/loopback/fake-IP block in dev
// only (local receivers); it is ignored in prod.
func deliveryDialPolicy() dialPolicy {
	if IsProd() {
		return dialPolicy{RequireHTTPS: true}
	}
	if os.Getenv("PAL_NOTIFIER_ALLOW_PRIVATE") == "1" {
		return dialPolicy{AllowPrivate: true, AllowLoopback: true, AllowFakeIP: true}
	}
	return dialPolicy{}
}

func (p dialPolicy) allowed(ip net.IP) bool {
	if ip == nil {
		return false
	}
	// 6to4 (2002::/16) reaches the IPv4 in bytes 2-5 through a relay.
	if ip.To4() == nil && sixToFour.Contains(ip) {
		b := ip.To16()
		return p.allowed(net.IPv4(b[2], b[3], b[4], b[5]))
	}
	// Teredo (2001::/32): server IPv4 in bytes 4-7, client IPv4 XOR 0xff in 12-15.
	if ip.To4() == nil && teredo.Contains(ip) {
		b := ip.To16()
		return p.allowed(net.IPv4(b[4], b[5], b[6], b[7])) &&
			p.allowed(net.IPv4(^b[12], ^b[13], ^b[14], ^b[15]))
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
	case ip.IsUnspecified(), ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast(),
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
	// Never a legitimate public destination: benchmarking (also fake-IP
	// proxies), IETF protocol assignments, reserved + broadcast, and the Azure
	// wireserver (metadata-class).
	alwaysRefused = []*net.IPNet{
		{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)},
		{IP: net.IPv4(192, 0, 0, 0), Mask: net.CIDRMask(24, 32)},
		{IP: net.IPv4(240, 0, 0, 0), Mask: net.CIDRMask(4, 32)},
		{IP: net.IPv4(168, 63, 129, 16), Mask: net.CIDRMask(32, 32)},
	}
	fakeIP    = alwaysRefused[0]
	sixToFour = &net.IPNet{IP: net.ParseIP("2002::"), Mask: net.CIDRMask(16, 128)}
	teredo    = &net.IPNet{IP: net.ParseIP("2001::"), Mask: net.CIDRMask(32, 128)}
	cgnat     = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
	nat64     = &net.IPNet{IP: net.ParseIP("64:ff9b::"), Mask: net.CIDRMask(96, 128)}
)

// checkURL validates a delivery URL statically; the address check proper
// happens at dial time (DNS-rebinding safe).
func (p dialPolicy) checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("notifier: invalid URL: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if p.RequireHTTPS {
			return errors.New("notifier: URL must use https")
		}
	default:
		return errors.New("notifier: URL must use http(s)")
	}
	if u.Hostname() == "" || u.User != nil {
		return errors.New("notifier: URL must have a host and no userinfo")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !p.allowed(ip) {
		return errBlockedAddress
	}
	return nil
}

// newHTTPClient checks every dialled IP against p, ignores proxy env vars (a
// proxy would hide the real destination) and does not follow redirects (a
// 3xx is the receiver's answer, recorded as a non-2xx delivery).
func (p dialPolicy) newHTTPClient(timeout time.Duration) *http.Client {
	d := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if !p.allowed(net.ParseIP(host)) {
				return errBlockedAddress
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
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

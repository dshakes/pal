package delivery

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
)

const testRoot = "test-root-key-0123456789abcdef0123456789"

// newLocalWebhook returns a deliverer allowed to reach the httptest loopback
// server (the dev-only override).
func newLocalWebhook(t *testing.T) *WebhookDeliverer {
	t.Helper()
	t.Setenv("PAL_ENV", "")
	t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "1")
	t.Setenv("PAL_NOTIFIER_SIGNING_KEY", testRoot)
	d, err := NewWebhookDeliverer(zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

type captured struct {
	h    http.Header
	body []byte
}

func captureServer(t *testing.T) (*httptest.Server, chan captured) {
	t.Helper()
	got := make(chan captured, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- captured{r.Header.Clone(), b}
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

// verify is what a receiver does: recompute HMAC(key, "<t>.<body>").
func verify(key []byte, header string, body []byte) bool {
	var ts, sig string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(part, "=")
		switch k {
		case "t":
			ts = v
		case "v1":
			sig = v
		}
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return ts != "" && hmac.Equal([]byte(sig), []byte(want))
}

// Outbound webhooks carry the X-Pal-* headers and a signature only the
// holder of the tenant's derived key can produce.
func TestWebhookDeliver_SignedWithPerTenantKey(t *testing.T) {
	srv, got := captureServer(t)
	d := newLocalWebhook(t)
	res, err := d.Deliver(context.Background(), &Notification{
		ID: "n1", TenantID: "t1", Recipient: srv.URL, Body: "hi", IdempotencyKey: "k1",
	})
	if err != nil || !res.Success {
		t.Fatalf("deliver: %+v %v", res, err)
	}
	c := <-got
	for _, name := range []string{"Signature", "Delivery-ID", "Idempotency-Key"} {
		if c.h.Get("X-Pal-"+name) == "" {
			t.Errorf("missing X-Pal-%s header", name)
		}
	}
	sig := c.h.Get("X-Pal-Signature")
	key, _ := WebhookSigningKey([]byte(testRoot), "t1")
	if !verify(key, sig, c.body) {
		t.Fatalf("receiver with the tenant key cannot verify %q", sig)
	}
	// The old scheme keyed the HMAC by the tenant id, which is not secret.
	if verify([]byte("t1"), sig, c.body) {
		t.Fatal("signature is forgeable from the tenant id")
	}
	other, _ := WebhookSigningKey([]byte(testRoot), "t2")
	if verify(other, sig, c.body) {
		t.Fatal("another tenant's key verifies this tenant's webhook")
	}
	tampered := append([]byte{}, c.body...)
	tampered[len(tampered)-2] ^= 1
	if verify(key, sig, tampered) {
		t.Fatal("tampered body verified")
	}
}

func TestWebhookSigningRoot(t *testing.T) {
	cases := []struct {
		env, key string
		wantErr  bool
	}{
		{"production", "", true},
		{"staging", "short", true},
		{"prod", strings.Repeat("k", 32), false},
		{"", "", false}, // dev: well-known key
	}
	for _, tc := range cases {
		t.Setenv("PAL_ENV", tc.env)
		t.Setenv("PAL_NOTIFIER_SIGNING_KEY", tc.key)
		_, err := NewWebhookDeliverer(zap.NewNop())
		if (err != nil) != tc.wantErr {
			t.Errorf("env=%q key len %d: err=%v, wantErr=%v", tc.env, len(tc.key), err, tc.wantErr)
		}
	}
}

func TestSignWebhook_Format(t *testing.T) {
	got := SignWebhook([]byte("k"), []byte(`{}`), time.Unix(1700000000, 0))
	if !strings.HasPrefix(got, "t=1700000000,v1=") || len(got) != len("t=1700000000,v1=")+64 {
		t.Fatalf("got %q", got)
	}
}

// SSRF: loopback/private/metadata targets are refused without the dev
// override, the override is ignored in prod, prod requires https, and
// redirects are not followed.
func TestWebhookDeliver_SSRFGuard(t *testing.T) {
	srv, got := captureServer(t)
	deliver := func(t *testing.T, url string) *DeliveryResult {
		t.Helper()
		d, err := NewWebhookDeliverer(zap.NewNop())
		if err != nil {
			t.Fatal(err)
		}
		res, err := d.Deliver(context.Background(), &Notification{ID: "n", TenantID: "t", Recipient: url, Body: "b"})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	t.Setenv("PAL_NOTIFIER_SIGNING_KEY", strings.Repeat("k", 32))

	t.Run("loopback refused by default", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "")
		if res := deliver(t, srv.URL); res.Success || !strings.Contains(res.ErrorMessage, "SSRF") {
			t.Fatalf("loopback delivered: %+v", res)
		}
	})
	t.Run("hostname resolving to loopback refused at dial", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "")
		_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
		if res := deliver(t, "http://localhost:"+port+"/"); res.Success || !strings.Contains(res.ErrorMessage, "SSRF") {
			t.Fatalf("localhost delivered: %+v", res)
		}
	})
	t.Run("dev override ignored in prod", func(t *testing.T) {
		t.Setenv("PAL_ENV", "production")
		t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "1")
		if res := deliver(t, strings.Replace(srv.URL, "http://", "https://", 1)); res.Success || !strings.Contains(res.ErrorMessage, "SSRF") {
			t.Fatalf("prod reached loopback: %+v", res)
		}
	})
	t.Run("prod requires https", func(t *testing.T) {
		t.Setenv("PAL_ENV", "production")
		if res := deliver(t, "http://example.com/hook"); res.Success || !strings.Contains(res.ErrorMessage, "https") {
			t.Fatalf("plain http accepted in prod: %+v", res)
		}
	})
	t.Run("redirect not followed", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "1")
		redir := httptest.NewServer(http.RedirectHandler(srv.URL, http.StatusTemporaryRedirect))
		defer redir.Close()
		res := deliver(t, redir.URL)
		if res.Success || res.StatusCode != http.StatusTemporaryRedirect {
			t.Fatalf("redirect followed or misreported: %+v", res)
		}
		select {
		case <-got:
			t.Fatal("redirect target was reached")
		default:
		}
	})
}

// Slack and Discord also POST to the tenant-supplied Recipient.
func TestSlackDiscord_SSRFGuard(t *testing.T) {
	srv, _ := captureServer(t)
	t.Setenv("PAL_ENV", "")
	t.Setenv("PAL_NOTIFIER_ALLOW_PRIVATE", "")
	for _, d := range []Deliverer{NewSlackDeliverer(zap.NewNop()), NewDiscordDeliverer(zap.NewNop())} {
		res, err := d.Deliver(context.Background(), &Notification{ID: "n", TenantID: "t", Recipient: srv.URL, Body: "b"})
		if err == nil && res != nil && res.Success {
			t.Fatalf("%s delivered to loopback", d.Channel())
		}
	}
}

func TestDialPolicy(t *testing.T) {
	strict := dialPolicy{}
	dev := dialPolicy{AllowPrivate: true, AllowLoopback: true, AllowFakeIP: true}
	cases := []struct {
		p    dialPolicy
		ip   string
		want bool
	}{
		{strict, "93.184.216.34", true},
		{strict, "127.0.0.1", false},
		{strict, "10.1.2.3", false},
		{strict, "192.168.1.1", false},
		{strict, "100.64.0.1", false},
		{strict, "169.254.169.254", false},
		{strict, "::ffff:169.254.169.254", false},
		{strict, "fd00::1", false},
		{strict, "::1", false},
		{strict, "64:ff9b::a9fe:a9fe", false},
		{strict, "2002:7f00:1::", false},
		{strict, "2001:0:4136:e378:8000:63bf:80ff:fffe", false}, // Teredo client 127.0.0.1
		{strict, "2001:0:4136:e378:8000:63bf:a247:27dd", true},  // Teredo, public both ends
		{strict, "198.18.0.1", false},
		{strict, "168.63.129.16", false},
		{dev, "127.0.0.1", true},
		{dev, "198.18.0.1", true},
		{dev, "169.254.169.254", false},
		{dev, "192.0.0.8", false},
	}
	for _, tc := range cases {
		if got := tc.p.allowed(net.ParseIP(tc.ip)); got != tc.want {
			t.Errorf("%+v allowed(%s) = %v, want %v", tc.p, tc.ip, got, tc.want)
		}
	}
}

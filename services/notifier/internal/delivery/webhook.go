package delivery

import (
	"bytes"
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"go.uber.org/zap"
)

// WebhookDeliverer delivers notifications via HTTP POST with HMAC signature.
type WebhookDeliverer struct {
	client      *http.Client
	policy      dialPolicy
	signingRoot []byte
	logger      *zap.Logger
}

// devWebhookSigningKey is the well-known dev root; refused in prod.
const devWebhookSigningKey = "dev-notifier-signing-key-do-not-use-in-production"

// webhookSigningRoot reads PAL_NOTIFIER_SIGNING_KEY. Prod requires it (at
// least 32 bytes); dev falls back to a well-known key so local runs work.
func webhookSigningRoot() ([]byte, error) {
	root := os.Getenv("PAL_NOTIFIER_SIGNING_KEY")
	if IsProd() {
		if len(root) < 32 {
			return nil, errors.New("PAL_NOTIFIER_SIGNING_KEY must be set (>= 32 bytes) in production: webhook signatures would be forgeable")
		}
		return []byte(root), nil
	}
	if root == "" {
		root = devWebhookSigningKey
	}
	return []byte(root), nil
}

// NewWebhookDeliverer creates a new WebhookDeliverer. It fails in prod
// without PAL_NOTIFIER_SIGNING_KEY.
func NewWebhookDeliverer(logger *zap.Logger) (*WebhookDeliverer, error) {
	root, err := webhookSigningRoot()
	if err != nil {
		return nil, err
	}
	p := deliveryDialPolicy()
	return &WebhookDeliverer{
		client:      p.newHTTPClient(30 * time.Second),
		policy:      p,
		signingRoot: root,
		logger:      logger.Named("webhook"),
	}, nil
}

// WebhookSigningKey is the per-tenant webhook key a receiver verifies with:
// HKDF-SHA256(secret = PAL_NOTIFIER_SIGNING_KEY, salt = none,
// info = "pal-notifier-webhook-v1|" + tenantID), 32 bytes. Deterministic, so
// no per-tenant secret is stored; a tenant cannot derive another tenant's key.
func WebhookSigningKey(root []byte, tenantID string) ([]byte, error) {
	return hkdf.Key(sha256.New, root, nil, "pal-notifier-webhook-v1|"+tenantID, 32)
}

// SignWebhook returns the X-Pal-Signature value for body sent at ts:
// "t=<unix seconds>,v1=<hex HMAC-SHA256(key, "<t>.<body>")>". The timestamp
// is signed so a receiver can reject replays outside its tolerance (the
// platform uses ±5 min for its own inbound generic hooks, same format).
func SignWebhook(key, body []byte, ts time.Time) string {
	t := strconv.FormatInt(ts.Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(t + "."))
	mac.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Channel returns the channel type.
func (w *WebhookDeliverer) Channel() Channel {
	return ChannelWebhook
}

// webhookPayload is the JSON payload sent to webhook endpoints.
type webhookPayload struct {
	ID             string `json:"id"`
	TenantID       string `json:"tenant_id"`
	RunID          string `json:"run_id,omitempty"`
	Subject        string `json:"subject,omitempty"`
	Body           string `json:"body"`
	Timestamp      string `json:"timestamp"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

// Deliver sends the notification to the webhook URL (stored in Recipient).
func (w *WebhookDeliverer) Deliver(ctx context.Context, n *Notification) (*DeliveryResult, error) {
	ctx, span := tracer.Start(ctx, "WebhookDeliverer.Deliver")
	defer span.End()

	payload := webhookPayload{
		ID:             n.ID,
		TenantID:       n.TenantID,
		RunID:          n.RunID,
		Subject:        n.Subject,
		Body:           n.Body,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
		IdempotencyKey: n.IdempotencyKey,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal webhook payload: %w", err)
	}

	// SSRF: the URL is tenant input. Refuse it statically here; every dialled
	// address is checked again by the client (DNS rebinding).
	if err := w.policy.checkURL(n.Recipient); err != nil {
		return &DeliveryResult{Success: false, ErrorMessage: err.Error(), AttemptedAt: time.Now()}, nil
	}

	key, err := WebhookSigningKey(w.signingRoot, n.TenantID)
	if err != nil {
		return nil, fmt.Errorf("derive webhook signing key: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.Recipient, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create webhook request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "PAL-Notifier/1.0")
	setPalHeader(req.Header, "Signature", SignWebhook(key, body, time.Now()))
	setPalHeader(req.Header, "Delivery-ID", n.ID)

	if n.IdempotencyKey != "" {
		setPalHeader(req.Header, "Idempotency-Key", n.IdempotencyKey)
	}

	resp, err := w.client.Do(req)
	if err != nil {
		w.logger.Error("webhook delivery failed",
			zap.String("url", n.Recipient),
			zap.Error(err),
		)
		return &DeliveryResult{
			Success:      false,
			ErrorMessage: err.Error(),
			AttemptedAt:  time.Now(),
		}, nil
	}
	defer resp.Body.Close()

	// Read and discard body to allow connection reuse.
	_, _ = io.Copy(io.Discard, resp.Body)

	success := resp.StatusCode >= 200 && resp.StatusCode < 300
	result := &DeliveryResult{
		Success:     success,
		StatusCode:  resp.StatusCode,
		AttemptedAt: time.Now(),
	}

	if !success {
		result.ErrorMessage = fmt.Sprintf("webhook returned HTTP %d", resp.StatusCode)
		w.logger.Warn("webhook returned non-2xx",
			zap.String("url", n.Recipient),
			zap.Int("status", resp.StatusCode),
		)
	}

	return result, nil
}

// setPalHeader sets the X-Pal-<name> header.
func setPalHeader(h http.Header, name, v string) {
	h.Set("X-Pal-"+name, v)
}

package handlers

// A held reply must be delivered at most once. ActOnDraft claims the draft with a
// single `UPDATE … WHERE status='pending' RETURNING`; these tests prove a second
// (or concurrent) act gets 404 and never reaches the bridge. DB-backed through the
// RLS-enforced harness; skipped when DATABASE_URL is unset.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

type delivery struct{ channel, jid, message string }

// stubDelivery replaces the bridge seam and records every delivery attempt.
func stubDelivery(t *testing.T) (*[]delivery, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	var got []delivery
	orig := deliverDraft
	deliverDraft = func(channel, _ string, jid, message string) error {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, delivery{channel, jid, message})
		return nil
	}
	t.Cleanup(func() { deliverDraft = orig })
	return &got, &mu
}

func seedDraft(t *testing.T, e *enforcedServer, tenant, draftText string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := e.superPool.Exec(context.Background(),
		`INSERT INTO whatsapp_pending_drafts (id, tenant_id, jid, display_name, inbound_text, draft_text, channel)
		 VALUES ($1, $2, 'draft-act-test@invalid', 'Act Test', 'hi', $3, 'whatsapp')`,
		id, tenant, draftText); err != nil {
		t.Fatalf("seed draft: %v", err)
	}
	return id
}

func actOnDraft(t *testing.T, h *WhatsAppPersonalHandler, tenant, id string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	tok := mintTestToken(t, tenant, "user-x", "owner")
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/whatsapp/drafts/"+id+"/act", bytes.NewReader(b))
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.ActOnDraft(rr, req)
	return rr
}

func TestActOnDraft_SecondActIs404AndDoesNotDeliver(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)
	got, mu := stubDelivery(t)
	tenant := seedEnforcedTenant(t, e, "draft-act-"+uuid.NewString()[:8])
	id := seedDraft(t, e, tenant, "on my way")

	if rr := actOnDraft(t, h, tenant, id, map[string]any{"action": "approve"}); rr.Code != http.StatusOK {
		t.Fatalf("first approve: %d %s", rr.Code, rr.Body.String())
	}
	for _, body := range []map[string]any{{"action": "approve"}, {"action": "edit", "finalText": "other"}, {"action": "discard"}} {
		if rr := actOnDraft(t, h, tenant, id, body); rr.Code != http.StatusNotFound {
			t.Fatalf("repeat %v: got %d, want 404; %s", body["action"], rr.Code, rr.Body.String())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 1 || (*got)[0].message != "on my way" {
		t.Fatalf("deliveries = %+v, want exactly one with the stored draft text", *got)
	}
}

func TestActOnDraft_ConcurrentActsDeliverOnce(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)
	got, mu := stubDelivery(t)
	tenant := seedEnforcedTenant(t, e, "draft-race-"+uuid.NewString()[:8])
	id := seedDraft(t, e, tenant, "race me")

	const n = 8
	var ok, notFound atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			switch actOnDraft(t, h, tenant, id, map[string]any{"action": "approve"}).Code {
			case http.StatusOK:
				ok.Add(1)
			case http.StatusNotFound:
				notFound.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if ok.Load() != 1 || notFound.Load() != n-1 || len(*got) != 1 {
		t.Fatalf("ok=%d notFound=%d deliveries=%d, want 1/%d/1", ok.Load(), notFound.Load(), len(*got), n-1)
	}
}

func TestActOnDraft_InvalidRequestDoesNotConsumeDraft(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)
	got, mu := stubDelivery(t)
	tenant := seedEnforcedTenant(t, e, "draft-bad-"+uuid.NewString()[:8])
	id := seedDraft(t, e, tenant, "keep me")

	if rr := actOnDraft(t, h, tenant, id, map[string]any{"action": "edit", "finalText": "  "}); rr.Code != http.StatusBadRequest {
		t.Fatalf("blank edit: %d", rr.Code)
	}
	if rr := actOnDraft(t, h, tenant, id, map[string]any{"action": "bogus"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("bogus action: %d", rr.Code)
	}
	// Still pending, so a valid act still works; edit sends the edited text.
	if rr := actOnDraft(t, h, tenant, id, map[string]any{"action": "edit", "finalText": "edited"}); rr.Code != http.StatusOK {
		t.Fatalf("valid edit after bad requests: %d %s", rr.Code, rr.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 1 || (*got)[0].message != "edited" {
		t.Fatalf("deliveries = %+v", *got)
	}
}

func TestActOnDraft_CrossTenantIs404(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedWhatsAppHandler(t, e)
	got, mu := stubDelivery(t)
	a := seedEnforcedTenant(t, e, "draft-a-"+uuid.NewString()[:8])
	b := seedEnforcedTenant(t, e, "draft-b-"+uuid.NewString()[:8])
	id := seedDraft(t, e, a, "private")
	if rr := actOnDraft(t, h, b, id, map[string]any{"action": "approve"}); rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant act: %d", rr.Code)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 0 {
		t.Fatalf("cross-tenant act delivered: %+v", *got)
	}
}

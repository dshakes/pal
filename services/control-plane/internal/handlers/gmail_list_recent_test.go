package handlers

// Unit tests for the read-only Gmail `list_recent` action added for the
// life-event email poller. These exercise the validation branches that do NOT
// require a live Gmail API call (no OAuth token, unknown-action message) — the
// happy path requires a real access token and is covered by the bridge-side
// poller tests with a mocked connector.

import (
	"strings"
	"testing"
)

// list_recent without an OAuth access token must fail closed with a clear
// re-auth hint — the poller relies on this string to detect the expired/missing
// token case and surface a single "re-auth Google" warning.
func TestExecuteGmail_ListRecent_RequiresOAuth(t *testing.T) {
	cfg := map[string]any{} // no accessToken, no email/appPassword
	_, err := executeGmail(cfg, "list_recent", map[string]any{"query": "newer_than:1d"})
	if err == nil {
		t.Fatal("expected an error when no OAuth token is configured")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "oauth access token") {
		t.Fatalf("error should mention the missing OAuth token, got: %v", err)
	}
}

// The unknown-action error message must advertise list_recent so the action is
// discoverable.
func TestExecuteGmail_UnknownAction_ListsListRecent(t *testing.T) {
	cfg := map[string]any{"accessToken": "x"}
	_, err := executeGmail(cfg, "definitely_not_an_action", nil)
	if err == nil {
		t.Fatal("expected an error for an unknown action")
	}
	if !strings.Contains(err.Error(), "list_recent") {
		t.Fatalf("unknown-action error should advertise list_recent, got: %v", err)
	}
}

// ListRecentGmailViaAPI must reject an empty token before making any network
// call (fail-closed, no panic).
func TestListRecentGmailViaAPI_EmptyToken(t *testing.T) {
	_, err := ListRecentGmailViaAPI("", "newer_than:1d", 10)
	if err == nil {
		t.Fatal("expected an error for an empty access token")
	}
}

// TestBuildPlainTextMail pins S-10: `to` and `subject` come from LLM tool
// params, so a CR/LF must never reach the header block (Bcc injection).
func TestBuildPlainTextMail(t *testing.T) {
	cases := []struct {
		name, to, subject string
		wantErr           bool
		wantTo            string
	}{
		{"plain", "a@b.test", "hi", false, "To: <a@b.test>\r\n"},
		{"list with display name", `"Ada L" <ada@b.test>, c@d.test`, "hi", false, "To: \"Ada L\" <ada@b.test>, <c@d.test>\r\n"},
		{"crlf bcc in to", "a@b.test\r\nBcc: x@evil.test", "hi", true, ""},
		{"bare lf in to", "a@b.test\nBcc: x@evil.test", "hi", true, ""},
		{"crlf bcc in subject", "a@b.test", "hi\r\nBcc: x@evil.test", true, ""},
		{"bare cr in subject", "a@b.test", "hi\rBcc: x@evil.test", true, ""},
		{"garbage address", "not an address", "hi", true, ""},
		{"empty", "", "hi", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, err := buildPlainTextMail(tc.to, tc.subject, "body\r\nBcc: still-body@ok.test")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got message %q", msg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			head, _, _ := strings.Cut(string(msg), "\r\n\r\n")
			if !strings.HasPrefix(string(msg), tc.wantTo) {
				t.Errorf("To header = %q, want prefix %q", msg, tc.wantTo)
			}
			if strings.Contains(head, "Bcc") {
				t.Errorf("Bcc leaked into the header block: %q", head)
			}
		})
	}
	msg, err := buildPlainTextMail("a@b.test", "Résumé", "")
	if err != nil || !strings.Contains(string(msg), "Subject: =?UTF-8?B?") {
		t.Fatalf("non-ASCII subject must be RFC 2047 encoded: %q, %v", msg, err)
	}
}

// The send action refuses an injected recipient before any network call.
func TestExecuteGmail_SendRejectsHeaderInjection(t *testing.T) {
	_, err := executeGmail(map[string]any{"accessToken": "t"}, "send_message",
		map[string]any{"to": "me@b.test\r\nBcc: victim@evil.test", "subject": "s", "body": "b"})
	if err == nil || !strings.Contains(err.Error(), "CR or LF") {
		t.Fatalf("err = %v, want CR/LF rejection", err)
	}
}

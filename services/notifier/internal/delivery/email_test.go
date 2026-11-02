package delivery

import (
	"context"
	"strings"
	"testing"

	"go.uber.org/zap"
)

// TestSMTPMessage_RefusesHeaderInjection: recipient and subject come from the
// notification request; a CR/LF must never reach the header block.
func TestSMTPMessage_RefusesHeaderInjection(t *testing.T) {
	cases := []struct {
		name, rcpt, subject string
		wantErr             bool
	}{
		{"plain", "a@b.test", "hi", false},
		{"display name", `"Ada L" <ada@b.test>`, "hi", false},
		{"crlf bcc in recipient", "a@b.test\r\nBcc: x@evil.test", "hi", true},
		{"lf in recipient", "a@b.test\nBcc: x@evil.test", "hi", true},
		{"crlf bcc in subject", "a@b.test", "hi\r\nBcc: x@evil.test", true},
		{"cr in subject", "a@b.test", "hi\rBcc: x@evil.test", true},
		{"two recipients", "a@b.test, c@d.test", "hi", true},
		{"not an address", "nope", "hi", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rcpt, msg, err := smtpMessage("PAL <noreply@pal.test>", tc.rcpt, tc.subject, "body\r\nBcc: still-body@ok.test")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %q", msg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			head, _, _ := strings.Cut(string(msg), "\r\n\r\n")
			if strings.Contains(head, "Bcc") || strings.Contains(rcpt, "\n") {
				t.Fatalf("injection reached the headers: %q", head)
			}
		})
	}
	_, msg, err := smtpMessage("noreply@pal.test", "a@b.test", "Résumé", "")
	if err != nil || !strings.Contains(string(msg), "Subject: =?utf-8?b?") {
		t.Fatalf("non-ASCII subject must be RFC 2047 encoded: %q %v", msg, err)
	}
}

// The deliverer refuses before dialing SMTP (no server needed).
func TestEmailDeliverer_SMTPRefusesInjection(t *testing.T) {
	e := &EmailDeliverer{smtpHost: "127.0.0.1", smtpPort: "1", fromAddr: "noreply@pal.test", logger: zap.NewNop()}
	res, err := e.deliverViaSMTP(context.Background(), &Notification{Recipient: "a@b.test\r\nBcc: x@evil.test", Subject: "s", Body: "b"})
	if err != nil || res.Success || !strings.Contains(res.ErrorMessage, "CR or LF") {
		t.Fatalf("got %+v, %v; want refusal before dial", res, err)
	}
}

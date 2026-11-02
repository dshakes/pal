package middleware

import (
	"net/http/httptest"
	"testing"
)

func TestResolveTenantHTTP(t *testing.T) {
	const tok = "svc-token"
	cases := []struct {
		name, expected, presented, tenant, auth string
		wantTenant                              string
	}{
		{"service token + tenant", tok, tok, "t1", "", "t1"},
		{"wrong token", tok, "nope", "t1", "", ""},
		{"no token", tok, "", "t1", "", ""},
		{"no tenant header", tok, tok, "", "", ""},
		{"REST disabled when no token configured", "", "", "t1", "", ""},
		// A user JWT is never accepted, whatever it claims.
		{"bearer JWT only", tok, "", "t1", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJ0MSJ9.sig", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/v1/runtime/schedule", nil)
			if tc.presented != "" {
				r.Header.Set(ServiceTokenMetadataKey, tc.presented)
			}
			if tc.tenant != "" {
				r.Header.Set(TenantHeader, tc.tenant)
			}
			if tc.auth != "" {
				r.Header.Set("Authorization", tc.auth)
			}
			got, err := ResolveTenantHTTP(r, tc.expected)
			if tc.wantTenant == "" {
				if err == nil {
					t.Fatalf("accepted, tenant %q", got)
				}
				return
			}
			if err != nil || got != tc.wantTenant {
				t.Fatalf("got %q, %v; want %q", got, err, tc.wantTenant)
			}
		})
	}
}

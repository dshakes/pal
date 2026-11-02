package middleware

import (
	"context"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// tenant_id reaches queries and the app.tenant_id GUC, so only a UUID passes.
func TestExtractTenant_RequiresUUID(t *testing.T) {
	cases := []struct {
		tenant string
		want   codes.Code
	}{
		{"00000000-0000-0000-0000-000000000001", codes.OK},
		{"A1B2C3D4-0000-4000-8000-00000000000F", codes.OK},
		{"x'; CREATE TABLE pwned(); --", codes.InvalidArgument},
		{"00000000-0000-0000-0000-000000000001'; SELECT 1; --", codes.InvalidArgument},
		{"t1", codes.InvalidArgument},
		{"", codes.Unauthenticated},
	}
	for _, tc := range cases {
		ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("tenant_id", tc.tenant))
		out, err := extractTenant(ctx, zap.NewNop(), "/pal.v1.Svc/Method")
		if got := status.Code(err); got != tc.want {
			t.Errorf("tenant %q: code %v, want %v", tc.tenant, got, tc.want)
			continue
		}
		if tc.want == codes.OK {
			if v, _ := out.Value(tenantIDKey{}).(string); v != tc.tenant {
				t.Errorf("tenant %q not injected (got %q)", tc.tenant, v)
			}
		}
	}
}

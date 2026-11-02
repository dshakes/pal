module github.com/dshakes/pal/services/data-plane-agent

go 1.26.0

toolchain go1.26.10

require (
	github.com/dshakes/pal/gen/go v0.0.0
	go.opentelemetry.io/otel v1.44.0
	go.opentelemetry.io/otel/trace v1.44.0 // indirect
	go.uber.org/zap v1.27.0
	google.golang.org/grpc v1.83.2
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dshakes/pal/packages/grpctls v0.0.0
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel/metric v1.44.0 // indirect
	go.uber.org/multierr v1.10.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
)

replace github.com/dshakes/pal/gen/go => ../../gen/go

replace github.com/dshakes/pal/packages/grpctls => ../../packages/grpctls

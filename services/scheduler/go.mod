module github.com/dshakes/pal/services/scheduler

go 1.26.0

toolchain go1.26.10

require (
	github.com/dshakes/pal/gen/go v0.0.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/redis/go-redis/v9 v9.23.0
	go.opentelemetry.io/otel v1.45.0
	go.uber.org/zap v1.28.0
	google.golang.org/grpc v1.85.0
	google.golang.org/protobuf v1.36.12
)

require go.uber.org/atomic v1.12.0 // indirect

replace github.com/dshakes/pal/gen/go => ../../gen/go

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dshakes/pal/packages/grpctls v0.0.0
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel/metric v1.45.0 // indirect
	go.opentelemetry.io/otel/trace v1.45.0 // indirect
	go.uber.org/multierr v1.10.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260817212433-ac3dfec99bb1 // indirect
)

replace github.com/dshakes/pal/packages/grpctls => ../../packages/grpctls

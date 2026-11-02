module github.com/dshakes/pal/packages/cli

go 1.26.0

toolchain go1.26.10

require (
	github.com/dshakes/pal/gen/go v0.0.0
	github.com/spf13/cobra v1.10.2
	golang.org/x/term v0.47.0
	google.golang.org/grpc v1.85.0
	google.golang.org/protobuf v1.36.12
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260817212433-ac3dfec99bb1 // indirect
)

replace github.com/dshakes/pal/gen/go => ../../gen/go

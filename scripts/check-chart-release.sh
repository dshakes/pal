#!/usr/bin/env bash
# Release gate: the git tag vX.Y.Z must equal the Helm chart's version AND appVersion,
# because the chart's default image tag is appVersion (images are pushed as vX.Y.Z / X.Y.Z
# by build-images.yml). Usage: scripts/check-chart-release.sh v0.2.1
set -euo pipefail
tag="${1:?usage: $0 vX.Y.Z}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "::error::tag '$tag' is not vX.Y.Z[-pre]"; exit 1; }
want="${tag#v}"
bad=0
for name in pal pal-control-plane pal-data-plane; do
  chart="$(dirname "$0")/../infra/helm/$name/Chart.yaml"
  ver="$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$chart")"
  app="$(sed -n 's/^appVersion: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$chart")"
  [[ "$ver" == "$want" && "$app" == "$want" ]] || {
    echo "::error file=infra/helm/$name/Chart.yaml::tag $tag needs version/appVersion $want (found version=$ver appVersion=$app)"; bad=1; }
done
[[ $bad == 0 ]] || exit 1
echo "chart version/appVersion $want match tag $tag (pal, pal-control-plane, pal-data-plane)"

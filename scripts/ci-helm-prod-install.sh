#!/usr/bin/env bash
# Second helm install for CI: PAL_ENV=production with EVERY prod startup guard live, proving the
# chart's prod path boots (the dev-mode install in the same job skips them). Needs a cluster with
# cert-manager and the pal/{control-plane,runtime-scheduler}:ci images loaded.
# Dummy-but-valid secrets are generated per run; nothing is committed.
set -euo pipefail
CHART="${CHART:-infra/helm/pal}"; NS="${NS:-prodcheck}"; REL="${REL:-palp}"
rnd() { openssl rand -hex 16; }
pw="$(rnd)"; apw="$(rnd)"
helm install "$REL" "$CHART" -n "$NS" --create-namespace \
  -f "$CHART/values-prod.yaml" -f "$CHART/values-ci-prod.yaml" \
  --set "secrets.jwtSecret=$(rnd)$(rnd)" --set "secrets.credentialKey=$(openssl rand -base64 32)" \
  --set "secrets.receiptSecret=$(rnd)" --set "secrets.callbackSigningSecret=$(rnd)" \
  --set "secrets.grpcServiceToken=$(rnd)" --set "secrets.schedulerNodeToken=$(rnd)" \
  --set "secrets.appDbPassword=$apw" \
  --set "secrets.postgresPassword=$pw" --set "secrets.minioPassword=$pw"
# pal_app is created by the control-plane's first migration; its password is operator-set
# (docs/runbooks/rls-cutover.md). The first boot therefore fails the pal_app ping until this runs.
kubectl -n "$NS" rollout status "sts/$REL-postgresql" --timeout=300s
for _ in $(seq 90); do
  kubectl -n "$NS" exec "sts/$REL-postgresql" -- psql -U pal -d pal -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='pal_app'" 2>/dev/null | grep -q 1 && break
  sleep 5
done
kubectl -n "$NS" exec "sts/$REL-postgresql" -- psql -U pal -d pal -v ON_ERROR_STOP=1 -qc \
  "ALTER ROLE pal_app PASSWORD '$apw'"
# The real proof: the prod control-plane (all guards on, RLS enforced, mTLS) goes Ready.
kubectl -n "$NS" rollout status "deploy/$REL-control-plane" --timeout=300s
kubectl -n "$NS" logs "deploy/$REL-control-plane" | grep -Ei 'PAL_ENV|authz: API-key|listening|rls' | head -5 || true

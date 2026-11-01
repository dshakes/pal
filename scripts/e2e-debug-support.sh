#!/usr/bin/env bash
# Real end-to-end for the debug + support agents (ADR 0059): a fresh control-plane
# on private ports with the llm-replay fixture, driven through the public REST API
# and the `pal` CLI. Proves: a real workflow run fails (connector step), the debug
# agent reads its evidence and returns a grounded report whose proposals change
# NOTHING until a human sends one; a confirmed prompt patch edits only the working
# copy; the regression-case proposal creates a suite whose hermetic replay writes
# an eval_run; spend is metered; another tenant gets 404; the CLI never applies in
# non-interactive mode; the support agent answers from the docs; an escalation
# bundle is signed and never carries the run's input values. No live provider key.
#
#   E2E_DBG_PG_URL=postgres://u:p@127.0.0.1:PORT/db?sslmode=disable \
#   E2E_DBG_PSQL="docker exec -i <pg-container> psql -U pal <db>" scripts/e2e-debug-support.sh
#
# The database must be a throwaway one (the server migrates it).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${E2E_DBG_PG_URL:?throwaway Postgres URL required}"
API_PORT=${E2E_DBG_API_PORT:-18508}
GRPC_PORT=${E2E_DBG_GRPC_PORT:-18509}
LLM_PORT=${E2E_DBG_LLM_PORT:-19508}
METRICS_PORT=${E2E_DBG_METRICS_PORT:-19509}

tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "E2E FAIL: $*" >&2; [ -f "$tmp/server.log" ] && tail -20 "$tmp/server.log" >&2; exit 1; }
ok() { echo "  ok: $*"; }
sql() { if [ -n "${E2E_DBG_PSQL:-}" ]; then echo "$1" | $E2E_DBG_PSQL -tAq; else psql "$E2E_DBG_PG_URL" -tAqc "$1"; fi; }
jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd services/control-plane && go build -o "$tmp/llm-replay" ./cmd/llm-replay && go build -o "$tmp/server" ./cmd/server)
mkdir -p "$tmp/bin"
(cd packages/cli && go build -o "$tmp/bin/pal" ./cmd/pal)

cat >"$tmp/rules.json" <<'JSON'
[
  {"match": "You are PAL's debug agent.", "reply": "{\"summary\":\"The digest run failed at its first data step [trace:RUNID].\",\"rootCause\":\"The GitHub connector step failed before the model ran [ev:2]; the 24h window shows the same failure [stats:24h]. An invented ref [ev:9999] must be stripped.\",\"confidence\":\"medium\",\"citations\":[\"trace:RUNID\",\"stats:24h\",\"ev:9999\"],\"proposals\":[{\"kind\":\"prompt_patch\",\"find\":\"\",\"replace\":\"If a data step fails, say so plainly instead of writing a digest.\",\"title\":\"Handle a failed data step\"},{\"kind\":\"eval_case\",\"expectedBehavior\":\"Reports that the pull request list could not be loaded instead of inventing a digest.\",\"title\":\"Pin this failure as a regression\"},{\"kind\":\"retry\",\"title\":\"Retry once\"},{\"kind\":\"delete_agent\",\"title\":\"nope\"}]}"},
  {"match": "You are PAL's in-product support agent.", "reply": "{\"answer\":\"A connector step fails when that connector is not installed for the workspace; install it under Connectors [doc:build/connectors].\",\"docs\":[\"build/connectors\",\"made/up\"],\"actions\":[{\"kind\":\"open\",\"href\":\"/connectors\",\"label\":\"Open connectors\"},{\"kind\":\"open\",\"href\":\"https://evil.example\"}],\"escalate\":false}"}
]
JSON

start_llm() { "$tmp/llm-replay" -addr "127.0.0.1:$LLM_PORT" -rules "$tmp/rules.json" >>"$tmp/llm.log" 2>&1 & llm_pid=$!; pids+=($llm_pid); }
start_llm
llm="http://127.0.0.1:$LLM_PORT"
env DATABASE_URL="$E2E_DBG_PG_URL" ${E2E_DBG_REDIS_URL:+REDIS_URL="$E2E_DBG_REDIS_URL"} \
  JWT_SECRET=debug-e2e-secret-not-for-prod-0123456789 \
  HTTP_ADDR="127.0.0.1:$API_PORT" LISTEN_ADDR="127.0.0.1:$GRPC_PORT" PAL_METRICS_ADDR="127.0.0.1:$METRICS_PORT" LOG_LEVEL=warn \
  PAL_LLM_BASEURL_OPENAI="$llm" PAL_LLM_BASEURL_ANTHROPIC="$llm" OPENAI_API_KEY=fixture-key \
  "$tmp/server" >"$tmp/server.log" 2>&1 & pids+=($!)
api="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 60); do
  curl -fs "$api/healthz" >/dev/null 2>&1 && break
  kill -0 "${pids[1]}" 2>/dev/null || fail "control-plane exited"
  sleep 1
done

tok=$(curl -fs -X POST "$api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@pal.local","password":"pal"}' | jq_ 'd["token"]')
auth=(-H "Authorization: Bearer $tok" -H 'content-type: application/json')
export HOME="$tmp/home"; mkdir -p "$HOME"
export PATH="$tmp/bin:$PATH" PAL_API_URL="$api"

# 1. A real failing run: the daily-digest workflow, with no GitHub connector installed.
repo="$tmp/repo"; mkdir -p "$repo"
sed 's/^name: daily-digest/name: e2e-digest/' examples/daily-digest/agent.yaml >"$repo/agent.yaml"
(cd "$repo" && PAL_API_KEY="$tok" pal deploy >/dev/null) || fail "deploy"
run=$(curl -fs -X POST "$api/v1/runs" "${auth[@]}" \
  -d '{"agentName":"e2e-digest","input":{"owner":"ada@example.com","repo":"secret-repo-name","channel":"#eng"}}' | jq_ 'd["id"]')
status=""
for _ in $(seq 1 60); do
  status=$(curl -fs "$api/v1/runs/$run" "${auth[@]}" | jq_ 'd.get("status","")')
  case "$status" in failed|succeeded|cancelled) break ;; esac
  sleep 1
done
[ "$status" = failed ] || fail "expected the workflow run to fail, got $status"
nev=$(sql "select count(*) from journal_events where run_id='$run'")
[ "$nev" -ge 2 ] || fail "failed run has no journal ($nev events)"
ok "real workflow run failed ($nev journal events)"
# The fixture's report cites the trace of THIS run: substitute its id and restart the fixture.
sed -i.bak "s/RUNID/$run/g" "$tmp/rules.json" && kill "$llm_pid" && sleep 1 && start_llm
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$LLM_PORT/__requests" && break; sleep 0.5; done

state() { sql "select concat_ws('|', (select concat(system_prompt,'/',model,'/',current_version_id) from agents where name='e2e-digest'), (select count(*) from eval_suites), (select count(*) from runs), (select count(*) from agent_budgets), (select count(*) from agent_promotion_audit))"; }

# 2. Debug agent: grounded report, nothing applied.
before=$(state)
curl -fs -X POST "$api/v1/debug/analyze" "${auth[@]}" -d "{\"kind\":\"run\",\"runId\":\"$run\"}" >"$tmp/report.json" || fail "analyze"
[ "$(state)" = "$before" ] || fail "analyze mutated state"
python3 - "$tmp/report.json" <<'PY' || fail "report checks"
import json, sys
r = json.load(open(sys.argv[1]))
assert r["requiresApproval"] is True and r["grounded"] is True, r
refs = {c["ref"] for c in r["citations"]}
assert any(r.startswith("trace:") for r in refs) and "stats:24h" in refs and "ev:9999" not in refs, refs
assert "ev:9999" not in r["rootCause"], r["rootCause"]
kinds = {p["kind"] for p in r["proposals"]}
# A workflow agent cannot be replayed hermetically, so its regression case is not offered.
assert kinds == {"prompt_patch", "retry"}, kinds
dropped = {d["kind"] for d in r["dropped"]}
assert {"delete_agent", "eval_case"} <= dropped, r["dropped"]
for p in r["proposals"]:
    assert p["action"]["path"] in ("/v1/agents/e2e-digest", "/v1/runs"), p["action"]
PY
ok "grounded report; invented ref, unknown kind and non-replayable eval case dropped; state unchanged"
spent=$(sql "select coalesce(sum(cost_usd),0) > 0 or coalesce(sum(tokens_in),0) > 0 from agent_usage_daily where agent_name='__agentless__'")
[ "$spent" = t ] || fail "debug model call not metered"
ok "debug spend metered under __agentless__"

# 3. A person applies the prompt patch: precondition first, then the exact request.
python3 - "$tmp/report.json" "$tmp" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
for p in r["proposals"]:
    json.dump(p, open(f"{sys.argv[2]}/p_{p['kind']}.json", "w"))
PY
want=$(python3 -c "import json; print(json.load(open('$tmp/p_prompt_patch.json'))['precondition']['expect']['systemPrompt'])")
have=$(curl -fs "$api/v1/agents/e2e-digest" "${auth[@]}" | jq_ 'd.get("systemPrompt","")')
[ "$want" = "$have" ] || fail "precondition should hold right after the analysis"
body=$(python3 -c "import json; print(json.dumps(json.load(open('$tmp/p_prompt_patch.json'))['action']['body']))")
curl -fs -X PATCH "$api/v1/agents/e2e-digest" "${auth[@]}" -d "$body" >/dev/null || fail "apply prompt patch"
sql "select system_prompt from agents where name='e2e-digest'" | grep -q "say so plainly" || fail "prompt patch not applied"
have=$(curl -fs "$api/v1/agents/e2e-digest" "${auth[@]}" | jq_ 'd.get("systemPrompt","")')
[ "$want" != "$have" ] || fail "a re-applied proposal would now be stale and must be refused by clients"
ok "confirmed prompt patch edited the working copy; the proposal is now stale"

# 4. The regression case + hermetic replay, on a tool-loop agent (the replayable kind).
curl -fs -X POST "$api/v1/agents" "${auth[@]}" -d '{"name":"e2e-helper","description":"Answers shipping questions","systemPrompt":"Answer shipping questions in one sentence.","model":"fast"}' >/dev/null || fail "create tool-loop agent"
run2=$(curl -fs -X POST "$api/v1/runs" "${auth[@]}" -d '{"agentName":"e2e-helper","input":{"prompt":"where is order 42?"}}' | jq_ 'd["id"]')
for _ in $(seq 1 60); do
  st=$(curl -fs "$api/v1/runs/$run2" "${auth[@]}" | jq_ 'd.get("status","")')
  case "$st" in failed|succeeded|cancelled) break ;; esac
  sleep 1
done
curl -fs -X POST "$api/v1/debug/analyze" "${auth[@]}" -d "{\"kind\":\"run\",\"runId\":\"$run2\"}" >"$tmp/report2.json" || fail "analyze tool-loop run"
python3 - "$tmp/report2.json" "$tmp" <<'PY' || fail "tool-loop report must offer the regression case"
import json, sys
r = json.load(open(sys.argv[1]))
p = [p for p in r["proposals"] if p["kind"] == "eval_case"]
assert p, r
case = p[0]["action"]["body"]["cases"][0]
assert case["input"] == "where is order 42?", case
json.dump(p[0], open(f"{sys.argv[2]}/p_eval_case.json", "w"))
PY
body=$(python3 -c "import json; print(json.dumps(json.load(open('$tmp/p_eval_case.json'))['action']['body']))")
suite=$(curl -fs -X POST "$api/v1/eval-suites" "${auth[@]}" -d "$body" | jq_ 'd["id"]') || fail "create regression suite"
code=$(curl -s -o "$tmp/eval.json" -w '%{http_code}' -X POST "$api/v1/eval-suites/$suite/run" "${auth[@]}" -d '{}')
case "$code" in 200|422) ;; *) fail "replay: HTTP $code $(cat "$tmp/eval.json")" ;; esac
[ "$(sql "select count(*) from eval_runs where suite_id='$suite' and source='hermetic'")" = 1 ] || fail "replay wrote no hermetic eval_run"
ok "regression case replayed hermetically against the working copy (HTTP $code, passed=$(jq_ 'd.get("passed")' <"$tmp/eval.json"))"

# 5. Tenant isolation.
other=$(curl -fs -X POST "$api/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"intruder@e2e.test","password":"intruder-pass-123","name":"I"}' | jq_ 'd.get("token","")')
[ -n "$other" ] || fail "second tenant signup"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/v1/debug/analyze" -H "Authorization: Bearer $other" -H 'content-type: application/json' -d "{\"kind\":\"run\",\"runId\":\"$run\"}")
[ "$code" = 404 ] || fail "cross-tenant analyze: want 404, got $code"
ok "another tenant gets 404"

# 6. CLI never applies without a terminal.
before=$(state)
PAL_API_KEY="$tok" pal debug run "$run" </dev/null >"$tmp/cli.txt" 2>&1 || fail "pal debug run: $(cat "$tmp/cli.txt")"
grep -q "Handle a failed data step" "$tmp/cli.txt" || fail "CLI output missing the proposal: $(cat "$tmp/cli.txt")"
PAL_API_KEY="$tok" pal debug run "$run" --json </dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin)["requiresApproval"]' || fail "pal debug --json"
[ "$(state)" = "$before" ] || fail "the CLI applied something without a terminal"
ok "pal debug prints proposals and applies nothing non-interactively"

# 7. Support agent + escalation.
curl -fs -X POST "$api/v1/support/ask" "${auth[@]}" -d '{"question":"why did my digest fail at the connector step?"}' >"$tmp/ans.json" || fail "support ask"
python3 - "$tmp/ans.json" <<'PY' || fail "support answer checks"
import json, sys
a = json.load(open(sys.argv[1]))
assert [d["slug"] for d in a["docs"]] == ["build/connectors"], a["docs"]
assert [x["href"] for x in a["actions"]] == ["/connectors"], a["actions"]
assert a["grounded"] is True
PY
ok "support answer cites real docs; invented doc + foreign link dropped"
PAL_API_KEY="$tok" pal support "why did my digest fail?" </dev/null >"$tmp/sup.txt" 2>&1 || fail "pal support: $(cat "$tmp/sup.txt")"
grep -qi "connector" "$tmp/sup.txt" || fail "pal support output: $(cat "$tmp/sup.txt")"
curl -fs -X POST "$api/v1/support/escalations" "${auth[@]}" \
  -d "{\"question\":\"still broken, reach me at ada@example.com\",\"runId\":\"$run\"}" >"$tmp/esc.json" || fail "escalate"
esc=$(jq_ 'd["id"]' <"$tmp/esc.json")
stored=$(sql "select bundle::text from support_escalations where id='$esc'")
for leak in ada@example.com secret-repo-name; do
  echo "$stored" | grep -q "$leak" && fail "escalation bundle leaked $leak"
done
echo "$stored" | grep -q '"inputKeys": \["channel", "owner", "repo"\]' || echo "$stored" | grep -q '"inputKeys":\["channel","owner","repo"\]' || fail "bundle should carry input keys only: $stored"
[ "$(sql "select algorithm from support_escalations where id='$esc'")" != "" ] || fail "escalation not signed"
ok "escalation stored, signed, input values and email absent"

echo "E2E PASS: debug + support agents"

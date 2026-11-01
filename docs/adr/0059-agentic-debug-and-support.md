# ADR 0059 — Agentic post-deployment debugging and support: grounded root cause, proposals a human applies, escalation bundles

Status: accepted (Phase 8 of the agent lifecycle plan)

## Context

Phase 7 (ADR 0056) shows what went wrong: the trace tree, incidents, production evals. Phase 6
(ADR 0054) can undo it: promotion and rollback. Between those sits the work an owner still does
by hand: reading a failing run's journal, comparing the new version with the last good one,
checking the promotion history, deciding on a fix, and finding the endpoint that applies it.
`/v1/assist/explain` summarises one run, but it does not correlate evidence, and it proposes
nothing. Nothing helps a user who has a question rather than a failing run. And nothing hands a
stuck user to a person with the context attached.

The plan sketched a tool-loop "ops agent" that would call real endpoints in a loop and could apply
mutations behind a confirm. This ADR records the narrower design we built, and why.

## Decision

### 1. Evidence first, one model call (not a tool loop)

`POST /v1/debug/analyze {kind: run|incident|eval_case, ...}` reads every relevant source
deterministically, in one `WithTenant` transaction, before it asks the model anything:

- the run row and up to 80 journal events, including `policy_denied`
- the trace summary (ADR 0056)
- the prompt, model and workflow diff between the failing version's frozen snapshot and the last
  good one (ADR 0054 snapshots)
- the promotion audit, environments, failed eval runs, the budget and today's usage, and open
  incidents (for an incident subject, the incident and its timeline)

Each item gets a ref (`ev:12`, `diff:prompt`, `promo:41`, …). The model makes one
`CompleteInternalWithUsage` call, with capability `auto` through the model-router seam, and answers
with JSON. The answer must cite refs. Unknown refs are stripped. A report with no real citation has
`grounded: false` and `low` confidence.

Why no tool loop:

- A loop lets untrusted run content, which may carry a prompt injection, steer which reads happen.
- Reading the bounded evidence set up front is complete and cheap: one model call instead of N.
- It is fully reproducible in tests.

Evidence is redacted (`obs.Redact`, `RedactString`) before the model sees it. The report passes
`redactSecrets`. Workspace text sits inside nonce fences (`fenceUntrusted`).

### 2. Proposals are data; a human applies them through existing endpoints

The model may only pick a proposal kind from a per-subject allowlist (`allowedDebugKinds`), which
is gated on facts the server read. It names parameters, and the **server** builds the request:

| Kind | Gate | Request (existing endpoint) |
| --- | --- | --- |
| rollback | an env whose newest promotion is rollbackable (mirrors `rollbackTx`), or a live incident suggestion | env rollback, or `POST /v1/incidents/{id}/rollback` |
| prompt_patch | agent exists; `find` occurs exactly once (or `""` appends); no secret in result | `PATCH /v1/agents/{name}` (working copy) |
| model_change | capability names only (invariant #6) | `PATCH /v1/agents/{name}` |
| eval_case | the run has an input and the agent is a tool-loop agent (the only kind the hermetic runner replays) | `POST /v1/eval-suites`: the run's input, its recorded tool results as mocks, and a judge rubric |
| budget | the evidence shows a budget block; the new value is above the current one and at most 10x it | `PUT /v1/agents/{name}/budget` (the full current body, one field raised) |
| policy | a policy denial | **no request**: a link to the policy editor |
| retry | the run failed | `POST /v1/runs` with `Idempotency-Key: debug-retry-<runId>` |

`/v1/debug/analyze` performs no write except the usage rollup for its own model call. The
dashboard (`lib/debug.ts`) and the CLI send a proposal only after the person confirms that specific
proposal. They send it with that person's credentials, so each endpoint's scope checks, validation
and audit apply unchanged.

Both clients refuse any request outside `services/testdata/debug_action_allowlist.json`. The Go
builder, the TS executor and the CLI are each tested against that file. Prompt, model and budget
proposals carry a **precondition**: the value the proposal was computed from. The client re-reads
it and refuses with "stale proposal" if it changed, so an approval never overwrites a concurrent
edit.

We do not widen agent policies in one click. A policy change is the one mutation that expands what
an agent can reach, so it stays in the policy editor (ADR 0055), where the person sees and saves the
whole document.

### 3. A fix is gated by evals before it reaches production

Prompt and model proposals edit the **working copy**. Production changes only through
`pal freeze` + `pal promote`, and promotion runs the eval gate (ADR 0054). The `eval_case` proposal
creates a regression suite that captures the failure. `POST /v1/eval-suites/{id}/run` then replays
it hermetically against the working copy, with the tool results the failing run recorded. That is
the replay-against-candidate contract: deterministic tools, live model, the same judge as every
other eval. We did not add a separate `/runs/{id}/replay`, because the hermetic eval runner already
is one, and it writes an `eval_run` row that the promotion gate can use.

### 4. Support agent and escalation

`POST /v1/support/ask` answers from the tenant's agents, recent failed runs and open incidents, and
from an index of every PAL docs page. The index holds each page's own frontmatter and lives in
`support_docs.go`. `TestSupportDocsMatchSite` fails when a page is added or its title or description
drifts. Suggested actions (`debug_run`, `debug_incident`, `open`) must reference ids the agent was
shown and allowlisted dashboard paths. An ungrounded answer suggests escalation.

`POST /v1/support/escalations` builds a bundle from a field **whitelist**, not by redacting a dump:

- Run metadata, the step list (kind, tool, model, tokens, errors) and the journal hash.
- The input's keys and the output's size, never their values.
- Incident fields, failing eval case names, promotions and environments.
- The question and the transcript.

Every free-text field is redacted (secret-shaped values, and the values of secret-named JSON keys
inside text, e.g. `{"password":"…"}` in an error string), stripped of control characters, then
email/phone-masked (`minimizePII`). The bundle carries `"type": "pal.support_escalation.v1"`, is signed
over its canonical JSON with the receipt key (Ed25519, with an HMAC-SHA256 fallback), and the exact
signed bytes are stored verbatim (`signed_payload`) next to the queryable `bundle` JSONB in
`support_escalations` (migration 0044, RLS, append-only for `pal_app`).
`GET /v1/support/escalations/{id}/verify` recomputes the digest over those bytes and checks the
signature, type and tenant. Text containing NUL is rejected with 400.

### 5. Authorization

The debug and support agents read across scope domains: the agent definition (including its system
prompt), its budget, runs, incidents and promotions. So a caller needs `runs:execute` **and**
`agents:read` **and** `budgets:read`. JWT users (not kiosk) hold them. A key needs all three, or a
coarse `admin`/`write` scope that implies them. A `runs:execute`-only key, for example a public
web-chat widget key, gets 403. This check runs inside the handler and is **always** enforced,
independent of `PAL_AUTHZ_ENFORCE`, because route-level scope enforcement is off by default in dev.

Escalations are workspace support records. Opening one needs `settings:write`; listing and
verifying need `settings:read`. A bundle carries run data, so opening an escalation about a run or
incident, or reading a bundle, also needs `runs:read` and `agents:read`. Escalation writes are
rate-limited (`PAL_SUPPORT_ESCALATIONS_PER_HOUR`, default 10), because the rows are append-only.
Kiosk sessions are refused on every route.

### 6. Money and limits

Both agents bound what one call can cost and how often it can happen:

- Evidence is capped at 48 KB in total, and the journal at 24 KB of that. The newest events are kept,
  and an `evidence:truncated` item says what was left out.
- Every free-text item is redacted before it is clipped, so a secret cut in half cannot survive.
- Before the model call:
  - a per-tenant hourly rate limit (`PAL_DEBUG_RATE_PER_HOUR`, default 30, per route; Redis fixed
    window that fails open like the auth limiters);
  - the tenant-wide hard cap, checked with a real estimate of this call (prompt size plus maximum
    output at a deliberately high blended price);
  - the debug agents' own daily cap (`PAL_DEBUG_MAX_USD_PER_DAY`, default 1.00, `off` disables).
    This cap keeps a tenant with only per-agent budgets bounded too.

  The estimate is **reserved** in the usage row before both caps are read, so concurrent calls see
  each other's spend. After the call the reservation is settled to the real cost, or released if
  the call failed.

Spend is recorded under the `__pal_debug__` usage row. That row counts toward the tenant-wide cap, but
not toward the agent being debugged: an agent blocked by its own budget is the common case to debug,
and debugging it must not consume that budget.

### 7. Reviewability of a proposal

- A prompt patch carries an explicit **hunk**: byte offset, removed text, added text, and display
  context. The removed and added text are never clipped. A patch whose `find` + `replace` exceeds
  4000 bytes is not proposed.
- The dashboard and the CLI send a prompt patch only if the hunk shown, applied to the prompt shown,
  is exactly the prompt the PATCH carries. A change the person did not see cannot ride along.
- A budget proposal is preconditioned on **every** field its PUT sends, so a concurrent edit to
  hard-fail, the per-run limit or the tool limits makes it stale instead of reverting it.
- An `eval_case` proposal shows what it creates (the input, the judge rubric and the recorded tool
  results) before it is confirmed.
- A rollback proposal's audit note is fixed text plus the proposal id, never model text.
- Model text is stripped of terminal escapes, control characters and invisible code points on the
  server, and again in the CLI. Invisible code points are format characters (zero-width, bidi
  overrides, Unicode TAG "ASCII smuggling"), private-use characters and noncharacters. A prompt patch
  containing any of them is refused outright on the server, in the dashboard and in the CLI: they
  render as nothing in a review, but a model still reads them.
- Workspace names (agent name, subject) are quoted in the prompt, so a crafted name cannot forge an
  instruction line outside the data fence. `__pal_debug__` is a reserved agent name.
- The CLI's apply question is built from the server-set kind, method and path, not from the model's
  title.
- The escalation signature covers `"pal.support_escalation.v1" 0x00 ‖ canonical bundle`, so it can
  never verify as a receipt or any other object the receipt key signs.
- A working-copy prompt that holds a secret-shaped value is redacted for the model and is never
  offered as a patch.

## Consequences

- Every mutation path is an endpoint that already existed. No proposal can do more than the
  person could do by hand.
- The debug agent explains only what the bounded evidence set shows. A cause outside it (for
  example a provider outage that left no journal trace) produces a low-confidence, ungrounded
  report, by design.
- Escalations are stored and listed. There is no outbound delivery yet: the ids-only WARN log line
  `support escalation opened` is the operator hook. A ticketing or webhook sink is a follow-up.
- Rejected: a tool-loop ops agent that applies confirmed mutations server-side (consent would
  have to be recorded server-side, the very thing ADR 0051 forbids); one-click policy widening;
  a separate replay engine.

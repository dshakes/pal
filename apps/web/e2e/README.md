# Dashboard e2e (Playwright)

Headless Chromium against a private, throwaway stack. Run from `apps/web`:

```bash
npm ci
npx playwright install chromium     # CI: add --with-deps
npm run test:e2e
```

Prereqs: Go, `psql`, and a reachable Postgres + Redis (`make dev-infra` provides both).

## What `global-setup.ts` boots

| Piece | Where |
| --- | --- |
| Postgres DB `pal_e2e_<pid>` | created via `E2E_PG_ADMIN_URL` (REQUIRED, no default; must be a private instance, the shared `:5432` is refused), dropped at the end |
| Redis | on `E2E_REDIS_PORT` (REQUIRED; shared `:6379` is refused), db index `E2E_REDIS_DB` (default 13), flushed before and after so `/auth/*` rate limits (10 sign-ups/IP/hour) never leak between runs |
| llm-replay | `:9412`, rules in `fixtures/llm-rules.json` |
| control-plane | HTTP `:8411`, gRPC `:50411`, metrics `:9411`; `PAL_CORS_ORIGINS` = the dashboard origin (without it every API call fails CORS); `PAL_MAILER=log`; `PAL_LLM_BASEURL_*` -> llm-replay |
| dashboard (`next dev`) | `:3411` with `NEXT_PUBLIC_API_URL` / `PAL_API_URL` -> the control-plane |

Ports: `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_GRPC_PORT`, `E2E_METRICS_PORT`, `E2E_LLM_PORT`. Never use :8080/:3001 or the shared `pal` DB.
Logs, binaries and artifacts go to `$E2E_RUN_DIR` (default `$TMPDIR/pal-e2e-run`) -- deliberately outside `apps/web`, because `next dev` watches the project and a growing log there causes endless rebuilds.
`global-setup.ts` warms each route once; cold `next dev` compiles take tens of seconds.

Reusing a stack (`E2E_REUSE_STACK=1`): global-setup is skipped, so YOU must start the fixture bridge and give the processes these env vars, or approving a held reply would POST to the owner's live bridges on :3100/:3200. `pal-space.spec.ts` aborts unless `GET $BRIDGE_WA_URL/health` reports `version: "fixture"`.
- control-plane: `PAL_BRIDGE_URL=http://127.0.0.1:3412 PAL_IMESSAGE_BRIDGE_URL=http://127.0.0.1:3413 PAL_BRIDGE_TOKEN= PAL_IMESSAGE_BRIDGE_TOKEN=`
- next dev: the same four, plus `NEXT_PUBLIC_PAL_BRIDGE_URL=http://127.0.0.1:3412 NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL=http://127.0.0.1:3413`
- fixture: `startFixtureBridge(3412)` from `e2e/support/fixture-bridge.ts`; nothing may listen on 3413.

Iterating: boot the stack once yourself and run with `E2E_REUSE_STACK=1 npx playwright test <file>` to skip setup/teardown.

## Specs (`specs/`)

- `auth.spec.ts` sign-up lands logged in (dev mode is auto-verified; the verification gate is prod-only); forgot -> reset via the mailer log -> sign in, reset link is single-use
- `onboarding.spec.ts` template gallery -> review step; free-text goal -> key test -> design -> create -> first run succeeded with fixture output
- `settings-danger.spec.ts` delete workspace (typed phrase), then the account is gone
- `pal-space.spec.ts` pal space: Today / Holds (approve, edit, discard stop at a confirm card; failed delivery reported as not delivered) / People & memory / Documents, against a FIXTURE bridge (`support/fixture-bridge.ts`, `E2E_BRIDGE_WA_PORT` 3412; iMessage port 3413 has no listener so that channel is offline). The control-plane and dashboard are pointed at these explicitly, because both default to the owner's live bridges on :3100/:3200
- `observe-debug.spec.ts` slice 5: policy-refused tool -> failed run + span trace; 24 failures -> server-opened SLO-burn incident -> acknowledge/resolve; Reliability SLO status + uPlot charts at desktop and phone width; Debug tab
- `theme.spec.ts` login renders in light and dark; toggle persists
- `enterprise-slots.spec.ts` Settings -> Data protection (DLP CRUD; the server owns regex validity), Audit log, SSO slot, honest Team tab, live A2A card, and the role matrix through the UI (viewer/member are set in the throwaway DB via `support/users.ts setRole`: no members API exists)

Helpers: `support/mail.ts` (`mailLink` reads the control-plane log), `support/users.ts` (`signUp`), `support/env.ts`.

## Kiosk specs

Put them in `kiosk/*.spec.ts` (picked up by the same config). Extra control-plane env goes in `extraEnv` at the top of `global-setup.ts`; extra fixture LLM rules in `fixtures/llm-rules.json` (first matching substring wins, so use unique markers).

## Known app quirks the suite works around

- After sign-up the app lands on `/agents`, not `/onboarding` (the `isAuthenticated` redirect races the explicit `router.replace("/onboarding")`); specs navigate to `/onboarding` themselves.
- Free-text onboarding needs a model key *before* the design step; the spec adds a dummy OpenAI key, which the control-plane tests against llm-replay.

import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/users";

// Dashboard v3 slice 4 on the real control-plane + llm-replay: promotion with its
// gates, the prod approval wall, the global approvals page, and Sandboxes. The
// stub scheduler stands in for microVMs here; the live-VM path is the Lima e2e.

let token = "";
let suiteId = "";
let keyToken = "";
const H = (t = token) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

async function call<T = Record<string, unknown>>(path: string, init?: RequestInit & { as?: string }): Promise<{ status: number; body: T }> {
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { ...H(init?.as ?? token), ...(init?.headers ?? {}) } });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { status: r.status, body: body as T };
}

async function signedIn(page: Page) {
  await page.context().addCookies([{ name: "pal_token", value: token, url: WEB_URL }]);
  await page.addInitScript((t) => localStorage.setItem("pal_token", t), token);
}

test.beforeAll(async () => {
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("v3ship"), password: PASSWORD, name: "Ship User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  token = body.token;
  await call("/v1/settings/llm-providers", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-e2e-dummy-key" }) });
  await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "ship-agent", description: "E2E promotion agent", systemPrompt: "Be brief." }) });
  const suite = await call("/v1/eval-suites", {
    method: "POST",
    body: JSON.stringify({ agentName: "ship-agent", name: "smoke", cases: [{ name: "echoes", input: "E2E-SMOKE one", assert: { contains: "E2E-SMOKE" } }] }),
  });
  suiteId = suite.body.id as string;
  const frozen = await call("/v1/agents/ship-agent/versions", { method: "POST", body: JSON.stringify({ label: "v1" }) });
  expect(frozen.status).toBeLessThan(300);
  // An API key is an agent principal: it may propose, never approve.
  const key = await call("/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "ci", scopes: ["agents:write", "agents:read"] }) });
  keyToken = key.body.rawKey as string;
  expect(keyToken, JSON.stringify(key.body)).toBeTruthy();
});

test("Promote: gates explain a block, prod waits for a human, an API key can't approve, the owner can, rollback works", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/ship-agent?tab=promote");
  const dlg = page.getByRole("dialog");
  const promote = async (env: string, extra?: (d: typeof dlg) => Promise<void>) => {
    await page.getByRole("button", { name: "Promote", exact: true }).click();
    await dlg.getByLabel("Environment").selectOption(env);
    await extra?.(dlg);
  };

  await test.step("sandbox needs no eval evidence", async () => {
    await promote("sandbox");
    await dlg.getByRole("button", { name: "Promote", exact: true }).click();
    await expect(page.getByText("Promoted: v1 is live in sandbox")).toBeVisible();
    await expect(page.getByTestId("env-sandbox")).toContainText("v1");
  });

  await test.step("staging is blocked, and the reason is shown", async () => {
    await promote("staging");
    await dlg.getByRole("button", { name: "Promote", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("no hermetic eval run recorded");
    await page.keyboard.press("Escape");
  });

  await test.step("a passing hermetic eval unblocks staging", async () => {
    const run = await call(`/v1/eval-suites/${suiteId}/run`, { method: "POST", body: JSON.stringify({ branch: "staging" }) });
    expect(run.body.passed, JSON.stringify(run.body)).toBe(true);
    await promote("staging");
    await dlg.getByRole("button", { name: "Promote", exact: true }).click();
    await expect(page.getByText("Promoted: v1 is live in staging")).toBeVisible();
  });

  await test.step("prod says it needs a human, and does not claim to be live", async () => {
    await promote("prod", async (d) => {
      await expect(d.getByRole("note")).toContainText("human owner or admin");
      await d.getByLabel("Canary %").fill("200");
      await expect(d.getByRole("button", { name: "Request promotion" })).toBeDisabled();
      await d.getByLabel("Canary %").fill("20");
    });
    await dlg.getByRole("button", { name: "Request promotion" }).click();
    await expect(page.getByText(/Awaiting approval: v1 is not live in prod/)).toBeVisible();
    await expect(page.getByTestId("env-prod")).toContainText("Nothing deployed");
    await expect(page.getByTestId("env-prod")).toContainText("v1 awaiting approval");
  });

  let promotionId = "";
  await test.step("the global Promotions page lists it", async () => {
    await page.goto("/promotions");
    await expect(page.getByRole("heading", { name: "Pending approvals (1)" })).toBeVisible();
    await expect(page.getByText("ship-agent").first()).toBeVisible();
    const pending = await call<Array<{ id: string }>>("/v1/promotions?status=pending_approval");
    promotionId = pending.body[0].id;
  });

  await test.step("the server (not the UI) refuses an API key's approval", async () => {
    const r = await call(`/v1/promotions/${promotionId}/approve`, { method: "POST", as: keyToken, body: "{}" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("human_approval_required");
  });

  await test.step("the owner approves; prod runs as a 20% canary", async () => {
    await page.goto("/agents/ship-agent?tab=promote");
    await page.getByRole("button", { name: "Approve" }).click();
    // Nothing is deployed in prod yet, so the client can't know whether the server
    // will canary (it needs a different stable version): the dialog must say so.
    await expect(dlg).toContainText("only if prod already serves a different version");
    await dlg.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Promotion approved")).toBeVisible();
    // First prod promotion has no stable baseline to canary against: full rollout.
    await expect(page.getByTestId("env-prod")).toContainText("active");
    await expect(page.getByText("Audit trail")).toBeVisible();
    await expect(page.getByText("promote_requested").first()).toBeVisible();
  });

  await test.step("a second version is a real canary, and rollback aborts it", async () => {
    await call("/v1/agents/ship-agent", { method: "PATCH", body: JSON.stringify({ systemPrompt: "Be brief, v2." }) });
    const v2 = await call("/v1/agents/ship-agent/versions", { method: "POST", body: JSON.stringify({ label: "v2" }) });
    expect(v2.status, JSON.stringify(v2.body)).toBeLessThan(300);
    await call(`/v1/eval-suites/${suiteId}/run`, { method: "POST", body: JSON.stringify({ branch: "staging" }) });
    for (const env of ["sandbox", "staging"]) {
      const r = await call("/v1/agents/ship-agent/promote", { method: "POST", body: JSON.stringify({ env, version: "v2" }) });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    await page.reload();
    await promote("prod", async (d) => {
      await d.getByLabel("Version").fill("v2");
      await d.getByLabel("Canary %").fill("20");
    });
    await dlg.getByRole("button", { name: "Request promotion" }).click();
    await expect(page.getByText(/Awaiting approval: v2 is not live in prod/)).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(dlg).toContainText("Starts a 20% canary of v2 against stable v1");
    await dlg.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("env-prod")).toContainText("canary 20%");

    await page.getByTestId("env-prod").getByRole("button", { name: "Rollback" }).click();
    // the env row holds the STABLE version; the dialog must name the candidate being aborted
    await expect(dlg).toContainText("abort the canary of v2");
    await dlg.getByRole("button", { name: "Roll back" }).click();
    await expect(page.getByText("Canary aborted: prod serves v1 for all traffic.")).toBeVisible();
    await expect(page.getByTestId("env-prod")).not.toContainText("canary");
    // the newest promotion is now rolled_back: a second rollback would be a server no-op, so it isn't offered
    await expect(page.getByTestId("env-prod").getByRole("button", { name: "Rollback" })).toBeDisabled();
  });
});

test("Sandboxes: honest empty state, then a scheduled sandbox opens its detail", async ({ page }) => {
  await signedIn(page);
  await page.goto("/runtime");
  await expect(page.getByText("No sandboxes")).toBeVisible();
  await expect(page.getByText(/demo/i)).toHaveCount(0);

  const sched = await call("/v1/runtime/schedule", {
    method: "POST",
    body: JSON.stringify({ imageDigest: `sha256:${"a".repeat(64)}`, isolation: "firecracker", command: ["echo", "hi"] }),
  });
  expect(sched.status, JSON.stringify(sched.body)).toBeLessThan(300);
  const vmId = (sched.body.vmId ?? sched.body.vm_id) as string;

  await page.reload();
  const table = page.getByRole("table", { name: "Sandboxes" });
  await expect(table.getByText(vmId)).toBeVisible();
  await table.getByText(vmId).click();
  await expect(page).toHaveURL(new RegExp(`/runtime/${vmId}`));
  await expect(page.getByRole("heading", { name: vmId })).toBeVisible();
  await page.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByText("Secret values are redacted by the server.")).toBeVisible();
});

test("Sandbox detail: an unknown id is a 404 state, not a blank page", async ({ page }) => {
  await signedIn(page);
  await page.goto("/runtime/vm-does-not-exist");
  await expect(page.getByText("Sandbox not found")).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/users";

// Dashboard v3 slice 3: the agent lifecycle on the real control-plane +
// llm-replay — Evals (run → pin baseline → regression), drafting a suite, Gate,
// and Design (spec save + policy gap).

let token = "";
const H = () => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { ...H(), ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function signedIn(page: Page) {
  await page.context().addCookies([{ name: "pal_token", value: token, url: WEB_URL }]);
  await page.addInitScript((t) => localStorage.setItem("pal_token", t), token);
}

const smoke = (extra: object[] = []) =>
  JSON.stringify({
    agentName: "eval-agent",
    name: "smoke",
    cases: [{ name: "echoes-input", input: "E2E-SMOKE one", assert: { contains: "E2E-SMOKE" } }, ...extra],
  });

test.beforeAll(async () => {
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("v3life"), password: PASSWORD, name: "Lifecycle User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  token = body.token;
  await api("/v1/settings/llm-providers", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-e2e-dummy-key" }) });
  await api("/v1/agents", { method: "POST", body: JSON.stringify({ name: "eval-agent", description: "E2E eval agent", systemPrompt: "Be brief." }) });
  for (const m of ["E2E-SMOKE a", "E2E-SMOKE b"]) await api("/v1/runs", { method: "POST", body: JSON.stringify({ agentName: "eval-agent", input: { message: m } }) });
  await api("/v1/eval-suites", { method: "POST", body: smoke() });
  // An agent whose workflow calls a tool its (default, enforcing) policy doesn't allow.
  await api("/v1/agents", { method: "POST", body: JSON.stringify({ name: "tool-agent", description: "Calls web_search", systemPrompt: "Be brief." }) });
  await api("/v1/agents/tool-agent/workflow", {
    method: "PUT",
    body: JSON.stringify({
      nodes: [
        { id: "start", type: "trigger", data: { label: "Start" } },
        { id: "fetch", type: "tool", data: { label: "Fetch", tool: "web_search" } },
        { id: "end", type: "end", data: {} },
      ],
      edges: [{ id: "e1", source: "start", target: "fetch" }, { id: "e2", source: "fetch", target: "end" }],
    }),
  });
});

test("Evals: run a suite, pin the baseline, then a worse run is called a regression — and Gate agrees", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/eval-agent?tab=evals");
  const suites = page.getByRole("table", { name: "Eval suites" });
  await suites.getByRole("row").filter({ hasText: "smoke" }).getByRole("button", { name: "Run" }).click();
  const result = page.getByRole("dialog");
  await expect(result).toContainText("smoke: 100%", { timeout: 30_000 });
  await result.getByRole("button", { name: /close/i }).first().click();

  const runs = page.getByRole("table", { name: "Eval runs" });
  await runs.getByRole("button", { name: "Pin as baseline" }).first().click();
  await expect(runs.getByText("baseline", { exact: true })).toBeVisible();

  // Same suite, one more case the agent can't pass → score drops below the baseline.
  await api("/v1/eval-suites", { method: "POST", body: smoke([{ name: "impossible", input: "E2E-SMOKE two", assert: { contains: "NEVER-IN-OUTPUT" } }]) });
  await page.reload();
  await suites.getByRole("row").filter({ hasText: "smoke" }).getByRole("button", { name: "Run" }).click();
  await expect(page.getByRole("dialog")).toContainText("Regressed against the pinned baseline", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(runs.getByText("Regressed").first()).toBeVisible();

  await page.getByRole("tab", { name: /Gate/ }).click();
  await expect(page.getByText("Evals regressed")).toBeVisible();
});

test("Evals: draft a suite from real runs, review it, save it", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/eval-agent?tab=evals");
  await page.getByRole("button", { name: "Draft a suite from runs" }).click();
  const dlg = page.getByRole("dialog");
  // E2E-EVAL-GOAL is matched by the replay rule in e2e/fixtures/llm-rules.json,
  // which answers with the "e2e-drafted" suite (cases core-job + no-shouting).
  await dlg.getByLabel(/What should the suite check/).fill("E2E-EVAL-GOAL summaries stay short");
  await dlg.getByRole("button", { name: "Draft cases" }).click();
  await expect(dlg.getByText("core-job")).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toContainText("Nothing is saved until you approve");
  await dlg.getByRole("button", { name: /Save 2 cases/ }).click();
  await expect(page.getByRole("table", { name: "Eval suites" }).getByText("e2e-drafted")).toBeVisible();
});

test("Design: warns when the policy will refuse a workflow step, and saves the spec", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/tool-agent?tab=design");
  const alert = page.getByRole("alert").filter({ hasText: "The policy will refuse" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("web_search");

  await page.getByLabel(/Instructions/).fill("Answer in one line (edited in e2e).");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Design saved")).toBeVisible();
  const a = await api<{ systemPrompt: string }>("/v1/agents/tool-agent");
  expect(a.systemPrompt).toBe("Answer in one line (edited in e2e).");
});

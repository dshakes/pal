import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/users";

// Dashboard v3 slice 5: Observe + Debug on the real control-plane + llm-replay.
// A run whose tool the agent's policy refuses -> a failed run with a trace, 20 of
// them -> a server-opened SLO-burn incident -> acknowledge / resolve; the SLO
// page with its uPlot charts at desktop and phone width; the Debug tab.

let token = "";
let failedRun = "";
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

async function settle(id: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const r = await api<{ status: string }>(`/v1/runs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(r.status)) return r.status;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`run ${id} never settled`);
}

const toolWorkflow = {
  nodes: [
    { id: "start", type: "trigger", data: { label: "Start" } },
    { id: "fetch", type: "tool", data: { label: "Fetch", tool: "web_search" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [{ id: "e1", source: "start", target: "fetch" }, { id: "e2", source: "fetch", target: "end" }],
};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("v3obs"), password: PASSWORD, name: "Observe User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  token = body.token;
  await api("/v1/settings/llm-providers", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-e2e-dummy-key" }) });
  await api("/v1/agents", { method: "POST", body: JSON.stringify({ name: "obs-agent", description: "E2E observe agent", systemPrompt: "Be brief." }) });
  await api("/v1/agents/obs-agent/workflow", { method: "PUT", body: JSON.stringify(toolWorkflow) });
  await api("/v1/agents/obs-agent/slo", { method: "PUT", body: JSON.stringify({ objective: 0.9, windowDays: 28 }) });
  // 24 runs whose only tool the (default-deny) policy refuses: all fail, which burns the success SLO.
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const run = await api<{ id: string }>("/v1/runs", { method: "POST", body: JSON.stringify({ agentName: "obs-agent", input: { message: `E2E-OBS ${i}` } }) });
    ids.push(run.id);
  }
  const statuses = await Promise.all(ids.map(settle));
  failedRun = ids[statuses.indexOf("failed")] ?? "";
  if (!failedRun) throw new Error(`expected failed runs, got ${statuses.join(",")}`);
  await api("/v1/incidents/scan", { method: "POST" });
});

test("Run detail: the span trace shows the step the policy refused", async ({ page }) => {
  await signedIn(page);
  await page.goto(`/runs/${failedRun}`);
  const trace = page.getByRole("region", { name: "Run trace" });
  await expect(trace).toBeVisible({ timeout: 30_000 });
  await trace.getByRole("button", { name: /fetch/i }).first().click();
  await expect(trace.getByTestId("step-detail").first()).toBeVisible();
});

test("Incidents: the server-opened SLO burn shows up, can be acknowledged, then resolved", async ({ page }) => {
  await signedIn(page);
  await page.goto("/incidents");
  const row = page.locator('a[href^="/incidents/"]').filter({ hasText: "obs-agent" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByRole("region", { name: "Summary" })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByText("acknowledged").first()).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("resolved").first()).toBeVisible();
});

for (const [label, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`Reliability: SLO status from the server and charts that fit (${label})`, async ({ page }) => {
    await page.setViewportSize(size);
    await signedIn(page);
    await page.goto("/agents/obs-agent/reliability");
    const success = page.getByTestId("sli-success");
    await expect(success).toBeVisible({ timeout: 30_000 });
    // 24 failures against a 90% objective: the server fired a burn alert and the budget is spent.
    await expect(success).toContainText(/page|ticket/);
    await expect(success).toContainText("exhausted");
    const chart = page.getByTestId("time-series").first();
    await expect(chart.locator("canvas")).toBeVisible({ timeout: 15_000 });
    const [box, canvas] = await Promise.all([chart.boundingBox(), chart.locator("canvas").boundingBox()]);
    expect(canvas!.width).toBeGreaterThan(100);
    expect(canvas!.width).toBeLessThanOrEqual(box!.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}

test("Reliability: a decimal can be typed and a bad value is refused with the server's own rule", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/obs-agent/reliability");
  const objective = page.getByLabel("Objective (0 to 1)");
  await expect(objective).toBeVisible({ timeout: 30_000 });
  await objective.fill("");
  await objective.pressSequentially("0.85");
  await expect(objective).toHaveValue("0.85");
  await objective.fill("1");
  await page.getByRole("button", { name: "Update SLO" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "objective must be between 0 and 1" })).toBeVisible();
});

test("Debug tab: lists the failed run with its trace link and a debug action", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/obs-agent?tab=debug");
  await expect(page.getByRole("heading", { name: "Failed runs" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Debug this run" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open trace" }).first()).toBeVisible();
});

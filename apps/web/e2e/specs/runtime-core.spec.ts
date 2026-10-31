import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/users";

// Dashboard v3 slice 2: Runs list, run detail with the SSE trace, and the
// agent lifecycle rail — all against the real control-plane + llm-replay.

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

let runId = "";

test.beforeAll(async () => {
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("v3core"), password: PASSWORD, name: "Core User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  token = body.token;
  // llm-replay stands in for the provider, so a dummy key is enough.
  await api("/v1/settings/llm-providers", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "sk-e2e-dummy-key" }) });
  await api("/v1/agents", { method: "POST", body: JSON.stringify({ name: "core-agent", description: "E2E agent for the runtime core", systemPrompt: "Be brief." }) });
  const run = await api<{ id: string }>("/v1/runs", { method: "POST", body: JSON.stringify({ agentName: "core-agent", input: { message: "hello core" } }) });
  runId = run.id;
  for (let i = 0; i < 30; i++) {
    const got = await api<{ status: string }>(`/v1/runs/${runId}`);
    if (got.status === "succeeded" || got.status === "failed") break;
    await new Promise((res) => setTimeout(res, 500));
  }
});

test("runs list shows the real run and filters by status", async ({ page }) => {
  await signedIn(page);
  await page.goto("/runs");
  const table = page.getByRole("table", { name: "Runs" });
  await expect(table.getByRole("row").filter({ hasText: "core-agent" }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Failed" }).click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByText("No runs match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await table.getByRole("row").filter({ hasText: "core-agent" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}`));
});

test("run detail streams the step trace and shows the output", async ({ page }) => {
  await signedIn(page);
  await page.goto(`/runs/${runId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Run of core-agent/ })).toBeVisible();
  // Events arrive over SSE (named frames); a non-zero count proves the stream parsed.
  await expect(page.locator("#trace-h")).toContainText(/[1-9]\d* events/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Output" })).toBeVisible();
  await expect(page.getByText(/fixture:/).first()).toBeVisible();
});

test("agent page: lifecycle rail tabs are linkable and keyboard-navigable", async ({ page }) => {
  await signedIn(page);
  await page.goto("/agents/core-agent?tab=runs"); // legacy tab name → Observe
  const rail = page.getByRole("tablist", { name: "Agent lifecycle" });
  await expect(rail.getByRole("tab", { name: /Observe/ })).toHaveAttribute("aria-selected", "true");

  await rail.getByRole("tab", { name: /Evals/ }).click();
  await expect(page).toHaveURL(/tab=evals/);
  await expect(page.getByText("No eval suites yet")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(rail.getByRole("tab", { name: /Gate/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No eval results")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(rail.getByRole("tab", { name: /Promote/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: /Agent environments/ })).toBeVisible();
});

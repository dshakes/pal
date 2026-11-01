import { expect, test, type Page } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { PASSWORD, setRole, uniqueEmail, type DbRole } from "../support/users";

// Dashboard v3 slices 7+8: enterprise settings (audit log, DLP, SSO slot, Team),
// the RBAC audit (a role is never offered what it can't use) and the live A2A card.
// Real control-plane; roles other than owner are set in the throwaway DB.

async function signup(tag: string): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(tag);
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name: "Slots User" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  return { email, token: body.token };
}

async function loginAs(email: string): Promise<string> {
  const r = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`login failed: ${r.status}`);
  return body.token;
}

async function signedIn(page: Page, token: string) {
  await page.context().addCookies([{ name: "pal_token", value: token, url: WEB_URL }]);
  await page.addInitScript((t) => localStorage.setItem("pal_token", t), token);
}

async function createAgent(token: string, name: string) {
  const r = await fetch(`${API_URL}/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, description: "Card test agent", systemPrompt: "Be brief." }),
  });
  if (!r.ok) throw new Error(`create agent: ${r.status} ${await r.text()}`);
}

test.describe("owner", () => {
  let token = "";
  test.beforeAll(async () => {
    token = (await signup("slots-owner")).token;
    await createAgent(token, "card-agent");
  });

  test("settings nav offers the enterprise pages; Team is honest about members", async ({ page }) => {
    await signedIn(page, token);
    await page.goto("/settings?tab=team");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    for (const name of ["Data protection", "Single sign-on", "Audit log", "API keys"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
    await expect(page.getByTestId("members-slot")).toContainText("Not available yet");
    await expect(page.getByRole("button", { name: /invite member/i })).toHaveCount(0);
    await expect(page.getByText("What each role is offered")).toBeVisible();
  });

  test("DLP: add, server rejects a bad regex, edit, delete", async ({ page }) => {
    await signedIn(page, token);
    await page.goto("/settings/dlp");
    await expect(page.getByText("No rules yet")).toBeVisible();

    await page.getByRole("button", { name: "Add rule" }).first().click();
    await page.getByLabel("Rule name").fill("block-cards");
    await page.getByLabel("Mode").selectOption("block");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByText("block-cards")).toBeVisible();
    await expect(page.getByText(/Block rules need the broker egress mode/)).toBeVisible();

    // custom_regex: the SERVER owns RE2 validity; its 400 is shown, nothing is saved.
    await page.getByRole("button", { name: "Add rule" }).first().click();
    await page.getByLabel("Rule name").fill("bad-pattern");
    await page.getByLabel("Detector").selectOption("custom_regex");
    await page.getByLabel("Pattern").fill("(unclosed");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByRole("alert")).toContainText(/not a valid regular expression/i);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("bad-pattern")).toHaveCount(0);

    // edit: the name is the key, mode changes in place
    await page.getByRole("button", { name: "Edit block-cards" }).click();
    await expect(page.getByLabel("Rule name")).toBeDisabled();
    await page.getByLabel("Mode").selectOption("audit");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByText("Audit only")).toBeVisible();

    await page.getByRole("button", { name: "Delete block-cards" }).click();
    await page.getByRole("button", { name: "Delete rule" }).click();
    await expect(page.getByText("No rules yet")).toBeVisible();
  });

  test("audit log merges the real streams and filters", async ({ page }) => {
    await signedIn(page, token);
    await page.goto("/settings/audit");
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(page.getByText(/no single audit feed yet/i)).toBeVisible();
    await page.getByLabel("Filter").fill("zzz-no-such-record");
    await expect(page.getByText("Nothing matches").or(page.getByText("No audit records yet"))).toBeVisible();
  });

  test("SSO is a slot: real sign-in state, nothing to configure, no fake button on login", async ({ page }) => {
    await signedIn(page, token);
    await page.goto("/settings/sso");
    await expect(page.getByTestId("sso-slot")).toContainText("Not available yet");
    await expect(page.getByText("Email and password")).toBeVisible();
    const ctx = await page.context().browser()!.newContext();
    const anon = await ctx.newPage();
    await anon.goto(`${WEB_URL}/login`);
    await expect(anon.getByRole("button", { name: /single sign-on/i })).toHaveCount(0);
    await ctx.close();
  });

  test("agent page shows the live A2A card from the control plane", async ({ page }) => {
    await signedIn(page, token);
    await page.goto("/agents/card-agent?tab=settings");
    const card = page.getByTestId("a2a-card");
    await expect(card.getByRole("heading", { name: "A2A agent card" })).toBeVisible();
    await expect(card.getByText(/A2A v/)).toBeVisible();
    await expect(card.locator("code").first()).toContainText("/v1/agents/card-agent/a2a");
    await expect(card.getByText("card-agent").first()).toBeVisible(); // the agent itself is its one declared skill
    // no localStorage "publish" toggle any more
    await expect(page.getByText("Publish this agent as an A2A Agent Card")).toHaveCount(0);
  });
});

// The role matrix, driven through the real UI: a role never sees an action it can't use.
const ROLES_UNDER_TEST: DbRole[] = ["viewer", "member"];

for (const role of ROLES_UNDER_TEST) {
  test.describe(`role: ${role}`, () => {
    let token = "";
    test.beforeAll(async () => {
      const u = await signup(`slots-${role}`);
      await createAgent(u.token, `agent-${role}`);
      setRole(u.email, role);
      token = await loginAs(u.email);
    });

    test("pages hide the actions this role can't use", async ({ page }) => {
      await signedIn(page, token);
      const canBuild = role === "member";

      await page.goto("/agents");
      await expect(page.getByRole("heading", { name: "Agents" }).first()).toBeVisible();
      const newAgent = page.getByRole("link", { name: /new agent|create agent/i });
      if (canBuild) await expect(newAgent.first()).toBeVisible({ timeout: 20_000 }); // header + sidebar
      else await expect(newAgent).toHaveCount(0, { timeout: 20_000 });

      await page.goto("/budgets");
      await expect(page.getByRole("button", { name: "New budget" })).toHaveCount(0); // budgets:write is owner/admin only

      await page.goto("/runtime");
      await expect(page.getByRole("button", { name: "Schedule", exact: true })).toHaveCount(canBuild ? 1 : 0);

      await page.goto(`/agents/agent-${role}?tab=security`);
      await expect(page.getByRole("button", { name: "Rotate key" })).toHaveCount(canBuild ? 1 : 0);

      // settings: admin-only sections are neither linked nor reachable by deep link
      await page.goto("/settings");
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      await expect(nav.getByRole("link", { name: "General" })).toBeVisible();
      for (const hidden of ["API keys", "Audit log", "Single sign-on"]) await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
      await page.goto("/settings?tab=api-keys");
      await expect(page.getByText(/This section is for workspace owners and admins/)).toBeVisible();
      await page.goto("/settings/audit");
      await expect(page.getByText(/audit log is for workspace owners and admins/i)).toBeVisible();
      await page.goto("/settings/dlp");
      await expect(page.getByRole("button", { name: "Add rule" })).toHaveCount(0);
      await expect(page.getByText(/Only an owner or admin can change these rules/)).toBeVisible();

      // billing: plans are readable, changing the plan is not offered
      await page.goto("/settings?tab=billing");
      await expect(page.getByRole("button", { name: /^Choose / })).toHaveCount(0);
    });
  });
}

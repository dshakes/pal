import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { API_URL, BRIDGE_WA_URL, RUN_DIR, WEB_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/users";

// Dashboard v3 slice 6: the pal (consumer) space — Today, Holds, People & memory,
// Documents — against the real control-plane and a FIXTURE bridge. The owner's
// live bridges (:3100/:3200) are never contacted: global-setup points the
// control-plane and the dashboard at the fixture (WhatsApp) and at a port nothing
// listens on (iMessage, so that channel is genuinely offline).

let token = "";
const H = () => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${p}`, { ...init, headers: { ...H(), ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${p}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const post = <T>(p: string, body: unknown) => api<T>(p, { method: "POST", body: JSON.stringify(body) });

async function signedIn(page: Page) {
  await page.context().addCookies([{ name: "pal_token", value: token, url: WEB_URL }]);
  await page.addInitScript((t) => localStorage.setItem("pal_token", t), token);
}

const sends = async () => (await (await fetch(`${BRIDGE_WA_URL}/__sends`)).json()) as Array<{ to: string; message: string }>;
const failSends = (on: boolean) => fetch(`${BRIDGE_WA_URL}/__fail?on=${on ? 1 : 0}`, { method: "POST" });
const shot = async (page: Page, name: string) => {
  const dir = path.join(RUN_DIR, "shots");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
};
const draft = (displayName: string, draftText: string, channel: "whatsapp" | "imessage" = "whatsapp") =>
  post<{ id: string }>("/v1/whatsapp/drafts", { jid: `e2e-fixture-${Math.floor(Math.random() * 1e9)}@invalid`, displayName, inboundText: `${displayName} says hi`, draftText, channel });
const pending = async () => (await api<{ drafts: Array<{ id: string; displayName: string }> }>("/v1/whatsapp/drafts?status=pending")).drafts;

test.beforeAll(async () => {
  // Approving makes the control-plane POST /send to PAL_BRIDGE_URL. With E2E_REUSE_STACK the
  // fixture bridge may be absent and a control-plane without that env would hit the OWNER'S
  // live bridge, so refuse to run unless the fixture is what answers.
  const health = await fetch(`${BRIDGE_WA_URL}/health`).then((r) => r.json() as Promise<{ version?: string }>).catch(() => null);
  if (health?.version !== "fixture") {
    throw new Error(`pal-space e2e aborted: ${BRIDGE_WA_URL}/health is not the fixture bridge. Start it (global-setup does) and point the control-plane at it; see e2e/README.md.`);
  }
  const r = await fetch(`${API_URL}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("palspace"), password: PASSWORD, name: "Pal Owner" }),
  });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`sign-up failed: ${r.status}`);
  token = body.token;
  await post("/v1/life-events", { kind: "bill", channel: "whatsapp", summary: "Electric bill due Friday", urgency: "high" });
  await post("/v1/commitments", { title: "Send Raju the deck", source: "self", urgency: "soon" });
  await post("/v1/memory/events", { channel: "whatsapp", handle: "15550001111@s.whatsapp.net", displayName: "Priya Sharma", kind: "message", direction: "in", content: "Landed safely, see you at seven" });
});

test.afterEach(async () => {
  await failSends(false);
});

test("Today: held reply, suggestion, commitment and a bridge thread render; offline iMessage degrades, not errors", async ({ page }) => {
  await draft("Raju", "Sure, tomorrow works");
  await signedIn(page);
  await page.goto("/brief");
  await expect(page.getByRole("article", { name: "Held reply to Raju" })).toBeVisible();
  await expect(page.getByText("Electric bill due Friday")).toBeVisible();
  await expect(page.getByText("Send Raju the deck")).toBeVisible();
  // Read-only attention snapshot from the fixture bridge.
  await expect(page.getByText("Madhu has been waiting 3 days")).toBeVisible();
  await expect(page.getByTestId("bridge-whatsapp")).toContainText("Connected");
  await expect(page.getByTestId("bridge-imessage")).toContainText("Offline");
  await expect(page.getByText(/aren.t shown until it.s back/)).toBeVisible();
  await shot(page, "today");
});

test("approve stops at a confirm card: nothing is sent until Send now", async ({ page }) => {
  await draft("Approve Ann", "On my way");
  await signedIn(page);
  await page.goto("/personal/drafts");
  const card = page.getByRole("article", { name: "Held reply to Approve Ann" });
  const before = (await sends()).length;
  await card.getByRole("button", { name: "Approve" }).click();
  const confirm = card.getByRole("group", { name: "Send this reply to Approve Ann on WhatsApp?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("On my way");
  await shot(page, "holds-confirm");
  expect((await sends()).length).toBe(before);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect((await sends()).length).toBe(before);
  await card.getByRole("button", { name: "Approve" }).click();
  await confirm.getByRole("button", { name: "Send now" }).click();
  await expect(card).toHaveCount(0);
  const after = await sends();
  expect(after.length).toBe(before + 1);
  expect(after.at(-1)?.message).toBe("On my way");
  expect((await pending()).some((d) => d.displayName === "Approve Ann")).toBe(false);
});

test("edit sends the edited text; a blank edit cannot be reviewed", async ({ page }) => {
  await draft("Edit Eve", "original text");
  await signedIn(page);
  await page.goto("/brief");
  const card = page.getByRole("article", { name: "Held reply to Edit Eve" });
  await card.getByRole("button", { name: "Edit" }).click();
  const box = card.getByRole("textbox", { name: "Edit reply" });
  await box.fill("   ");
  await expect(card.getByRole("button", { name: "Review & send" })).toBeDisabled();
  await box.fill("  edited text  ");
  await card.getByRole("button", { name: "Review & send" }).click();
  const confirm = card.getByRole("group", { name: /Send your edited reply to Edit Eve/ });
  await expect(confirm).toContainText("edited text");
  await confirm.getByRole("button", { name: "Send edited reply" }).click();
  await expect(card).toHaveCount(0);
  expect((await sends()).at(-1)?.message).toBe("edited text");
});

test("discard confirms, sends nothing and removes the draft", async ({ page }) => {
  await draft("Discard Dan", "never mind");
  await signedIn(page);
  await page.goto("/personal/drafts");
  const card = page.getByRole("article", { name: "Held reply to Discard Dan" });
  const before = (await sends()).length;
  await card.getByRole("button", { name: "Discard" }).click();
  await card.getByRole("group", { name: "Discard this draft for Discard Dan?" }).getByRole("button", { name: "Discard draft" }).click();
  await expect(card).toHaveCount(0);
  expect((await sends()).length).toBe(before);
  expect((await pending()).some((d) => d.displayName === "Discard Dan")).toBe(false);
});

test("a failed delivery is reported as NOT delivered, with the text kept to copy", async ({ page }) => {
  await draft("Fail Fay", "this will not arrive");
  await draft("Offline Ollie", "imessage is down", "imessage");
  await signedIn(page);
  await page.goto("/personal/drafts");
  // 1) bridge answers 500
  await failSends(true);
  const fay = page.getByRole("article", { name: "Held reply to Fail Fay" });
  await fay.getByRole("button", { name: "Approve" }).click();
  await fay.getByRole("button", { name: "Send now" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Reply to Fail Fay was not delivered" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("this will not arrive");
  await expect(alert).toContainText("will not retry");
  await shot(page, "holds-not-delivered");
  // 2) bridge unreachable (the iMessage fixture port has no listener)
  const ollie = page.getByRole("article", { name: "Held reply to Offline Ollie" });
  await ollie.getByRole("button", { name: "Approve" }).click();
  await ollie.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reply to Offline Ollie was not delivered" })).toBeVisible();
});

test("People & memory lists the person graph and opens a person's memory", async ({ page }) => {
  await signedIn(page);
  await page.goto("/personal/contacts");
  const row = page.getByRole("button", { name: /Priya Sharma/ });
  await expect(row).toBeVisible();
  await page.getByPlaceholder("Search by name or relationship").fill("zzz-no-one");
  await expect(page.getByText("Nobody matches that search.")).toBeVisible();
  await page.getByPlaceholder("Search by name or relationship").fill("priya");
  await row.click();
  await expect(page.getByRole("region", { name: "Memory" })).toContainText("Landed safely, see you at seven");
  await shot(page, "people-memory");
});

test("Documents does not invent folder status and says deadline scanning is off", async ({ page }) => {
  await signedIn(page);
  await page.goto("/personal/docs");
  await expect(page.getByText("Deadline scanning is off")).toBeVisible();
  await expect(page.getByText("exists", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/isn.t shown or verified here/)).toBeVisible();
});

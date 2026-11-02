import { expect, test } from "@playwright/test";
import { API_URL, WEB_URL } from "../support/env";
import { signUp, uniqueEmail } from "../support/users";

// S-2/S-3: the session is an HttpOnly cookie behind a same-origin proxy, pages
// carry a nonce'd CSP, and logging out revokes the session server-side.

const sessionCookie = async (page: import("@playwright/test").Page) =>
  (await page.context().cookies()).find((c) => c.name === "pal_token");

test("pages carry the security headers and load without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|connect)/i.test(m.text())) violations.push(m.text()); });
  page.on("pageerror", (e) => violations.push(e.message));

  const login = await page.goto("/login");
  const csp = login!.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(login!.headers()["x-content-type-options"]).toBe("nosniff");
  expect(login!.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(login!.headers()["permissions-policy"]).toContain("camera=()");

  await signUp(page, uniqueEmail("csp"));
  for (const path of ["/agents", "/overview", "/settings"]) {
    const res = await page.goto(path);
    expect(res!.headers()["content-security-policy"]).toContain("'strict-dynamic'");
    await page.waitForLoadState("networkidle");
  }
  expect(violations).toEqual([]);
});

test("the session never reaches page scripts", async ({ page }) => {
  await signUp(page, uniqueEmail("httponly"));
  const c = await sessionCookie(page);
  expect(c?.httpOnly).toBe(true);
  expect(c?.sameSite).toBe("Lax");
  const visible = await page.evaluate(() => ({
    cookie: document.cookie,
    stored: Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.split(".").length === 3),
  }));
  expect(visible.cookie).not.toContain("pal_token");
  expect(visible.stored).toEqual([]);
});

test("the proxy refuses a cross-site POST (CSRF)", async ({ page }) => {
  await signUp(page, uniqueEmail("csrf"));
  const forged = await page.request.post(`${WEB_URL}/api/pal/v1/agents`, {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    data: { name: "csrf-agent" },
  });
  expect(forged.status()).toBe(403);
  // The same call from the dashboard's own page goes through.
  const own = await page.evaluate(async () => (await fetch("/api/pal/v1/agents")).status);
  expect(own).toBe(200);
});

test("sign out revokes the session server-side, not just the cookie", async ({ page }) => {
  await signUp(page, uniqueEmail("revoke"));
  const token = (await sessionCookie(page))!.value;
  expect((await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

  await page.goto("/overview");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");

  // A copy of the old token (stolen, or on another device) is dead too.
  expect((await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
});

import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { PG_ADMIN_URL } from "./env";
import { flushRedis } from "./redis";

export const PASSWORD = "e2e-correct-horse-battery";
export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.pal.test`;

// Drive the real sign-up form (dev mode: no email verification gate).
export async function signUp(page: Page, email: string, name = "E2E User") {
  // The suite signs up ~9 users (more with retries) from one IP, against a limit
  // of 10/IP/hour: reset the counters so one flaky retry can't fail every later spec.
  await flushRedis();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account/ }).click();
  // Signed up == logged in: the app leaves /login (for /welcome). Cold `next dev`
  // compiles the destination on first hit, hence the generous timeout.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

// The step-by-step wizard (the conversation's labelled fallback, ADR 0051).
export async function openOnboarding(page: Page) {
  await page.goto("/onboarding?mode=steps");
  await page.getByRole("heading", { name: "What should your agent do?" }).waitFor({ timeout: 60_000 });
}

// The default: the onboarding agent conversation (ADR 0051).
export async function openConversation(page: Page) {
  await page.goto("/onboarding");
  await page.getByRole("textbox", { name: "Message the onboarding agent" }).waitFor({ timeout: 60_000 });
}

// The API has no way to create a non-owner (no members endpoint yet), so RBAC
// specs promote/demote through the throwaway DB. The spec runs in a worker, not
// the process that named the DB (pal_e2e_<pid>), so find the one holding the user.
export type DbRole = "owner" | "admin" | "member" | "viewer";
export function setRole(email: string, role: DbRole): void {
  if (!/^[\w.+-]+@[\w.-]+$/.test(email)) throw new Error("unsafe email for SQL literal");
  const dbs = execFileSync("psql", [PG_ADMIN_URL, "-Atc", "SELECT datname FROM pg_database WHERE datname LIKE 'pal_e2e_%'"]).toString().split("\n").filter(Boolean);
  for (const db of dbs) {
    const u = new URL(PG_ADMIN_URL);
    u.pathname = `/${db}`;
    const out = execFileSync("psql", [u.toString(), "-Atc", `UPDATE users SET role='${role}' WHERE email='${email}' RETURNING 1`]).toString().trim();
    if (out.startsWith("1")) return;
  }
  throw new Error(`user ${email} not found in any e2e database`);
}

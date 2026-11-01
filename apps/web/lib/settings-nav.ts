// Settings navigation — ONE array the Settings layout renders.
//
// To add a page: create app/(dashboard)/settings/<slug>/page.tsx and append
// `{ href: "/settings/<slug>", label, icon }` here. Entries that are tabs of
// the main settings page use `?tab=<id>`. Keep labels short; order = display.

import { can, type Capability } from "./rbac.ts";

export type SettingsIcon = "settings" | "key" | "cpu" | "users" | "card" | "smartphone" | "shield" | "scroll" | "lock" | "login";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: SettingsIcon;
  description?: string;
  /** Capability the role needs to SEE this entry (UX only; the server still decides). */
  cap?: Capability;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: "/settings?tab=general", label: "General", icon: "settings" },
  { href: "/settings?tab=providers", label: "Model providers", icon: "cpu" },
  { href: "/settings?tab=api-keys", label: "API keys", icon: "key", cap: "settings:write" },
  { href: "/settings?tab=team", label: "Team", icon: "users" },
  { href: "/settings?tab=devices", label: "Devices", icon: "smartphone" },
  { href: "/settings?tab=billing", label: "Billing", icon: "card" },
  { href: "/settings/mcp", label: "MCP", icon: "shield" },
  { href: "/settings/dlp", label: "Data protection", icon: "lock" },
  { href: "/settings/sso", label: "Single sign-on", icon: "login", cap: "settings:write" },
  { href: "/settings/audit", label: "Audit log", icon: "scroll", cap: "audit:read" },
];

/** Entries the role should be offered. */
export function visibleSettingsNav(role: string | null | undefined): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => !i.cap || can(role, i.cap));
}

/** Whether a role may open the entry behind a `?tab=` id (deep links included). */
export function settingsTabAllowed(role: string | null | undefined, tab: string): boolean {
  const item = SETTINGS_NAV.find((i) => new URLSearchParams(i.href.split("?")[1] ?? "").get("tab") === tab);
  return !item?.cap || can(role, item.cap);
}

/** Whether a nav entry is the current one (path + optional ?tab=). */
export function isSettingsActive(item: SettingsNavItem, pathname: string, tab: string | null): boolean {
  const [path, query] = item.href.split("?");
  if (pathname !== path) return false;
  const itemTab = new URLSearchParams(query ?? "").get("tab");
  if (!itemTab) return true;
  return (tab ?? "general") === itemTab;
}

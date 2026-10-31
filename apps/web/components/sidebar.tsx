"use client";
// Dashboard sidebar (v3). Two home spaces behind one switch; every link comes
// from lib/workspace-nav (the single IA source of truth).
//
// ┌──────────────────────────┐
// │ ◎ Ada’s workspace    ⇅   │  ← OrgSwitcher (workspace + role)
// │ [ ● pal  |  ● Runtime ]  │  ← space switch (re-points the accent)
// │ Today / Holds / …        │  ← nav for the active space
// │ Recent agents            │  ← Runtime only
// ├──────────────────────────┤
// │ ⚙ Settings          [⇤]  │
// └──────────────────────────┘
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { PanelLeft, PanelLeftClose, Plus, Settings } from "lucide-react";
import { ModeSwitch } from "@/components/mode-switch";
import { OrgSwitcher } from "@/components/org-switcher";
import { navIcon } from "@/components/nav-icon";
import { RoleGate } from "@/components/role-gate";
import { Tooltip } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { NAV, allNavItems, isNavActive } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

const COLLAPSE_KEY = "pal-sidebar-collapsed";
const RECENT_AGENTS = 5;

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { mode } = useWorkspaceMode();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch { /* ignore */ }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try { localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1"); } catch { /* ignore */ }
      return !v;
    });
  };

  const items = allNavItems(mode);

  return (
    <aside
      aria-label="Sidebar"
      className={clsx(
        "flex h-screen flex-col border-r border-line bg-panel transition-[width] duration-150",
        collapsed ? "w-[60px]" : "w-[244px]",
      )}
    >
      <div className={clsx("space-y-2.5 pt-3", collapsed ? "px-2" : "px-3")}>
        <OrgSwitcher collapsed={collapsed} />
        {!collapsed && <ModeSwitch />}
      </div>

      <nav aria-label={mode === "pal" ? "pal navigation" : "Runtime navigation"} className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {NAV[mode].map((section, si) => (
          <div key={si} className={clsx(si > 0 && "mt-4")}>
            {section.title && !collapsed && (
              <p className="px-2.5 pb-1 text-[12px] font-medium text-fg-3">{section.title}</p>
            )}
            <ul className="space-y-px">
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    href={item.href}
                    label={item.label}
                    Icon={navIcon(item.icon)}
                    active={isNavActive(item, pathname, items)}
                    collapsed={collapsed}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {mode === "runtime" && !collapsed && <RecentAgents pathname={pathname} />}
      </nav>

      <div className={clsx("flex items-center gap-1 border-t border-line px-2 py-2", collapsed && "flex-col")}>
        <div className="min-w-0 flex-1 self-stretch">
          <NavLink
            href="/settings"
            label="Settings"
            Icon={Settings}
            active={pathname === "/settings" || pathname.startsWith("/settings/")}
            collapsed={collapsed}
          />
        </div>
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="focus-ring rounded-md p-1.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

function NavLink({
  href, label, Icon, active, collapsed,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed: boolean;
}) {
  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={clsx(
        "focus-ring relative flex h-[var(--nav-h)] items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors duration-150",
        active ? "bg-hover font-medium text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
        collapsed && "justify-center px-0",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-[7px] left-0 w-[2px] rounded-full bg-accent" />}
      <Icon className={clsx("h-4 w-4 shrink-0", active ? "text-accent" : "text-fg-3")} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
  return collapsed ? <Tooltip label={label} side="right">{link}</Tooltip> : link;
}

function RecentAgents({ pathname }: { pathname: string }) {
  const { agents, loading } = useAgents();
  const recent = useMemo(
    () => [...agents].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, RECENT_AGENTS),
    [agents],
  );
  if (loading) return null;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <p className="text-[12px] font-medium text-fg-3">Recent agents</p>
        <RoleGate cap="agents:write">
          <Tooltip label="New agent" side="right">
            <Link href="/agents/create" aria-label="New agent" className="focus-ring rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
              <Plus className="h-3.5 w-3.5" />
            </Link>
          </Tooltip>
        </RoleGate>
      </div>
      {recent.length === 0 ? (
        <p className="px-2.5 py-1 text-[12.5px] text-fg-3">No agents yet.</p>
      ) : (
        <ul className="space-y-px">
          {recent.map((a) => {
            const href = `/agents/${encodeURIComponent(a.name)}`;
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <li key={a.id}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "focus-ring flex h-[var(--nav-h)] items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                    active ? "bg-hover text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
                  )}
                >
                  <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-raised font-mono text-[10px] text-fg-3">
                    {a.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate font-mono text-[12.5px]">{a.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

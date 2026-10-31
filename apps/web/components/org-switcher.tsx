"use client";
// Workspace + space switcher — the sidebar's header and its one signature
// control. The trigger names the workspace and the space you're in (pal or
// Runtime, with that space's accent mark); the menu switches space and holds
// the workspace list.
//
// Today a session belongs to exactly one workspace (/auth/me returns one
// tenant and no endpoint lists a user's workspaces), so the list holds the
// current workspace only. When a workspaces endpoint lands, it fills in here.

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, Settings } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "@/lib/auth";
import { ROLE_LABEL, toRole } from "@/lib/rbac";
import { MODE_LABEL, type WorkspaceMode } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui";
import { PalMark } from "@/components/pal-mark";

export function workspaceName(name?: string | null, email?: string | null): string {
  const first = (name || email || "").split(/[\s@]/)[0];
  return first ? `${first}’s workspace` : "Workspace";
}

const SPACE_HINT: Record<WorkspaceMode, string> = {
  pal: "Your personal layer",
  runtime: "Build and run agents",
};

/** The space's own mark — the brand gradient, used only as a small mark. */
export function SpaceDot({ mode, className }: { mode: WorkspaceMode; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ backgroundImage: mode === "pal" ? "var(--pal-grad)" : "var(--rt-grad)" }}
    />
  );
}

export function OrgSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useAuth();
  const { mode, switchTo } = useWorkspaceMode();
  const ws = workspaceName(user?.name, user?.email);

  return (
    <Menu>
      <MenuTrigger
        aria-label={`${ws}, ${MODE_LABEL[mode]} space. Switch space or workspace`}
        className={clsx(
          "focus-ring flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover",
          collapsed && "justify-center",
        )}
      >
        <PalMark className="h-8 w-8 shrink-0" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13.5px] font-semibold text-fg">{ws}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-fg-2">
                <SpaceDot mode={mode} />
                {MODE_LABEL[mode]}
              </span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent align="start" className="w-[264px]">
        <MenuLabel>Space</MenuLabel>
        <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => v !== mode && switchTo(v as WorkspaceMode)}>
          {(["pal", "runtime"] as WorkspaceMode[]).map((m) => (
            <DropdownMenu.RadioItem
              key={m}
              value={m}
              className="flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover"
            >
              <SpaceDot mode={m} className="h-2.5 w-2.5" />
              <span className="min-w-0 flex-1">
                <span className={clsx("block", m === mode ? "font-medium text-fg" : "text-fg-2")}>{MODE_LABEL[m]}</span>
                <span className="block text-[11.5px] text-fg-3">{SPACE_HINT[m]}</span>
              </span>
              <DropdownMenu.ItemIndicator>
                <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        <MenuSeparator />
        <MenuLabel>Workspace</MenuLabel>
        <MenuItem className="h-auto justify-between py-1.5">
          <span className="min-w-0">
            <span className="block truncate text-fg">{ws}</span>
            <span className="block text-[11.5px] text-fg-3">{ROLE_LABEL[toRole(user?.role)]}</span>
          </span>
          <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-label="Current workspace" />
        </MenuItem>
        <MenuItem asChild>
          <Link href="/settings">
            <Settings className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Workspace settings
          </Link>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

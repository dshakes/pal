"use client";
// Workspace switcher (top of the sidebar). Today a session belongs to exactly
// one workspace (/auth/me returns one tenant and there is no endpoint listing
// a user's workspaces), so this degrades honestly: it names the current
// workspace and the signed-in role, and "Create workspace" is shown disabled
// with the reason. When a workspaces endpoint lands, the list fills in here.

import Link from "next/link";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "@/lib/auth";
import { ROLE_LABEL, toRole } from "@/lib/rbac";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui";
import { PalMark } from "@/components/pal-mark";

export function workspaceName(name?: string | null, email?: string | null): string {
  const first = (name || email || "").split(/[\s@]/)[0];
  return first ? `${first}’s workspace` : "Workspace";
}

export function OrgSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useAuth();
  const ws = workspaceName(user?.name, user?.email);
  const role = ROLE_LABEL[toRole(user?.role)];

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Workspace: ${ws}`}
        className={clsx(
          "focus-ring flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover",
          collapsed && "justify-center",
        )}
      >
        <PalMark className="h-7 w-7 shrink-0" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13.5px] font-semibold text-fg">{ws}</span>
              <span className="block truncate text-[12px] text-fg-3">{role}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        <MenuLabel>Workspaces</MenuLabel>
        <MenuItem className="justify-between">
          <span className="truncate text-fg">{ws}</span>
          <Check className="h-3.5 w-3.5 text-accent" aria-label="Current workspace" />
        </MenuItem>
        <MenuSeparator />
        <MenuItem asChild>
          <Link href="/settings">
            <Settings className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Workspace settings
          </Link>
        </MenuItem>
        <MenuItem disabled>
          <Plus className="h-3.5 w-3.5 text-fg-3" aria-hidden />
          <span className="flex flex-col leading-tight">
            Create workspace
            <span className="text-[11.5px] text-fg-3">Multiple workspaces aren’t available yet</span>
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

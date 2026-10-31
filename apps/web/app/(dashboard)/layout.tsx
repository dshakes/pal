"use client";
// App shell (v3): sidebar · topbar (⌘K, agent panel, display, notifications,
// account) · page. One accent per space: <html data-mode="runtime"> re-points
// the accent scale indigo→cyan; pal keeps coral→magenta. It lives on <html>
// (set pre-paint by THEME_INIT_SCRIPT, kept in sync here) so portaled menus,
// dialogs and ⌘K pick up the right accent too. Theme, contrast and density
// are <html> data-attributes as well (see lib/display-prefs).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, BookOpen, LogOut, Search, Settings, Sparkles, User } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Notifications } from "@/components/notifications";
import { CommandPalette } from "@/components/command-palette";
import { DemoModeBanner } from "@/components/demo-mode-banner";
import { KioskTour, useKioskSession } from "@/components/kiosk-tour";
import { MobileNav } from "@/components/mobile-nav";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { PalMark } from "@/components/pal-mark";
import { AgentSurface, AgentSurfaceProvider, useAgentSurfaceToggle } from "@/components/agent-surface";
import { DisplayPrefsControl } from "@/components/display-prefs";
import { RoleGate } from "@/components/role-gate";
import { Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip, TooltipProvider } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import { openAsk } from "@/lib/ask-events";
import { ROLE_LABEL, toRole } from "@/lib/rbac";
import { MODE_HOME, MODE_LABEL } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { mode } = useWorkspaceMode();
  useEffect(() => {
    const d = document.documentElement.dataset;
    d.mode = mode;
    return () => { delete d.mode; };
  }, [mode]);
  return (
    <TooltipProvider delayDuration={350}>
      <AgentSurfaceProvider>
        <div className="flex h-dvh overflow-hidden bg-canvas">
          <a href="#main" className="focus-ring sr-only z-[200] rounded-md bg-panel px-3 py-2 text-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
            Skip to content
          </a>
          <div className="hidden md:flex">
            <Sidebar />
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0">
            <Topbar />
            <DemoModeBanner />
            <KioskTour />
            <ProviderBanner />
            <main id="main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="page-enter flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
            </main>
          </div>
          <CommandPalette />
          <AgentSurface />
          <MobileNav />
          <KeyboardShortcuts />
        </div>
      </AgentSurfaceProvider>
    </TooltipProvider>
  );
}

function Topbar() {
  const router = useRouter();
  const { user, logout, isDemoMode } = useAuth();
  const { mode } = useWorkspaceMode();
  const surface = useAgentSurfaceToggle();

  const signOut = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-3 md:px-5">
      {/* Phone: wordmark → this space's home (the sidebar is hidden under md). */}
      <Link href={MODE_HOME[mode]} aria-label="PAL home" className="focus-ring flex items-center gap-2 rounded-md md:hidden">
        <PalMark className="h-6 w-6" />
        <span className="text-[15px] font-semibold tracking-tight text-fg">PAL</span>
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11.5px] font-medium text-accent">{MODE_LABEL[mode]}</span>
      </Link>

      <button
        type="button"
        onClick={() => openAsk()}
        aria-label="Search or ask PAL"
        aria-keyshortcuts="Meta+K"
        className="focus-ring ml-auto flex h-8 w-8 items-center justify-center gap-2 rounded-lg border border-line bg-panel text-fg-3 transition-colors hover:border-line-strong hover:text-fg md:ml-0 md:w-full md:max-w-[440px] md:justify-start md:px-2.5"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="hidden flex-1 truncate text-left text-[13px] md:inline">Search or ask PAL</span>
        <span className="hidden md:inline-flex"><Kbd>⌘K</Kbd></span>
      </button>

      <div className="flex shrink-0 items-center gap-1 md:ml-auto">
        <Tooltip label={<span className="flex items-center gap-1.5">Agent panel <Kbd>⌘\</Kbd></span>}>
          <button
            type="button"
            onClick={surface.toggle}
            aria-label="Open PAL agent"
            aria-pressed={surface.open}
            aria-keyshortcuts="Meta+Backslash"
            className="focus-ring flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-accent transition-colors hover:bg-accent-soft"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="hidden lg:inline">Agent</span>
          </button>
        </Tooltip>
        <DisplayPrefsControl />
        <Notifications />
        <Menu>
          <MenuTrigger
            aria-label="Account"
            className="focus-ring ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-raised text-[12px] font-semibold text-fg-2 hover:bg-hover data-[state=open]:bg-hover"
          >
            {user?.name ? user.name.charAt(0).toUpperCase() : <User className="h-3.5 w-3.5" aria-hidden />}
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            <div className="px-2 pb-2 pt-1.5">
              <p className="truncate text-[13px] font-medium text-fg">{user?.name || "Signed in"}</p>
              <p className="truncate text-[12px] text-fg-3">{user?.email}</p>
              <p className="mt-1 text-[12px] text-fg-3">
                {ROLE_LABEL[toRole(user?.role)]}
                {isDemoMode && <span className="ml-1.5 rounded bg-accent-soft px-1.5 text-accent">demo</span>}
              </p>
            </div>
            <MenuSeparator />
            <MenuItem onSelect={() => router.push("/settings")}>
              <Settings className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Settings
            </MenuItem>
            <MenuItem asChild>
              <a href="https://github.com/dshakes/pal#readme" target="_blank" rel="noopener noreferrer">
                <BookOpen className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Documentation
              </a>
            </MenuItem>
            <MenuSeparator />
            <MenuItem tone="danger" onSelect={() => void signOut()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

function ProviderBanner() {
  const kiosk = useKioskSession();
  const { isConfigured, loading } = useModels();
  if (kiosk || loading || isConfigured) return null;
  return (
    <div className="flex items-center gap-3 border-b border-warn/30 bg-warn-soft px-4 py-2 md:px-5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden />
      <p className="text-[13px] text-warn">Add a model provider key to turn on PAL’s AI features.</p>
      <RoleGate cap="settings:write">
        <Link
          href="/settings?tab=providers"
          className="focus-ring ml-auto shrink-0 rounded-md border border-warn/40 px-2.5 py-1 text-[12px] font-medium text-warn hover:bg-warn/10"
        >
          Add key
        </Link>
      </RoleGate>
    </div>
  );
}

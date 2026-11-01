"use client";
// RoleGate — renders its children only when the signed-in role holds the
// capability (lib/rbac). Use `fallback` to show a read-only hint instead.
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { can, canDebug, type Capability } from "@/lib/rbac";

export function useCan(cap: Capability): boolean {
  const { user } = useAuth();
  return can(user?.role, cap);
}

export function useCanDebug(): boolean {
  const { user } = useAuth();
  return canDebug(user?.role);
}

export function RoleGate({ cap, children, fallback = null }: { cap: Capability; children: ReactNode; fallback?: ReactNode }) {
  return <>{useCan(cap) ? children : fallback}</>;
}

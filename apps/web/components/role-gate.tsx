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

/** False until /auth/me has answered. Before that the role is unknown and useCan() reads
 *  as viewer, so a full-page "your role can't..." notice must wait for this (no flash for owners). */
export function useRoleReady(): boolean {
  const { isLoading } = useAuth();
  return !isLoading;
}
export function useCanDebug(): boolean {
  const { user } = useAuth();
  return canDebug(user?.role);
}

export function RoleGate({ cap, children, fallback = null }: { cap: Capability; children: ReactNode; fallback?: ReactNode }) {
  return <>{useCan(cap) ? children : fallback}</>;
}

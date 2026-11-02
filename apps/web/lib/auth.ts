"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { api, DEMO_USER, type User } from "@/lib/api";
import React from "react";

// ---------------------------------------------------------------------------
// Auth state type
// ---------------------------------------------------------------------------

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isDemoMode: boolean;
  signup: (
    email: string,
    password: string,
    name: string,
    extra?: { inviteCode?: string; captchaToken?: string },
  ) => Promise<{ verificationRequired: boolean }>;
  login: (email: string, password: string) => Promise<void>;
  loginDemo: () => void;
  /** Revokes every session server-side and clears the HttpOnly cookie. */
  logout: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthState | null>(null);

// Demo mode is OFF unless explicitly enabled at build time. Even when on it is
// local UI state only: there is no session cookie, so the middleware refuses
// every gated route and no tenant data is reachable.
const DEMO_MODE_ENABLED = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

// The session is the HttpOnly `pal_token` cookie (S-3): page scripts never see
// the JWT. "Signed in" therefore means "/auth/me through the same-origin
// proxy answered with a user" — there is no client-side token to restore or to
// fall out of sync with the cookie.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDemoMode, setIsDemoMode] = useState(false);

  useEffect(() => {
    api.getMe()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  const signup = useCallback(async (
    email: string,
    password: string,
    name: string,
    extra?: { inviteCode?: string; captchaToken?: string },
  ) => {
    const result = await api.signup(email, password, name, extra);
    if (!result.user) {
      // Prod: account created, no session until the email is verified.
      return { verificationRequired: true };
    }
    setUser(result.user);
    setIsDemoMode(false);
    return { verificationRequired: false };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setUser(result.user);
    setIsDemoMode(DEMO_MODE_ENABLED && result.demo === true);
  }, []);

  const loginDemo = useCallback(() => {
    if (!DEMO_MODE_ENABLED) {
      console.warn("[pal] Demo mode is disabled (set NEXT_PUBLIC_DEMO_MODE=1 to enable).");
      return;
    }
    setUser(DEMO_USER);
    setIsDemoMode(true);
  }, []);

  const logout = useCallback(async () => {
    // Awaited so a following navigation can't race the cookie clear and get
    // waved through by middleware with a still-present cookie.
    await api.logout();
    setUser(null);
    setIsDemoMode(false);
  }, []);

  const value: AuthState = {
    user,
    isLoading,
    isAuthenticated: !!user,
    isDemoMode,
    signup,
    login,
    loginDemo,
    logout,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}

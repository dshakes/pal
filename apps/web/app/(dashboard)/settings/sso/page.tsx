"use client";

// Settings -> Single sign-on: a SLOT. The control plane reports which sign-in
// methods it supports (GET /auth/providers) and has no SAML/OIDC configuration
// API, so there is nothing to configure here yet. This page shows the real
// state (which methods are on) and says plainly what is missing; the login
// page picks up `oauth.sso` the day the server reports it (lib/auth-providers).

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api, type AuthProviders } from "@/lib/api";
import { visibleOAuthProviders } from "@/lib/auth-providers";
import { useCan } from "@/components/role-gate";

const LABEL: Record<string, string> = { google: "Google", github: "GitHub", sso: "Single sign-on" };

export default function SsoSettingsPage() {
  const allowed = useCan("settings:write");
  const [providers, setProviders] = useState<AuthProviders | null | undefined>(undefined);
  useEffect(() => {
    if (allowed) void api.getAuthProviders().then(setProviders);
  }, [allowed]);

  if (!allowed) {
    return <div role="status" className="rounded-xl border border-line bg-panel p-5 text-sm text-fg-3">Sign-in settings are for workspace owners and admins.</div>;
  }
  const on = visibleOAuthProviders(providers?.oauth);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-panel p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg"><KeyRound className="h-4 w-4 text-accent" /> Single sign-on</h2>
        <p className="mt-1 text-[11px] text-fg-3">How people sign in to this deployment.</p>
        <dl className="mt-4 space-y-2 text-xs">
          <div className="flex justify-between gap-4"><dt className="text-fg-3">Email and password</dt><dd className="text-fg-2">on</dd></div>
          <div className="flex justify-between gap-4">
            <dt className="text-fg-3">Social sign-in</dt>
            <dd className="text-fg-2">{providers === undefined ? "checking…" : providers === null ? "unknown (could not reach the control plane)" : on.length ? on.map((p) => LABEL[p] ?? p).join(", ") : "none configured"}</dd>
          </div>
          {providers && (
            <div className="flex justify-between gap-4"><dt className="text-fg-3">Sign-up</dt><dd className="text-fg-2">{providers.signup}</dd></div>
          )}
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-panel p-5" data-testid="sso-slot">
        <h3 className="text-sm font-semibold text-fg">SAML / OIDC for your organization</h3>
        <p className="mt-1 text-xs text-fg-3">
          Not available yet. The control plane has no SSO configuration API, so this page cannot connect an identity provider, map domains or enforce SSO.
          When it does, the sign-in page shows a &ldquo;Continue with single sign-on&rdquo; button automatically.
        </p>
      </section>
    </div>
  );
}

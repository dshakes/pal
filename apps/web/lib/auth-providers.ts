// Which sign-in buttons the login page may show. GET /auth/providers reports
// {oauth: {google, github, ...}}; we render only what the deployment says is
// on AND we know how to label. "sso" is the enterprise slot: it renders once
// the control plane reports oauth.sso = true AND serves /auth/oauth/sso/start (that
// route is not defined yet, so wiring it is backend work), and not before - a button that can only fail is worse than no button.

export const KNOWN_OAUTH_PROVIDERS = ["github", "google", "sso"] as const;

export function visibleOAuthProviders(oauth: Record<string, boolean> | null | undefined): string[] {
  return Object.entries(oauth ?? {})
    .filter(([id, on]) => on === true && (KNOWN_OAUTH_PROVIDERS as readonly string[]).includes(id))
    .map(([id]) => id)
    .sort();
}

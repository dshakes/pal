/** The "add a provider key" banner may only claim keys are missing when the API said so. */
export function shouldShowProviderBanner(s: { kiosk: boolean; loading: boolean; loaded: boolean; isConfigured: boolean }): boolean {
  return !s.kiosk && !s.loading && s.loaded && !s.isConfigured;
}

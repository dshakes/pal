// Display preferences: theme, contrast, density. Each is a data-* attribute on
// <html> (globals.css reacts to it) persisted in localStorage. The pre-paint
// half lives in theme-init-script.ts; this is the runtime half the controls use.

export type Theme = "dark" | "light";
export type Contrast = "system" | "more" | "normal";
export type Density = "comfortable" | "compact";

export const PREF_KEYS = { theme: "pal-theme", contrast: "pal-contrast", density: "pal-density" } as const;

export interface DisplayPrefs {
  theme: Theme;
  contrast: Contrast;
  density: Density;
}

/** Parse stored values; anything unknown falls back to the default. */
export function readPrefs(get: (k: string) => string | null): DisplayPrefs {
  const t = get(PREF_KEYS.theme);
  const c = get(PREF_KEYS.contrast);
  const n = get(PREF_KEYS.density);
  return {
    theme: t === "light" ? "light" : "dark",
    contrast: c === "more" || c === "normal" ? c : "system",
    density: n === "compact" ? "compact" : "comfortable",
  };
}

/** The attribute values for <html>. "system" contrast resolves via the OS. */
export function attrsFor(p: DisplayPrefs, osMoreContrast: boolean): Record<"theme" | "contrast" | "density", string> {
  return {
    theme: p.theme,
    contrast: p.contrast === "system" ? (osMoreContrast ? "more" : "normal") : p.contrast,
    density: p.density,
  };
}

/** Browser-only: persist + apply in one step. */
export function applyPrefs(p: DisplayPrefs): void {
  const os = typeof matchMedia === "function" && matchMedia("(prefers-contrast: more)").matches;
  const a = attrsFor(p, os);
  const d = document.documentElement.dataset;
  d.theme = a.theme;
  d.contrast = a.contrast;
  d.density = a.density;
  try {
    localStorage.setItem(PREF_KEYS.theme, p.theme);
    if (p.contrast === "system") localStorage.removeItem(PREF_KEYS.contrast);
    else localStorage.setItem(PREF_KEYS.contrast, p.contrast);
    localStorage.setItem(PREF_KEYS.density, p.density);
  } catch {
    /* storage unavailable — the attribute still applies for this page */
  }
}

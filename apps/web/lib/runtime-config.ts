// Browser-facing API base URL, resolved at RUNTIME so one image works anywhere.
// app/layout.tsx (force-dynamic) injects window.__NEXT_PUBLIC_API_URL from the
// server env PAL_PUBLIC_API_URL on every request. The build-time inlined
// NEXT_PUBLIC_API_URL is only the fallback (local dev / compose).
export function runtimeApiUrl(): string | undefined {
  if (typeof window !== "undefined") {
    const injected = (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL;
    if (typeof injected === "string") return injected.replace(/\/+$/, "");
  }
  return process.env.NEXT_PUBLIC_API_URL;
}

// Minimal typed fetch wrapper for /v1/runtime/* endpoints.
//
// The main PalAPI class is method-per-endpoint; the runtime surface is
// small + new + likely to evolve, so we keep it isolated here behind generic
// get/post/del helpers that read auth from the same localStorage slot.

import { isNoSessionPath } from "./no-session-paths";
import { parseSSE } from "./sse";
function baseUrl(): string {
  if (typeof window !== "undefined") {
    return (
      ((window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL as
        | string
        | undefined) ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:8080"
    );
  }
  return (
    process.env.PAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  );
}

function token(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("pal_token");
}

/** Thrown when the API rejects the bearer token (401). Callers can detect
 *  this to drop their cached token and redirect to /login instead of
 *  showing a generic error toast on every poll. */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Non-2xx API response. `status` lets callers map 402/409 to friendly copy. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function purgeTokenAndRedirect() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("pal_token");
    // Clear the HttpOnly cookie via the server-side Route Handler.
    fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
  } catch {
    /* ignore */
  }
  // Avoid bouncing back-and-forth if we're already on /login (or another no-session page).
  if (!isNoSessionPath(window.location.pathname)) {
    const next = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/login?next=${next}`;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    // Stale token (server restart with new JWT_SECRET, expiry, signed-out
    // on another tab, ...). Purge + bounce to login. Throw a typed error
    // so callers can swallow it instead of toasting on every poll.
    purgeTokenAndRedirect();
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `API ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET a text/plain body (file contents). `truncated` mirrors the X-Pal-Truncated header. */
async function getText(path: string): Promise<{ text: string; truncated: boolean }> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${baseUrl()}${path}`, { headers });
  if (res.status === 401) {
    purgeTokenAndRedirect();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `API ${res.status}: ${text || res.statusText}`);
  }
  return { text: await res.text(), truncated: res.headers.get("X-Pal-Truncated") === "true" };
}

/**
 * Read an SSE endpoint with fetch so the bearer token travels as a header (EventSource can't
 * send one, and a cross-origin credentialed EventSource is refused by CORS). Resolves when the
 * server closes the stream; rejects on a non-2xx or a dropped connection. Aborting resolves.
 */
async function streamSSE(path: string, onData: (data: string) => void, signal: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  try {
    const res = await fetch(`${baseUrl()}${path}`, { headers, signal });
    if (res.status === 401) {
      purgeTokenAndRedirect();
      throw new UnauthorizedError();
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `API ${res.status}: ${text || res.statusText}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { frames, rest } = parseSSE(buf + value);
      buf = rest;
      for (const f of frames) onData(f.data);
    }
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }
}

export const runtimeApi = {
  getText,
  streamSSE,
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

"use client";

// OAuth redirect target for MCP servers. The code is exchanged immediately and
// never rendered.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { parseApiError } from "@/lib/mcp";
import { LinkButton } from "@/components/button";

type State = { kind: "working" } | { kind: "ok"; slug: string } | { kind: "fail"; message: string };

function Callback() {
  const q = useSearchParams();
  const [state, setState] = useState<State>({ kind: "working" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // single-use code: never exchange twice
    ran.current = true;
    const code = q.get("code");
    const st = q.get("state");
    const err = q.get("error");
    if (err) { setState({ kind: "fail", message: `Authorization was denied (${err}).` }); return; }
    if (!code || !st) { setState({ kind: "fail", message: "Missing authorization response." }); return; }
    api.completeMcpOAuth(code, st)
      .then((r) => setState({ kind: "ok", slug: r.serverSlug }))
      .catch((e) => setState({ kind: "fail", message: parseApiError(e).message }));
  }, [q]);

  return (
    <div className="rounded-xl border border-line bg-panel p-6" role="status">
      {state.kind === "working" && <p className="text-sm text-fg-2">Completing authorization…</p>}
      {state.kind === "ok" && <p className="text-sm text-ok">Connected <span className="font-mono">{state.slug}</span>.</p>}
      {state.kind === "fail" && <p className="text-sm text-bad">Authorization failed: {state.message}</p>}
      {state.kind !== "working" && (
        <div className="mt-4"><LinkButton href="/settings/mcp" variant="secondary">Back to MCP settings</LinkButton></div>
      )}
    </div>
  );
}

export default function McpCallbackPage() {
  return <Suspense fallback={null}><Callback /></Suspense>;
}

import http from "node:http";

// A stand-in WhatsApp bridge for the pal-space specs. Read-only surface the
// dashboard uses (/health, attention snapshot) plus /send, which records what the
// control-plane delivered so a spec can prove nothing is sent before a confirm.
// Test hooks: GET /__sends, POST /__fail?on=1|0 (next sends return 500).
export interface Sent { to: string; message: string }

export function startFixtureBridge(port: number): Promise<http.Server> {
  const sends: Sent[] = [];
  let failing = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", authRequired: false, version: "fixture" });
    if (req.method === "GET" && /^\/session\/[^/]+\/attention$/.test(url.pathname)) {
      return json(200, {
        generatedAt: Date.now(),
        channel: "whatsapp",
        items: [{ n: 1, ref: "thread", id: "t-madhu", icon: "⏳", label: "Madhu has been waiting 3 days", why: "unanswered", defaultAction: "draft" }],
        counts: { waiting: 1, drafts: 0, commitments: 0 },
      });
    }
    if (req.method === "GET" && url.pathname === "/__sends") return json(200, sends);
    if (req.method === "POST" && url.pathname === "/__fail") {
      failing = url.searchParams.get("on") === "1";
      return json(200, { failing });
    }
    if (req.method === "POST" && /^\/session\/[^/]+\/send$/.test(url.pathname)) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (failing) return json(500, { error: "fixture: send refused" });
        try {
          const b = JSON.parse(raw) as Sent;
          sends.push({ to: b.to, message: b.message });
          json(200, { ok: true });
        } catch {
          json(400, { error: "bad json" });
        }
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

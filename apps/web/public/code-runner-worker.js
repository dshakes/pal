// Snippet runner for lib/code-runner.ts. Served with its own CSP
// (next.config.ts: default-src 'none'; script-src 'unsafe-eval'), so code run
// here can evaluate but cannot fetch, import or open sockets: assistant/LLM
// output must never be able to call the API with the user's session cookie.
const logs = [];
function fmt(a) { try { return (a !== null && typeof a === "object") ? JSON.stringify(a, null, 2) : String(a); } catch (_) { return String(a); } }
const sandboxConsole = {
  log: (...a) => logs.push(a.map(fmt).join(" ")),
  error: (...a) => logs.push("[error] " + a.map(fmt).join(" ")),
  warn: (...a) => logs.push("[warn] " + a.map(fmt).join(" ")),
  info: (...a) => logs.push(a.map(fmt).join(" ")),
};
self.onmessage = (e) => {
  try {
    const fn = new Function("console", e.data);
    const result = fn(sandboxConsole);
    if (result !== undefined && logs.length === 0) logs.push(fmt(result));
    self.postMessage({ ok: true, output: logs.join("\n") || "(no output)" });
  } catch (err) {
    self.postMessage({ ok: false, output: (err && err.message) ? err.message : String(err) });
  }
};

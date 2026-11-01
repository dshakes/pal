// JSON → highlighted HTML for the run Data panel. Escapes FIRST (run I/O is
// attacker-controlled), then wraps tokens in ONE pass. The old version ran a
// number pass after the string pass and matched the "400" inside its own
// `text-blue-400` class names, rendering `400">"version"` garbage.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TOKEN = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;

export function highlightJson(json: string): string {
  return escapeHtml(json).replace(TOKEN, (m, str: string | undefined, colon: string | undefined, bool, nul, num) => {
    if (str !== undefined) return colon ? `<span class="text-fg-2">${str}</span>${colon}` : `<span class="text-ok">${str}</span>`;
    if (bool) return `<span class="text-warn">${bool}</span>`;
    if (nul) return `<span class="text-fg-3">${nul}</span>`;
    if (num) return `<span class="text-accent">${num}</span>`;
    return m;
  });
}

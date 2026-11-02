// ---------------------------------------------------------------------------
// Code Runner — lightweight browser-based code execution
//
// JavaScript: runs via new Function() in a sandboxed scope
// Python/SQL: shows a message that the sandbox runtime is required
// ---------------------------------------------------------------------------

export type CodeLanguage = "javascript" | "python" | "sql";

export interface CodeRunResult {
  output: string;
  error: boolean;
  duration: number;
}

export function detectLanguage(code: string): CodeLanguage {
  const trimmed = code.trim().toLowerCase();
  if (trimmed.startsWith("select ") || trimmed.startsWith("insert ") || trimmed.startsWith("update ") || trimmed.startsWith("delete ") || trimmed.startsWith("create ") || trimmed.startsWith("alter ")) return "sql";
  if (/\bdef\s+\w+|import\s+\w+|print\s*\(|from\s+\w+\s+import/.test(trimmed)) return "python";
  return "javascript";
}

export async function runCode(code: string, language: CodeLanguage): Promise<CodeRunResult> {
  const start = Date.now();

  if (language === "python") {
    return { output: "Python execution requires the sandbox runtime. Deploy to your cloud to enable.", error: false, duration: Date.now() - start };
  }
  if (language === "sql") {
    return { output: "SQL execution requires the sandbox runtime. Deploy to your cloud to enable.", error: false, duration: Date.now() - start };
  }

  // JavaScript: execute inside a Web Worker, NOT on the main thread. The
  // snippets we run here can come from assistant/LLM output (a prompt-injected
  // agent could emit hostile JS). A Worker has no DOM and no `window`, and
  // public/code-runner-worker.js is served with a CSP that forbids every
  // network fetch, so executed code cannot use the session cookie to call the
  // API (the /api/pal proxy would otherwise accept a same-origin worker fetch).
  // Hard timeout + terminate.
  return runJsInWorker(code, start);
}

const WORKER_TIMEOUT_MS = 2000;

function runJsInWorker(code: string, start: number): Promise<CodeRunResult> {
  // SSR / no-Worker guard.
  if (typeof Worker === "undefined") {
    return Promise.resolve({
      output: "Sandbox unavailable (no Worker support in this environment).",
      error: true,
      duration: Date.now() - start,
    });
  }
  return new Promise<CodeRunResult>((resolve) => {
    let worker: Worker | null = null;
    let settled = false;
    const finish = (r: CodeRunResult) => {
      if (settled) return;
      settled = true;
      try { worker?.terminate(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ output: `Execution timed out (${WORKER_TIMEOUT_MS}ms)`, error: true, duration: Date.now() - start }),
      WORKER_TIMEOUT_MS,
    );
    try {
      // A real URL (not a blob:) so the worker gets its own no-network CSP.
      worker = new Worker("/code-runner-worker.js");
      worker.onmessage = (e: MessageEvent<{ ok: boolean; output: string }>) => {
        clearTimeout(timer);
        finish({ output: e.data.output, error: !e.data.ok, duration: Date.now() - start });
      };
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer);
        finish({ output: e.message || "Sandbox worker error", error: true, duration: Date.now() - start });
      };
      worker.postMessage(code);
    } catch (err) {
      clearTimeout(timer);
      finish({ output: "Sandbox unavailable: " + (err instanceof Error ? err.message : String(err)), error: true, duration: Date.now() - start });
    }
  });
}

/** Extract code blocks from markdown text. Returns array of {language, code} pairs. */
export function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || "text", code: match[2].trim() });
  }
  return blocks;
}

// A2A v0.3 client surface: paths, JSON-RPC envelope, error mapping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PalClient, PalApiError } from "../src/client.js";

const realFetch = globalThis.fetch;
const task = { kind: "task", id: "t1", contextId: "c1", status: { state: "completed" } };

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockImplementation(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}
function lastCall() {
  const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe("client.a2a", () => {
  let client: PalClient;
  beforeEach(() => {
    client = new PalClient({ apiKey: "k", baseUrl: "http://x" });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("getCard GETs the well-known card", async () => {
    mockFetch({ protocolVersion: "0.3.0", name: "a b", url: "u" });
    const card = await client.a2a.getCard("a b");
    expect(lastCall().url).toBe("http://x/v1/agents/a%20b/a2a/.well-known/agent-card.json");
    expect(card.protocolVersion).toBe("0.3.0");
  });

  it("sendMessage posts message/send with blocking", async () => {
    mockFetch({ jsonrpc: "2.0", id: 1, result: task });
    const t = await client.a2a.sendMessage("bot", "hi", { blocking: true });
    const { url, init, body } = lastCall();
    expect(url).toBe("http://x/v1/agents/bot/a2a");
    expect(init.method).toBe("POST");
    expect(body.method).toBe("message/send");
    expect(body.params.message.parts).toEqual([{ kind: "text", text: "hi" }]);
    expect(body.params.configuration).toEqual({ blocking: true });
    expect(t.id).toBe("t1");
  });

  it("getTask and cancelTask use the right methods", async () => {
    mockFetch({ result: task });
    await client.a2a.getTask("bot", "t1");
    expect(lastCall().body).toMatchObject({ method: "tasks/get", params: { id: "t1" } });
    await client.a2a.cancelTask("bot", "t1");
    expect(lastCall().body).toMatchObject({ method: "tasks/cancel", params: { id: "t1" } });
  });

  it("JSON-RPC error raises PalApiError with code", async () => {
    mockFetch({ error: { code: -32001, message: "task not found" } });
    const err = await client.a2a.getTask("bot", "zz").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PalApiError);
    expect((err as PalApiError).code).toBe(-32001);
    expect((err as PalApiError).body).toBe("task not found");
  });

  it("transport errors surface the HTTP status", async () => {
    mockFetch({}, 404);
    const err = await client.a2a.getCard("nope").catch((e: unknown) => e);
    expect((err as PalApiError).status).toBe(404);
  });
});

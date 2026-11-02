import test from "node:test";
import assert from "node:assert/strict";
import { runtimeApiUrl } from "./runtime-config.ts";

test("runtimeApiUrl: window global (runtime) beats the build-time env; empty string = same origin", () => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8080";
  assert.equal(runtimeApiUrl(), "http://localhost:8080");
  (globalThis as Record<string, unknown>).window = { __NEXT_PUBLIC_API_URL: "https://api.acme.example/" };
  assert.equal(runtimeApiUrl(), "https://api.acme.example");
  (globalThis as Record<string, unknown>).window = { __NEXT_PUBLIC_API_URL: "" };
  assert.equal(runtimeApiUrl(), "");
  delete (globalThis as Record<string, unknown>).window;
});

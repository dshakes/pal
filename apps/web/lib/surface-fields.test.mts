import test from "node:test";
import assert from "node:assert/strict";
import { validateFields } from "./surface-fields.ts";
import { REDACTED } from "./redacted.ts";

const bot = { key: "botToken", label: "Bot Token", type: "password", required: true, prefix: "xoxb-", minLength: 20 };

test("a new secret must meet its rules", () => {
  assert.ok(validateFields({ botToken: "short" }, [bot]).botToken);
  assert.ok(validateFields({ botToken: "abcdefghijklmnopqrstuvwxyz" }, [bot]).botToken); // no prefix
  assert.ok(validateFields({}, [bot]).botToken); // required
  assert.deepEqual(validateFields({ botToken: "xoxb-abcdefghijklmnopqrstu" }, [bot]), {});
});

test("an unchanged (masked) stored secret passes, so re-saving the form works", () => {
  assert.deepEqual(validateFields({ botToken: REDACTED }, [bot]), {});
});

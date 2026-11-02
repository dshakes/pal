import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustFyiDue, markTrustFyi } from "./trust-list-fyi.ts";

test("FYI fires once per distinct list, not on every restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "trustfyi-"));
  assert.equal(trustFyiDue(dir, []), false);
  assert.equal(trustFyiDue(dir, ["shiva", "madhu"]), true);
  markTrustFyi(dir, ["shiva", "madhu"]);
  assert.equal(trustFyiDue(dir, ["madhu", "shiva"]), false); // same set, any order
  assert.equal(trustFyiDue(dir, ["shiva"]), true); // list changed
  assert.equal((statSync(join(dir, "trust-list.hash")).mode & 0o777), 0o600);
});

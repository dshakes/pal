import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildQRLink } from "./qr-link.ts";

test("telegram QR is the real bot deep link, or nothing", () => {
  assert.equal(buildQRLink({ type: "telegram", botUsername: "@my_support_bot" }), "https://t.me/my_support_bot?start=connect");
  assert.equal(buildQRLink({ type: "telegram" }), null, "no fabricated default bot");
  assert.equal(buildQRLink({ type: "telegram", botUsername: "evil/../x" }), null);
});

test("whatsapp QR needs a real number", () => {
  assert.equal(buildQRLink({ type: "whatsapp", phoneNumber: "+1 (512) 555-1234" }), "https://wa.me/15125551234?text=Connect%20to%20PAL");
  assert.equal(buildQRLink({ type: "whatsapp" }), null);
});

// S-12: the browser must never mint a pairing token. Device pairing codes come
// from POST /v1/bridges/enroll (Settings → Devices).
test("no browser-minted pairing token or /pair link remains", () => {
  for (const f of ["components/qr-code.tsx", "lib/qr-link.ts", "app/(dashboard)/surfaces/page.tsx"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /generatePairingToken|Math\.random/, f);
    assert.doesNotMatch(src, /\/pair\?token=\$\{/, f);
  }
});

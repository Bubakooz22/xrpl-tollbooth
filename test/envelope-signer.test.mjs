// End-to-end tests for envelope-signer.mjs.
// Covers happy-path signing/verification and the failure modes that
// v0.8 verifiers in the wild will hit.

import crypto from "node:crypto";
import assert from "node:assert/strict";
import {
  signEnvelope,
  verifyEnvelope,
  computeEnvelopeHash,
  generateSigningKey,
  rawEd25519PublicKeyToPem,
} from "../lib/envelope-signer.mjs";

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${label}`); }
}

// --- Setup: one active key, one retired key -------------------------------
const active = generateSigningKey();
const retired = generateSigningKey();

const activeKey = { key_id: "tollbooth-2026-q3-01", private_key_pem: active.privateKeyPem };
const retiredKey = { key_id: "tollbooth-2026-q2-01", private_key_pem: retired.privateKeyPem };

const publicKeyPems = new Map([
  [activeKey.key_id, active.publicKeyPem],
  [retiredKey.key_id, retired.publicKeyPem],
]);
const resolvePubkey = (kid) => publicKeyPems.get(kid) || null;

// --- Happy path -----------------------------------------------------------
const baseEnvelope = {
  version: "0.8",
  endpoint: "/wallet-risk",
  request_hash: "abc123",
  risk_level: "critical",
  reason_codes: [
    {
      code: "OFAC_SANCTIONED",
      severity: "critical",
      override_permitted: false,
      source: "https://ofac.treasury.gov/specially-designated-nationals-list",
    },
  ],
  human: "This address is on the OFAC SDN list.",
  fulfillment_status: "complete",
  retry_permitted: false,
  retry_after_seconds: null,
  issued_at: "2026-08-26T13:30:00.000Z",
  expires_at: "2026-08-27T13:30:00.000Z",
};

const signed = signEnvelope(baseEnvelope, activeKey);
ok("signed body has envelope+signature", signed.envelope && signed.signature);
ok("signature is Ed25519", signed.signature.alg === "Ed25519");
ok("signature carries key_id", signed.signature.key_id === activeKey.key_id);
ok("signature base64 decodes to 64 bytes",
   Buffer.from(signed.signature.value, "base64").length === 64);
ok("envelope has envelope_hash", typeof signed.envelope.envelope_hash === "string");
ok("envelope has signing_key_id set", signed.envelope.signing_key_id === activeKey.key_id);

// verify should pass with the correct resolver.
const v1 = verifyEnvelope(signed, resolvePubkey);
ok("verify passes on well-formed envelope", v1.valid === true);

// --- envelope_hash is stable across the "strip and recompute" round-trip --
const stripped = { ...signed.envelope };
delete stripped.envelope_hash;
const recomputed = computeEnvelopeHash(stripped);
ok("envelope_hash stable after strip+recompute",
   recomputed === signed.envelope.envelope_hash);

// --- Tampering detection --------------------------------------------------
// (a) Modify the risk_level after signing. envelope_hash still matches (attacker
// re-derives it), but the signature won't verify against the modified content.
const tampered1 = JSON.parse(JSON.stringify(signed));
tampered1.envelope.risk_level = "low";
tampered1.envelope.envelope_hash = computeEnvelopeHash(tampered1.envelope);
const v2 = verifyEnvelope(tampered1, resolvePubkey);
ok("verify fails when envelope tampered (post-hash rebuild)",
   v2.valid === false && v2.reason === "signature verification failed");

// (b) Modify a field without updating envelope_hash. Should fail on hash check.
const tampered2 = JSON.parse(JSON.stringify(signed));
tampered2.envelope.risk_level = "low";
const v3 = verifyEnvelope(tampered2, resolvePubkey);
ok("verify fails when envelope_hash stale", v3.valid === false && v3.reason.startsWith("envelope_hash mismatch"));

// (c) Unknown key_id.
const tampered3 = JSON.parse(JSON.stringify(signed));
tampered3.envelope.signing_key_id = "tollbooth-2099-q4-99";
tampered3.signature.key_id = "tollbooth-2099-q4-99";
tampered3.envelope.envelope_hash = computeEnvelopeHash(tampered3.envelope);
const v4 = verifyEnvelope(tampered3, resolvePubkey);
ok("verify fails with unknown key_id",
   v4.valid === false && v4.reason.startsWith("unknown signing key"));

// (d) signing_key_id / signature.key_id mismatch.
const tampered4 = JSON.parse(JSON.stringify(signed));
tampered4.signature.key_id = retiredKey.key_id;
const v5 = verifyEnvelope(tampered4, resolvePubkey);
ok("verify fails when signing_key_id and signature.key_id disagree",
   v5.valid === false && v5.reason.startsWith("signing_key_id mismatch"));

// --- signEnvelope rejects preloaded envelope_hash/signature ---------------
try {
  signEnvelope({ ...baseEnvelope, envelope_hash: "deadbeef" }, activeKey);
  fail++; console.error("FAIL: signEnvelope with preloaded envelope_hash should throw");
} catch { pass++; }
try {
  signEnvelope({ ...baseEnvelope, signature: {} }, activeKey);
  fail++; console.error("FAIL: signEnvelope with preloaded signature should throw");
} catch { pass++; }

// --- signEnvelope enforces signing_key_id match ---------------------------
try {
  signEnvelope({ ...baseEnvelope, signing_key_id: "some-other" }, activeKey);
  fail++; console.error("FAIL: signing_key_id mismatch should throw");
} catch { pass++; }

// --- rawEd25519PublicKeyToPem round-trip ----------------------------------
{
  const pemFromRaw = rawEd25519PublicKeyToPem(active.publicKeyBase64);
  const pubFromRawPem = crypto.createPublicKey(pemFromRaw);
  const pubFromNativePem = crypto.createPublicKey(active.publicKeyPem);
  const derA = pubFromRawPem.export({ type: "spki", format: "der" });
  const derB = pubFromNativePem.export({ type: "spki", format: "der" });
  ok("raw base64 pubkey inflates to same SPKI as native PEM", derA.equals(derB));

  // And verification succeeds when the resolver returns the raw-derived PEM.
  const rawResolver = (kid) => (kid === activeKey.key_id ? pemFromRaw : null);
  const v6 = verifyEnvelope(signed, rawResolver);
  ok("verify passes when resolver returns raw-derived PEM", v6.valid === true);
}

// --- retired key can still verify its historic envelope ------------------
{
  const historic = signEnvelope(baseEnvelope, retiredKey);
  const vHist = verifyEnvelope(historic, resolvePubkey);
  ok("retired key envelope still verifies", vHist.valid === true);
}

console.log(`envelope-signer: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

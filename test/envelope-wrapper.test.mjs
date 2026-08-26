// envelope-wrapper unit tests.
//
// Verifies request_hash determinism, version negotiation, risk-field
// extraction, and end-to-end wrap → verify round-trips.

import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import {
  shouldWrapInEnvelope,
  computeRequestHash,
  extractRiskFields,
  buildHumanSummary,
  wrapInEnvelope,
  V08_ACCEPT_MIME,
} from "../lib/envelope-wrapper.mjs";
import { verifyEnvelope } from "../lib/envelope-signer.mjs";

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

function makeSigningKey(key_id = "tb-test-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    key_id,
    private_key_pem: privateKey.export({ format: "pem", type: "pkcs8" }),
    public_key_pem: publicKey.export({ format: "pem", type: "spki" }),
  };
}

// -----------------------------------------------------------------------------
// shouldWrapInEnvelope — version negotiation
// -----------------------------------------------------------------------------

t("shouldWrapInEnvelope: no Accept header → false", () => {
  assert.equal(shouldWrapInEnvelope({ headers: {} }), false);
});

t("shouldWrapInEnvelope: Accept application/json → false", () => {
  assert.equal(shouldWrapInEnvelope({ headers: { accept: "application/json" } }), false);
});

t("shouldWrapInEnvelope: Accept */* → false", () => {
  assert.equal(shouldWrapInEnvelope({ headers: { accept: "*/*" } }), false);
});

t("shouldWrapInEnvelope: Accept v0.7 vendor MIME → false", () => {
  assert.equal(
    shouldWrapInEnvelope({
      headers: { accept: "application/vnd.tollbooth.v0.7+json" },
    }),
    false,
  );
});

t("shouldWrapInEnvelope: Accept v0.8 vendor MIME → true", () => {
  assert.equal(
    shouldWrapInEnvelope({ headers: { accept: V08_ACCEPT_MIME } }),
    true,
  );
});

t("shouldWrapInEnvelope: Accept with v0.8 among multiple → true", () => {
  assert.equal(
    shouldWrapInEnvelope({
      headers: { accept: `application/json, ${V08_ACCEPT_MIME};q=0.9` },
    }),
    true,
  );
});

// -----------------------------------------------------------------------------
// computeRequestHash — determinism
// -----------------------------------------------------------------------------

t("computeRequestHash: byte-identical bodies → same hash", () => {
  const h1 = computeRequestHash({ address: "0xabc", chain: "eth" });
  const h2 = computeRequestHash({ address: "0xabc", chain: "eth" });
  assert.equal(h1, h2);
});

t("computeRequestHash: key order doesn't matter (canonical JSON)", () => {
  const h1 = computeRequestHash({ address: "0xabc", chain: "eth" });
  const h2 = computeRequestHash({ chain: "eth", address: "0xabc" });
  assert.equal(h1, h2);
});

t("computeRequestHash: different fields → different hash", () => {
  const h1 = computeRequestHash({ address: "0xabc" });
  const h2 = computeRequestHash({ address: "0xdef" });
  assert.notEqual(h1, h2);
});

t("computeRequestHash: undefined/null body → hash of {}", () => {
  const empty = computeRequestHash({});
  assert.equal(computeRequestHash(undefined), empty);
  assert.equal(computeRequestHash(null), empty);
});

t("computeRequestHash: output is 64 lowercase hex chars", () => {
  const h = computeRequestHash({ x: 1 });
  assert.match(h, /^[a-f0-9]{64}$/);
});

// -----------------------------------------------------------------------------
// extractRiskFields — legacy → envelope shape
// -----------------------------------------------------------------------------

t("extractRiskFields: preserves risk_level", () => {
  const { risk_level } = extractRiskFields({ risk_level: "critical", reason_codes: [] });
  assert.equal(risk_level, "critical");
});

t("extractRiskFields: missing risk_level → 'unknown'", () => {
  const { risk_level } = extractRiskFields({});
  assert.equal(risk_level, "unknown");
});

t("extractRiskFields: normalizes reason codes with override_permitted", () => {
  const { reason_codes } = extractRiskFields({
    reason_codes: [
      { code: "OFAC_SANCTIONED", severity: "critical", source: "us-treasury-sdn", evidence: "hit" },
      { code: "STALE_ADDRESS", severity: "medium", source: "onchain_eth" },
    ],
  });
  assert.equal(reason_codes.length, 2);
  assert.equal(reason_codes[0].override_permitted, false, "critical → not permitted");
  assert.equal(reason_codes[1].override_permitted, true, "medium → permitted");
  assert.equal(reason_codes[0].source, "us-treasury-sdn");
  assert.equal(reason_codes[0].evidence, "hit");
});

t("extractRiskFields: respects explicit override_permitted", () => {
  const { reason_codes } = extractRiskFields({
    reason_codes: [
      { code: "X", severity: "critical", override_permitted: true },
    ],
  });
  assert.equal(reason_codes[0].override_permitted, true);
});

t("extractRiskFields: non-array reason_codes → []", () => {
  const { reason_codes } = extractRiskFields({ reason_codes: null });
  assert.deepEqual(reason_codes, []);
});

// -----------------------------------------------------------------------------
// buildHumanSummary — one-sentence descriptions
// -----------------------------------------------------------------------------

t("buildHumanSummary: OFAC critical gets specific line", () => {
  const s = buildHumanSummary("/wallet-risk", "critical", [
    { code: "OFAC_SANCTIONED", severity: "critical" },
  ]);
  assert.match(s, /OFAC/);
  assert.match(s, /Do not send funds/);
});

t("buildHumanSummary: generic critical", () => {
  const s = buildHumanSummary("/wallet-risk", "critical", [
    { code: "CONTRACT_UPGRADEABLE", severity: "critical" },
  ]);
  assert.match(s, /Critical/);
});

t("buildHumanSummary: high/medium/low each render", () => {
  assert.match(buildHumanSummary("/x", "high", []), /Elevated/);
  assert.match(buildHumanSummary("/x", "medium", []), /Moderate/);
  assert.match(buildHumanSummary("/x", "low", []), /Low risk/);
});

// -----------------------------------------------------------------------------
// wrapInEnvelope — full round trip
// -----------------------------------------------------------------------------

t("wrapInEnvelope: produces spec-compliant envelope + signature", () => {
  const key = makeSigningKey("tb-2026-08a");
  const result = {
    chain: "eth",
    address: "0x7F367cC41522cE07553e823bf3be79A889DEbe1B",
    risk_level: "critical",
    reason_codes: [
      { code: "OFAC_SANCTIONED", severity: "critical", source: "us-treasury-sdn", evidence: "hit" },
    ],
  };
  const body = { address: result.address, chain: "eth" };

  const wrapped = wrapInEnvelope({
    endpoint: "/wallet-risk",
    requestBody: body,
    result,
    signingKey: key,
  });

  // Envelope shape
  assert.equal(wrapped.envelope.version, "0.8");
  assert.equal(wrapped.envelope.endpoint, "/wallet-risk");
  assert.equal(wrapped.envelope.risk_level, "critical");
  assert.equal(wrapped.envelope.reason_codes.length, 1);
  assert.equal(wrapped.envelope.reason_codes[0].override_permitted, false);
  assert.equal(wrapped.envelope.fulfillment_status, "complete");
  assert.equal(wrapped.envelope.retry_permitted, false);
  assert.equal(wrapped.envelope.signing_key_id, "tb-2026-08a");
  assert.match(wrapped.envelope.request_hash, /^[a-f0-9]{64}$/);
  assert.match(wrapped.envelope.envelope_hash, /^[a-f0-9]{64}$/);

  // Signature shape
  assert.equal(wrapped.signature.alg, "Ed25519");
  assert.equal(wrapped.signature.key_id, "tb-2026-08a");
  assert.match(wrapped.signature.value, /^[A-Za-z0-9+/]+=*$/);
});

t("wrapInEnvelope: signature verifies with the paired public key", () => {
  const key = makeSigningKey();
  const wrapped = wrapInEnvelope({
    endpoint: "/wallet-risk",
    requestBody: { address: "0xabc", chain: "eth" },
    result: { risk_level: "low", reason_codes: [] },
    signingKey: key,
  });

  const v = verifyEnvelope(wrapped, (keyId) => (keyId === key.key_id ? key.public_key_pem : null));
  assert.equal(v.valid, true);
});

t("wrapInEnvelope: tampering the envelope invalidates the signature", () => {
  const key = makeSigningKey();
  const wrapped = wrapInEnvelope({
    endpoint: "/wallet-risk",
    requestBody: { address: "0xabc", chain: "eth" },
    result: { risk_level: "critical", reason_codes: [{ code: "OFAC_SANCTIONED", severity: "critical" }] },
    signingKey: key,
  });

  // Attacker rewrites risk_level. envelope_hash + signature stay old.
  const tampered = {
    envelope: { ...wrapped.envelope, risk_level: "low" },
    signature: wrapped.signature,
  };
  const v = verifyEnvelope(tampered, (keyId) => (keyId === key.key_id ? key.public_key_pem : null));
  assert.equal(v.valid, false);
});

t("wrapInEnvelope: identical inputs → identical envelope (idempotency ready)", () => {
  const key = makeSigningKey();
  const fixed = "2026-08-26T14:00:00.000Z";
  const body = { address: "rABC", chain: "xrpl" };
  const result = { risk_level: "low", reason_codes: [] };

  const w1 = wrapInEnvelope({ endpoint: "/wallet-risk", requestBody: body, result, signingKey: key, issuedAt: fixed });
  const w2 = wrapInEnvelope({ endpoint: "/wallet-risk", requestBody: body, result, signingKey: key, issuedAt: fixed });

  assert.equal(w1.envelope.request_hash, w2.envelope.request_hash);
  assert.equal(w1.envelope.envelope_hash, w2.envelope.envelope_hash);
  assert.equal(w1.signature.value, w2.signature.value);
});

t("wrapInEnvelope: expires_at = issued_at + ttlSeconds", () => {
  const key = makeSigningKey();
  const issued = "2026-08-26T14:00:00.000Z";
  const wrapped = wrapInEnvelope({
    endpoint: "/wallet-risk",
    requestBody: {},
    result: { risk_level: "low", reason_codes: [] },
    signingKey: key,
    ttlSeconds: 60,
    issuedAt: issued,
  });
  assert.equal(wrapped.envelope.expires_at, "2026-08-26T14:01:00.000Z");
});

t("wrapInEnvelope: throws on missing signingKey", () => {
  assert.throws(
    () =>
      wrapInEnvelope({
        endpoint: "/wallet-risk",
        requestBody: {},
        result: { risk_level: "low", reason_codes: [] },
        signingKey: null,
      }),
    /signingKey/,
  );
});

// -----------------------------------------------------------------------------

console.log(`envelope-wrapper: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

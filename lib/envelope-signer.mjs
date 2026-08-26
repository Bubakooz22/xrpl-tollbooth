// v0.8 response envelope signer.
//
// Given a v0.8 envelope object (WITHOUT envelope_hash or signature), produces
// a signed envelope response body ready to send to the caller.
//
// Signing pipeline (spec: docs/response-envelope-v0.8.md):
//   1. Take the envelope object minus envelope_hash and minus signature.
//   2. Canonicalize (RFC 8785).
//   3. envelope_hash = sha256_hex(canonical bytes).
//   4. Insert envelope_hash into the envelope object.
//   5. Canonicalize again (now including envelope_hash).
//   6. Ed25519.sign(canonical bytes with envelope_hash) -> 64-byte signature.
//   7. Assemble {envelope, signature} response.
//
// The double-canonicalization ensures:
//   - envelope_hash is stable and can be recomputed by anyone who has the
//     envelope minus the hash field (and validated against the field).
//   - The signature covers envelope_hash itself, so a mismatch between the
//     stored hash and the signed content is detectable.

import crypto from "node:crypto";
import { canonicalize, canonicalizeToBuffer } from "./canonical-json.mjs";

/**
 * Compute the envelope_hash: sha256 (hex) of canonical(envelope - envelope_hash - signature).
 *
 * @param {object} envelope - envelope object (may or may not contain envelope_hash/signature; both stripped)
 * @returns {string} lowercase hex sha256
 */
export function computeEnvelopeHash(envelope) {
  const { envelope_hash: _drop1, signature: _drop2, ...rest } = envelope;
  const canonical = canonicalizeToBuffer(rest);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Sign a v0.8 envelope.
 *
 * @param {object} envelope - Envelope fields WITHOUT envelope_hash or signature.
 *                            Must include signing_key_id matching the private key's key_id.
 * @param {object} signingKey - { key_id, private_key_pem } — Ed25519 private key as PEM string.
 * @returns {{ envelope: object, signature: { alg: "Ed25519", key_id: string, value: string } }}
 *          The complete v0.8 signed envelope response body.
 */
export function signEnvelope(envelope, signingKey) {
  if (!signingKey || !signingKey.key_id || !signingKey.private_key_pem) {
    throw new Error("envelope-signer: signingKey requires { key_id, private_key_pem }");
  }
  if (envelope.signing_key_id && envelope.signing_key_id !== signingKey.key_id) {
    throw new Error(
      `envelope-signer: signing_key_id mismatch (envelope=${envelope.signing_key_id}, key=${signingKey.key_id})`,
    );
  }
  if (envelope.envelope_hash !== undefined) {
    throw new Error("envelope-signer: envelope must not carry envelope_hash before signing");
  }
  if (envelope.signature !== undefined) {
    throw new Error("envelope-signer: envelope must not carry signature before signing");
  }

  // Step 1: envelope with signing_key_id set (belt-and-braces).
  const base = { ...envelope, signing_key_id: signingKey.key_id };

  // Step 2-3: compute envelope_hash over the envelope minus itself.
  const envelope_hash = computeEnvelopeHash(base);

  // Step 4: insert.
  const full = { ...base, envelope_hash };

  // Step 5-6: canonicalize including envelope_hash, then sign.
  const signingInput = canonicalizeToBuffer(full);
  const privateKey = crypto.createPrivateKey(signingKey.private_key_pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `envelope-signer: expected ed25519 private key, got ${privateKey.asymmetricKeyType}`,
    );
  }
  const sigBytes = crypto.sign(null, signingInput, privateKey); // Ed25519: algorithm arg must be null
  const signature = {
    alg: "Ed25519",
    key_id: signingKey.key_id,
    value: sigBytes.toString("base64"),
  };

  return { envelope: full, signature };
}

/**
 * Verify a v0.8 signed envelope response body.
 *
 * @param {{envelope: object, signature: {alg,key_id,value}}} response - The full signed body.
 * @param {(keyId: string) => (string|null)} resolvePublicKeyPem - Looks up PEM by key_id
 *        (null => unknown key).
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function verifyEnvelope(response, resolvePublicKeyPem) {
  if (!response || typeof response !== "object") {
    return { valid: false, reason: "missing response body" };
  }
  const { envelope, signature } = response;
  if (!envelope || !signature) {
    return { valid: false, reason: "missing envelope or signature" };
  }
  if (signature.alg !== "Ed25519") {
    return { valid: false, reason: `unsupported alg ${signature.alg}` };
  }
  if (!signature.key_id || !signature.value) {
    return { valid: false, reason: "signature.key_id and signature.value required" };
  }
  if (envelope.signing_key_id !== signature.key_id) {
    return {
      valid: false,
      reason: `signing_key_id mismatch (${envelope.signing_key_id} vs ${signature.key_id})`,
    };
  }
  if (!envelope.envelope_hash) {
    return { valid: false, reason: "envelope missing envelope_hash" };
  }

  // Recompute envelope_hash and compare.
  const recomputed = computeEnvelopeHash(envelope);
  if (recomputed !== envelope.envelope_hash) {
    return {
      valid: false,
      reason: `envelope_hash mismatch (got ${envelope.envelope_hash}, computed ${recomputed})`,
    };
  }

  // Resolve the pubkey.
  const pem = resolvePublicKeyPem(signature.key_id);
  if (!pem) {
    return { valid: false, reason: `unknown signing key ${signature.key_id}` };
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch (e) {
    return { valid: false, reason: `invalid pubkey PEM: ${e.message}` };
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    return { valid: false, reason: `expected ed25519, got ${publicKey.asymmetricKeyType}` };
  }

  // Verify signature over canonical envelope (with envelope_hash included).
  const signingInput = canonicalizeToBuffer(envelope);
  const sigBytes = Buffer.from(signature.value, "base64");
  const ok = crypto.verify(null, signingInput, publicKey, sigBytes);
  if (!ok) return { valid: false, reason: "signature verification failed" };

  return { valid: true };
}

/**
 * Utility: generate a new Ed25519 keypair.
 * Returns { publicKeyPem, privateKeyPem, publicKeyBase64 (raw 32-byte spki) }.
 * The base64 form is what appears in /.well-known/tollbooth-keys.json.
 */
export function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  // Raw 32-byte ed25519 pubkey lives at the tail of the DER SPKI.
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = der.slice(der.length - 32);
  return {
    publicKeyPem,
    privateKeyPem,
    publicKeyBase64: raw.toString("base64"),
  };
}

/**
 * Convert a raw 32-byte Ed25519 public key (base64) into a PEM the Node
 * crypto module accepts. The published /.well-known/tollbooth-keys.json
 * uses the raw 32-byte form; verifiers need to inflate it before crypto.verify.
 *
 * @param {string} rawBase64 - 32-byte pubkey, base64-encoded
 * @returns {string} PEM SPKI
 */
export function rawEd25519PublicKeyToPem(rawBase64) {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) {
    throw new Error(`ed25519 raw pubkey must be 32 bytes, got ${raw.length}`);
  }
  // SPKI prefix for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const spki = Buffer.concat([prefix, raw]);
  const b64 = spki.toString("base64");
  // Wrap at 64 chars per PEM convention.
  const wrapped = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

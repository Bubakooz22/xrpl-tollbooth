// Semantic request digest for pre-authorization envelopes.
//
// Contract:
//   requestDigest(obj) = sha256(canonicalize(obj))  // hex, lowercase
//
// This is the wire-visible identity of a request as bound into a
// PreAuthEnvelope's `request_digest` field. Two inputs that canonicalize
// to the same bytes MUST produce the same digest. Two inputs that differ
// in any non-excluded field MUST produce different digests.

import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.mjs';

/**
 * Compute the semantic request digest for a JSON-serializable value.
 * @param {*} value
 * @returns {string} lowercase hex-encoded SHA-256 digest
 */
export function requestDigest(value) {
  const canonical = canonicalize(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Strip volatile / transport fields before hashing.
 *
 * The v0.9 spec defines these as excluded from the semantic identity
 * of a request. See specs/pre-authorization-v0.9.md § "Canonicalization"
 * for the authoritative list.
 *
 * @param {object} obj - request object
 * @returns {object} shallow copy with volatile fields removed
 */
export const V09_VOLATILE_FIELDS = Object.freeze([
  'nonce_client',
  'timestamp_ms',
  'trace_id',
  '__sig',
  '__timestamp',
]);

export function stripVolatile(obj, fields = V09_VOLATILE_FIELDS) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (fields.includes(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

/**
 * Digest a request with volatile fields stripped.
 * This is the operation callers should use when producing or verifying
 * a PreAuthEnvelope's `request_digest` field.
 * @param {object} obj
 * @param {string[]} [volatileFields]
 * @returns {string} hex digest
 */
export function preAuthRequestDigest(obj, volatileFields) {
  return requestDigest(stripVolatile(obj, volatileFields));
}

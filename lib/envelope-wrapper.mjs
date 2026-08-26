// v0.8 envelope wrapper — maps legacy handler return values into the
// signed response envelope shape defined in docs/response-envelope-v0.8.md.
//
// Two responsibilities:
//   1. Compute request_hash over the canonical JSON of the request body
//      (so byte-identical requests produce byte-identical envelopes).
//   2. Assemble the envelope + call the signer, returning the wire-format
//      { envelope, signature } object ready to serialize.
//
// This module is version-negotiation-aware: `shouldWrapInEnvelope(req)`
// inspects the Accept header and returns true only when the caller
// explicitly opted in to v0.8. This is what keeps existing v0.7 callers
// unaffected while the two versions run side-by-side.

import crypto from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";
import { signEnvelope } from "./envelope-signer.mjs";

export const V08_ACCEPT_MIME = "application/vnd.tollbooth.v0.8+json";
export const V08_CONTENT_TYPE = V08_ACCEPT_MIME + "; charset=utf-8";

// Default envelope lifetime. Callers should not treat this as a hard cache
// TTL — it's a signal that the underlying evidence (OFAC lists, chain state)
// may have changed. Idempotent replay of the same request_hash returns the
// same envelope until it expires.
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Decide whether the response should be wrapped in a v0.8 envelope.
 *
 * Version negotiation rules:
 *   - Accept: application/vnd.tollbooth.v0.8+json  → wrap
 *   - Accept: application/vnd.tollbooth.v0.7+json  → do not wrap
 *   - Accept: absent, any wildcard, or application/json → do not wrap (v0.7 default)
 *
 * This gives us a safe rollout: legacy callers see no change until they
 * explicitly opt in. Once every known caller has migrated, we can flip
 * the default at server-config level.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function shouldWrapInEnvelope(req) {
  const accept = req.headers["accept"];
  if (!accept || typeof accept !== "string") return false;
  // Simple substring check — Accept headers can be complex (q-values, multiple
  // types) but for our vendor MIME the substring is unambiguous.
  return accept.includes(V08_ACCEPT_MIME);
}

/**
 * Compute request_hash = sha256_hex(canonical(request_body)).
 *
 * The hash is over the parsed body, not the raw bytes — this way two
 * requests that differ only in whitespace / key order produce the same
 * hash and hit the idempotency cache. Missing/empty body → hash of `{}`.
 *
 * @param {unknown} body — the parsed JSON request body (or {} if none)
 * @returns {string} 64-char lowercase hex
 */
export function computeRequestHash(body) {
  const normalized = body === undefined || body === null ? {} : body;
  const canonical = canonicalize(normalized);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Determine the envelope's risk_level and reason_codes from the raw handler
 * result. Different handlers use slightly different shapes; this normalizer
 * pulls the two envelope-critical fields out.
 *
 * Supports two shapes:
 *   - Risk handlers: { risk_level, reason_codes: [{code, severity, source, evidence}] }
 *     (scoreWallet, scoreContract, simulateTransaction)
 *   - Verification handlers: { verified: bool, reason_codes: [string, ...] }
 *     (verifyPoc). For these:
 *       - risk_level = 'low' when verified=true, 'high' when verified=false
 *       - string reason codes are lifted to { code, severity } objects.
 *         POC_VERIFIED / POC_UNVERIFIED get severity 'info'; error-shaped
 *         codes (COMPILE_ERROR, RPC_UNREACHABLE, ...) get severity 'high'.
 *
 * @param {object} result — return value from any handler
 * @returns {{ risk_level: string, reason_codes: Array<object> }}
 */
export function extractRiskFields(result) {
  const rawCodes = Array.isArray(result?.reason_codes) ? result.reason_codes : [];

  // Verification-shape detection: no risk_level but `verified` is a boolean.
  const isVerificationShape =
    result?.risk_level === undefined && typeof result?.verified === "boolean";

  const risk_level = isVerificationShape
    ? result.verified
      ? "low"
      : "high"
    : result?.risk_level ?? "unknown";

  // Normalize each reason_code into the envelope shape.
  const reason_codes = rawCodes.map((rc) => {
    // String reason codes (from verify-poc) get lifted to objects.
    if (typeof rc === "string") {
      const severity = inferSeverityFromCode(rc);
      return {
        code: rc,
        severity,
        override_permitted: severityAllowsOverride(severity),
      };
    }
    // Object reason codes (from risk handlers) get override_permitted computed.
    const out = {
      code: rc.code,
      severity: rc.severity,
      override_permitted: rc.override_permitted ?? severityAllowsOverride(rc.severity),
    };
    if (rc.source !== undefined) out.source = rc.source;
    if (rc.evidence !== undefined) out.evidence = rc.evidence;
    return out;
  });
  return { risk_level, reason_codes };
}

// Infer severity for verify-poc string codes. POC_VERIFIED is neutral info;
// POC_UNVERIFIED is a real answer (not an error) also info; every other code
// is an execution error the caller cares about.
function inferSeverityFromCode(code) {
  if (code === "POC_VERIFIED" || code === "POC_UNVERIFIED") return "info";
  return "high";
}

// Critical severity → override never permitted. Everything else → permitted
// by default (caller may explicitly proceed with a signed attestation).
function severityAllowsOverride(severity) {
  return severity !== "critical";
}

/**
 * Generate a short human-readable summary line for the envelope.
 *
 * Keep this short — one sentence. Callers may render it directly to a
 * human operator ("Address is OFAC-sanctioned. Do not send funds.").
 *
 * @param {string} endpoint
 * @param {string} risk_level
 * @param {Array<object>} reason_codes
 * @returns {string}
 */
export function buildHumanSummary(endpoint, risk_level, reason_codes) {
  if (risk_level === "critical") {
    // Critical always has at least one code; feature the first one.
    const primary = reason_codes[0]?.code || "CRITICAL_RISK";
    if (primary === "OFAC_SANCTIONED") {
      return "This address is on the OFAC SDN list. Do not send funds.";
    }
    return `Critical risk detected: ${primary}. Do not proceed.`;
  }
  if (risk_level === "high") {
    return "Elevated risk. Review reason codes before proceeding.";
  }
  if (risk_level === "medium") {
    return "Moderate risk. Proceed with caution.";
  }
  if (risk_level === "low") {
    return "Low risk. No known adverse signals.";
  }
  return `Risk level: ${risk_level}.`;
}

/**
 * Wrap a handler result in a signed v0.8 envelope.
 *
 * @param {object} params
 * @param {string} params.endpoint — e.g. "/wallet-risk"
 * @param {object} params.requestBody — parsed JSON request body
 * @param {object} params.result — handler return value (scoreWallet output)
 * @param {object} params.signingKey — { key_id, private_key_pem }
 * @param {number} [params.ttlSeconds] — envelope validity window
 * @param {string} [params.issuedAt] — ISO 8601, defaults to now
 * @returns {{ envelope: object, signature: object }}
 */
export function wrapInEnvelope({
  endpoint,
  requestBody,
  result,
  signingKey,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  issuedAt,
}) {
  if (!signingKey?.key_id || !signingKey?.private_key_pem) {
    throw new Error("wrapInEnvelope: signingKey with {key_id, private_key_pem} required");
  }

  const issued = issuedAt || new Date().toISOString();
  const expires = new Date(Date.parse(issued) + ttlSeconds * 1000).toISOString();

  const { risk_level, reason_codes } = extractRiskFields(result);
  const request_hash = computeRequestHash(requestBody);
  const human = buildHumanSummary(endpoint, risk_level, reason_codes);

  const envelope = {
    version: "0.8",
    endpoint,
    request_hash,
    risk_level,
    reason_codes,
    human,
    fulfillment_status: "complete",
    retry_permitted: false,
    retry_after_seconds: null,
    issued_at: issued,
    expires_at: expires,
    signing_key_id: signingKey.key_id,
  };

  // signEnvelope computes envelope_hash and produces the signature.
  return signEnvelope(envelope, {
    key_id: signingKey.key_id,
    private_key_pem: signingKey.private_key_pem,
  });
}

/**
 * Apply v0.8 envelope wrap to a handler response, or return legacy body.
 *
 * This is the plumbing helper called by every paid endpoint after it
 * computes its handler result. It enforces the three-way gate:
 *   1. statusCode must be 200 (envelope only carries fulfilled results)
 *   2. signingKeys must be loaded (v0.8 flag on)
 *   3. caller opted in via Accept header
 *
 * On sign failure it does NOT throw — it logs, sets a warning header on
 * the response, and returns the legacy body. Callers never lose data.
 *
 * @param {object} params
 * @param {import('node:http').IncomingMessage} params.req
 * @param {import('node:http').ServerResponse} params.res
 * @param {number} params.statusCode
 * @param {string} params.endpoint
 * @param {object} params.requestBody
 * @param {object} params.legacyBody — handler result (v0.7 shape)
 * @param {{active:{key_id,private_key_pem}}|null} params.signingKeys
 * @param {(msg: string) => void} [params.logError]
 * @returns {{ body: object, contentType: string, wrapped: boolean }}
 */
export function maybeWrapResponse({
  req,
  res,
  statusCode,
  endpoint,
  requestBody,
  legacyBody,
  signingKeys,
  logError,
}) {
  const canWrap =
    statusCode === 200 && signingKeys && shouldWrapInEnvelope(req);

  if (!canWrap) {
    return { body: legacyBody, contentType: "application/json", wrapped: false };
  }

  try {
    const wrapped = wrapInEnvelope({
      endpoint,
      requestBody,
      result: legacyBody,
      signingKey: {
        key_id: signingKeys.active.key_id,
        private_key_pem: signingKeys.active.private_key_pem,
      },
    });
    return { body: wrapped, contentType: V08_CONTENT_TYPE, wrapped: true };
  } catch (e) {
    if (logError) logError(`v0.8 envelope wrap failed: ${e.message}`);
    else console.error(`[${endpoint}] v0.8 envelope wrap failed: ${e.message}`);
    // Warning header lets an alert observability layer catch this.
    if (res && !res.headersSent) {
      res.setHeader("X-Tollbooth-V08-Warning", "envelope_wrap_failed");
    }
    return { body: legacyBody, contentType: "application/json", wrapped: false };
  }
}

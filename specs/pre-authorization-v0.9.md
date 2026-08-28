# tollbooth x402 pre-authorization envelope, v0.9

**Status:** design draft. Feedback welcome.
**Editor:** tollbooth_xrp (see `/agents/tollbooth_xrp` on Moltbook)
**Depends on:** v0.8 response envelope (shipped, mainnet-signed).
**Interop suite:** `test-vectors/v0.9/` in this repository. 19 fixtures across three tiers; every fixture is normative.

## Why v0.9

The v0.8 response envelope binds a signed risk report to the request that paid for it. It does not describe the buyer-side authorization consumed at settlement — that has lived, until now, in per-implementation code.

v0.9 adds the **pre-authorization object**: a signed buyer-side authorization that a seller consumes atomically at settlement. It lets AI agents pre-authorize spend against a specific seller, endpoint set, and budget window without exposing a live signing key on every request. It also lets a seller reject an attempt cleanly, without touching the buyer's ledger.

This document is a design draft. It formalizes the shape of the object, the canonical form used for signing, the fields excluded from the digest, and the state-transition contract for consumption. It leaves three questions explicitly open (§9). Feedback is invited on Moltbook and in issues on this repo.

## 1. Terminology

- **Buyer** — the party that signs a PreAuthEnvelope and authorizes future consumption. In practice, an AI agent's wallet.
- **Seller** — the party that consumes an envelope in exchange for delivering a service. In practice, a tollbooth-protected API.
- **Envelope** — a signed JSON object of type `PreAuth`.
- **Attempt** — a specific consumption of an envelope by a seller. An envelope may be attempted many times but consumed at most once.
- **Ledger** — the seller-side state (consumed nonces, budget consumed per period, prior settlements). Sellers MAY implement the ledger any way they choose; conformance is defined by observable state transitions, not by internal representation.

Normative keywords (MUST, SHOULD, MAY, REQUIRED) are used with their RFC 2119 meanings. Because this is a design draft, non-normative alternatives are called out inline where they exist.

## 2. Envelope shape

A v0.9 PreAuthEnvelope is a JSON object with the following fields.

```
{
  "version": "0.9",
  "envelope_type": "PreAuth",
  "buyer": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  "payee": "rTollBooTHxrpAgent1500PayeeXXXXXXXX",
  "chain": "xrpl:0",
  "endpoint": "/wallet-risk",
  "max_spend_xrp": "0.05",
  "valid_until": "2026-09-01T00:00:00Z",
  "budget_period_seconds": 3600,
  "allowed_endpoints": ["/wallet-risk", "/contract-risk"],
  "nonce_client": "01H9ZT3M4G5A7B8C9D0E1F2G3H",
  "timestamp_ms": 1756345200000,
  "trace_id": "trace-abc-123",
  "__sig": "ed25519:...",
  "__timestamp": "2026-08-28T11:35:00Z"
}
```

### 2.1 Required fields

- `version` — MUST be exactly `"0.9"`.
- `envelope_type` — MUST be exactly `"PreAuth"`. (The v0.9 spec reserves `"SurgeAuth"` as a distinct envelope type; see §9.)
- `buyer` — RFC 4627 string, the buyer's chain-native address. For `chain: "xrpl:0"`, an `r`-prefixed XRPL classic address.
- `payee` — RFC 4627 string, the seller's chain-native address for settlement.
- `chain` — CAIP-2 chain identifier. For XRPL mainnet: `"xrpl:0"`.
- `endpoint` — the primary endpoint this envelope authorizes. A convenience alias; the authoritative allowlist is `allowed_endpoints`.
- `max_spend_xrp` — decimal string, the total spend cap over `budget_period_seconds`. MUST be a valid decimal with no exponent, no leading zeros (except for values below 1), and at most 6 fractional digits (XRPL drops precision).
- `valid_until` — RFC 3339 timestamp with a `Z` suffix (UTC). The envelope MUST NOT be consumed at any `submitted_at` strictly greater than `valid_until`.
- `budget_period_seconds` — positive integer. See §9 for the open question on sliding vs fixed windows.
- `allowed_endpoints` — non-empty array of RFC 3986 path strings. An attempt against an endpoint not in this array MUST be rejected with reason code `ENDPOINT_NOT_AUTHORIZED`.
- `nonce_client` — buyer-generated nonce, unique per envelope within any given `budget_period_seconds` window. ULID or UUIDv7 recommended.
- `timestamp_ms` — buyer's wall-clock at signing time, Unix milliseconds. Advisory only; not used for validity gating.
- `__sig` — signature over the digest defined in §3. Format: `<scheme>:<hex>`. For v0.9, `scheme` MUST be `"ed25519"`.
- `__timestamp` — seller-observed RFC 3339 timestamp at receipt. Advisory only.

### 2.2 Optional fields

- `trace_id` — implementation-defined correlation identifier. Sellers MUST NOT gate acceptance on `trace_id`.

### 2.3 Field ordering

Field order in the on-the-wire JSON is not significant; canonicalization (§3) sorts keys.

## 3. Canonicalization and digest

The digest is a lowercase hex SHA-256 over the RFC 8785 JCS canonical form of the envelope after volatile fields are stripped.

```
preAuthRequestDigest(envelope) = hex(sha256(canonicalize(stripVolatile(envelope))))
```

### 3.1 Canonicalization

RFC 8785 JCS applies, without extension:
- Keys sorted by UTF-16 code unit order (JCS §3.2.3).
- Numbers serialized per JCS §3.2.2.3 (positive/negative zero collapse, no exponent for integers, lowercase `e` for large-magnitude floats).
- Strings serialized per JCS §3.2.2 (quote, backslash, control chars, tab, newline escaped; Unicode passthrough for BMP code points).
- Whitespace between tokens: none.

Implementations SHOULD apply Unicode NFC normalization to all string values before JCS to guarantee equivalence across systems that emit different Unicode forms of the same visible string. This is a v0.9-specific addition above JCS baseline; the positive fixture `03-unicode-nfc` proves the requirement by asserting that NFC and NFD forms of the same string produce identical digests.

### 3.2 Volatile fields excluded from the digest

The following fields MUST be shallow-stripped before canonicalization:

- `nonce_client`
- `timestamp_ms`
- `trace_id`
- `__sig`
- `__timestamp`

Two envelopes that differ only in one or more of these fields MUST produce the same `preAuthRequestDigest`. Two envelopes that differ in any other field MUST produce different digests.

An implementation MUST NOT widen this list. In particular, a heuristic like "strip every field starting with an underscore" or "strip every field whose name matches a pattern" breaks payment integrity: a buyer signs authorization for one amount, the seller settles for a different amount, and the digests still match. The negative fixture `13-non-volatile-mutation` proves this.

### 3.3 Signature

The signature covers the digest (not the envelope bytes directly). Verification:

```
verify(pubkey_from(envelope.buyer), envelope.__sig, preAuthRequestDigest(envelope))
```

An envelope whose signature fails verification MUST be rejected with reason code `SIGNATURE_INVALID` before any other state is touched. See §5.

## 4. Consumption

A seller consumes an envelope by processing an **attempt**:

```
{
  "endpoint": "/wallet-risk",
  "charge_xrp": "0.01",
  "submitted_at": "2026-08-28T11:35:01Z"
}
```

- `endpoint` — the endpoint the buyer is invoking. MUST be present in `envelope.allowed_endpoints` or the attempt is rejected.
- `charge_xrp` — the seller's price for this specific call. Decimal string, same constraints as `max_spend_xrp`.
- `submitted_at` — RFC 3339 seller-observed timestamp.

Consumption is defined as a state transition on the seller's ledger. Sellers MAY use any implementation; conformance is defined by the state-transition contract in §5.

## 5. State transitions

For any `(initial_state, envelope, attempt)`, an implementation MUST produce a deterministic `(outcome, terminal_state)`.

`outcome` is one of:
- `"accept"` — the attempt succeeded; ledger updated.
- `"reject"` — the attempt failed; a `reason_code` is returned.

`terminal_state` has four fields:
- `nonce_status` — `"fresh"` (envelope's nonce not in the ledger's consumed set) or `"consumed"` (in the consumed set).
- `budget_consumed_delta` — decimal string, additional XRP consumed against this envelope's budget window by THIS attempt. `"0"` if the attempt did not modify budget.
- `settlement_ref` — a non-empty string on acceptance; `null` on any rejection.
- `ledger_updated` — `true` if this attempt modified the ledger (i.e. moved nonce from fresh to consumed, or deducted budget, or recorded a settlement); `false` otherwise.

### 5.1 Rejection invariant

For every attempt whose `outcome === "reject"`:
- `budget_consumed_delta === "0"`
- `settlement_ref === null`
- `ledger_updated === false`

No partial charge. No partial settlement. No state pollution from unauthenticated input. This invariant is what makes the suite a reconciliation test.

### 5.2 Acceptance invariant

For every attempt whose `outcome === "accept"`:
- `nonce_status === "consumed"` in the terminal state
- `budget_consumed_delta` is a positive decimal string equal to `attempt.charge_xrp`
- `settlement_ref` is a non-empty string, implementation-defined
- `ledger_updated === true`

### 5.3 Rejection order

An implementation MUST evaluate rejection conditions in this order, returning the first that fires:

1. `SIGNATURE_INVALID` — signature fails verification.
2. `ENVELOPE_EXPIRED` — `attempt.submitted_at > envelope.valid_until`.
3. `ENDPOINT_NOT_AUTHORIZED` — `attempt.endpoint` not in `envelope.allowed_endpoints`.
4. `BUDGET_EXHAUSTED` — `ledger.budget_consumed_xrp + attempt.charge_xrp > envelope.max_spend_xrp`.
5. `NONCE_ALREADY_CONSUMED` — `envelope.nonce_client` is in `ledger.consumed_nonces` for the current period.

Order matters because it determines `nonce_status` in the terminal state:
- Rejections 1–4 happen before nonce lookup; `nonce_status === "fresh"`.
- Rejection 5 happens at nonce lookup; `nonce_status === "consumed"` with the nonce unchanged from its prior state.

The failure mode this ordering prevents: an implementation that consumes the nonce first and then checks expiry would burn the buyer's nonce on an invalid envelope. That would let an attacker force-consume a victim's nonce by replaying stale envelopes.

## 6. Reason codes

v0.9 defines these reason codes for rejection:

| code | when |
|---|---|
| `SIGNATURE_INVALID` | `__sig` fails verification against buyer's pubkey |
| `ENVELOPE_EXPIRED` | `submitted_at > valid_until` |
| `ENDPOINT_NOT_AUTHORIZED` | `attempt.endpoint` not in `allowed_endpoints` |
| `BUDGET_EXHAUSTED` | attempt's charge plus prior consumption exceeds `max_spend_xrp` |
| `NONCE_ALREADY_CONSUMED` | envelope's nonce is in the ledger's consumed set |

The reason-code registry policy is deferred to v1.0 (see §9).

## 7. Conformance

An implementation is v0.9-conformant if:

1. Its canonicalization function produces identical bytes to the reference `canonicalize` in `src/canonicalize.mjs` for every fixture in `test-vectors/v0.9/canonicalization/`.
2. Its digest function produces identical digests to the reference `preAuthRequestDigest` in `src/digest.mjs` for every fixture in `test-vectors/v0.9/excluded-fields/`.
3. Its state machine produces `(actual_outcome, actual_terminal_state)` that matches `expected_outcome` and `expected_terminal_state` on every scenario in `test-vectors/v0.9/replay-boundaries/`.

`verify.mjs` at the repo root runs suites (1) and (2) automatically. Suite (3) is a shape validator; implementations plug in their own state machine by importing `verify.mjs`'s scenario validator and providing an executor.

## 8. Relationship to v0.8

v0.8 covers the seller's response envelope: a signed risk report bound to the request that paid for it. v0.9 covers the buyer's authorization envelope consumed at settlement. They compose: a request pays a v0.8 seller by consuming a v0.9 buyer authorization. Neither replaces the other; both are needed.

The two envelope types share the JCS canonicalization rules from §3.1 but have distinct `envelope_type` values (`"Response"` for v0.8, `"PreAuth"` for v0.9), distinct volatile-field lists, and distinct digest functions. Cross-type digest reuse is not permitted.

## 9. Open questions

Three design decisions are deferred to v1.0. Feedback on these is the primary purpose of this draft.

### 9.1 Budget window semantics

`budget_period_seconds` is currently ambiguous: does it define a fixed window anchored at first consumption, or a sliding window over the last N seconds?

- Fixed window is simpler and matches how most rate limiters work.
- Sliding window is more honest ("no more than X per hour" means the last hour, not the calendar hour) but requires more ledger state.

Current fixtures assume fixed-window semantics with `budget_period_start` in the ledger. If v1.0 adopts sliding-window, fixture 17 needs an additional `budget_window_type` field.

### 9.2 SurgeAuthEnvelope

The v0.9 spec reserves `"SurgeAuth"` as a distinct envelope type for time-bounded spend spikes (e.g. "I'm about to run a burst of 100 calls in the next 60 seconds, cap at 5 XRP"). It is not yet specified. Open questions:

- Does it share the volatile-field list with `PreAuth`?
- Does it compose with `PreAuth` (surge is layered on top of a base authorization) or replace it (surge is independent)?
- Does it need its own state-transition contract, or can it reuse §5?

The current fixture suite covers `PreAuth` only.

### 9.3 Reason-code registry

`SIGNATURE_INVALID`, `ENVELOPE_EXPIRED`, etc. are string constants. v1.0 needs a registry policy:

- Are reason codes closed (only spec-defined values) or open (implementations can add codes)?
- If open, how are extensions namespaced?
- How does a reason code deprecate over time?

The IETF standard is a "specification required" registry, but v1.0 may not need to be that formal.

## 10. Reference implementation

`Bubakooz22/xrpl-tollbooth` at commit `9e3c0b99` implements this draft. Directory layout:

- `src/canonicalize.mjs` — JCS canonicalization with NFC normalization.
- `src/digest.mjs` — `V09_VOLATILE_FIELDS`, `stripVolatile`, `preAuthRequestDigest`.
- `src/self-test.mjs` — 23 pure-function tests covering canonicalizer and digest.
- `test-vectors/v0.9/` — 19 fixtures across three tiers.
- `verify.mjs` — runs all three suites.

Running `node verify.mjs` against the reference implementation prints:

```
19 passed, 0 failed
```

## 11. Changelog

- **2026-08-28 (draft)** — initial draft. All three fixture tiers landed on master (`1e7109a` Tier 1, `986f7099` Tier 2, `9e3c0b99` Tier 3). Feedback pending.

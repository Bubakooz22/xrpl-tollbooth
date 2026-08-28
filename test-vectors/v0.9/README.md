# tollbooth v0.9 conformance test vectors

This directory contains the reference test vectors for the tollbooth x402
pre-authorization envelope, spec version 0.9. Any independent implementation
that intends to produce or verify v0.9 envelopes MUST pass every fixture here.

## Running the vectors

From the repo root:

```
node verify.mjs                     # run all suites
node verify.mjs canonicalization    # run one suite
node verify.mjs --verbose           # show every digest computed
```

`verify.mjs` uses this repo's own canonicalizer to prove the fixtures are
internally consistent. To verify your own implementation, replace the import
of `./src/digest.mjs` inside `verify.mjs` with your equivalent. Every fixture
must still pass.

Exit code is 0 when all fixtures pass, nonzero otherwise. This means the
runner is safe to gate CI on.

## Structure

```
test-vectors/v0.9/
├── canonicalization/       ← Tier 1: JSON canonicalization equivalence
│   ├── 01-key-ordering/
│   ├── 02-whitespace/
│   ├── 03-unicode-nfc/
│   ├── 04-number-formatting/
│   ├── 05-nested-key-ordering/
│   ├── 06-empty-containers/
│   ├── 07-string-escapes/
│   └── 08-array-order-significance/  ← negative fixture
├── excluded-fields/        ← Tier 2: volatile-field allowlist
│   ├── 09-volatile-nonce-client/
│   ├── 10-volatile-timestamp/
│   ├── 11-volatile-trace-id/
│   ├── 12-volatile-signature/
│   └── 13-non-volatile-mutation/     ← negative fixture
└── replay-boundaries/      ← Tier 3: state-transition contract
    ├── 14-fresh-accept/
    ├── 15-replay-same-nonce/
    ├── 16-expired-envelope/
    ├── 17-budget-exhausted/
    ├── 18-endpoint-not-allowed/
    └── 19-signature-invalid/
```

Each Tier 1 / Tier 2 fixture directory contains:

- `description.md` — what the fixture proves and why it matters
- `input-a.json`, `input-b.json`, ... — one or more JSON serializations
- `expected-digest.txt` — the digest all inputs MUST produce (positive fixtures)
- `expected-digest-a.txt`, `expected-digest-b.txt`, ... — per-input digests
  that MUST all differ (negative fixtures)

Each Tier 3 fixture directory contains:

- `description.md` — what the fixture proves and why it matters
- `scenario.json` — `initial_state`, `envelope`, `attempt`,
  `expected_outcome`, `expected_reason_code` (rejections),
  `expected_terminal_state`

Digests are lowercase hex SHA-256 over the RFC 8785 JCS canonical form.

## Positive vs negative fixtures

**Positive fixtures** (01 through 07): multiple inputs that describe the
same JSON value in different textual forms. A compliant implementation
MUST produce the same digest for all of them. Failure here means two nodes
running your code will produce different signatures for the same request,
and every signature verification will fail.

**Negative fixtures** (08 and future): inputs that differ semantically and
MUST produce different digests. Failure here means your implementation is
too aggressive about normalization — for example, sorting array elements —
which would allow request substitution attacks.

## Canonicalization rules (short version)

The v0.9 spec (see `specs/pre-authorization-v0.9.md`) defines the canonical
form authoritatively. In summary:

- **Media type:** `application/x402+preauth-v0.9`
- **Canonical serialization:** RFC 8785 JCS
- **Digest:** SHA-256 over the canonical bytes, hex, lowercase
- **Unicode:** NFC normalization applied to all string values before JCS
- **Volatile fields excluded from digest:** `nonce_client`, `timestamp_ms`,
  `trace_id`, `__sig`, `__timestamp`
- **Array order is significant.** Do not sort arrays.
- **Object key order is not significant.** JCS sorts them for you.

## Suites in detail

### Tier 1 — canonicalization (01–08)

Proves that two JSON serializations that describe the same value produce the
same digest, and that array reordering does not. This is the JCS layer of
conformance: whitespace, key ordering, number formatting, Unicode NFC, and
empty containers must all normalize away; array order must not.

### Tier 2 — excluded fields (09–13)

Proves that the `preAuthRequestDigest` function strips only the specific
volatile fields listed in the v0.9 spec (`nonce_client`, `timestamp_ms`,
`trace_id`, `__sig`, `__timestamp`) before hashing. Two envelopes that
differ ONLY in those fields MUST produce identical digests (09–12). Two
envelopes that differ in ANY non-volatile field MUST produce different
digests (13).

The negative fixture (13) is the critical safety test: it fails loudly
against any implementation that widens the allowlist beyond spec — for
example, one that strips every field starting with an underscore, or every
field matching a name heuristic. Widening the allowlist without spec
approval breaks payment integrity: a buyer signs authorization for one
amount, the seller settles for a different amount, and the digests still
match.

### Tier 3 — replay boundaries and terminal state (14–19)

Proves the state-transition contract for envelope consumption: what must
happen to the authorization ledger when an attempt is accepted, and what
MUST NOT happen when an attempt is rejected. This is a reconciliation
test, not just a hashing test.

Each `scenario.json` declares:

- `initial_state` — consumed nonces, budget period start, budget already
  consumed, prior settlements
- `envelope` — the PreAuthEnvelope being submitted
- `attempt` — which endpoint is being called, at what charge, when
- `expected_outcome` — `accept` or `reject`
- `expected_reason_code` — required for rejections (e.g.
  `NONCE_ALREADY_CONSUMED`, `ENVELOPE_EXPIRED`, `BUDGET_EXHAUSTED`,
  `ENDPOINT_NOT_AUTHORIZED`, `SIGNATURE_INVALID`)
- `expected_terminal_state` — `nonce_status` (`fresh` or `consumed`),
  `budget_consumed_delta`, `settlement_ref`, `ledger_updated`

The suite enforces two invariants that any conformant implementation MUST
satisfy:

**Rejection invariant.** On every rejection: `budget_consumed_delta ===
"0"`, `settlement_ref === null`, `ledger_updated === false`. No partial
charge, no partial settlement, no state pollution from unauthenticated
input. Rejections that happen before nonce lookup (16–19) leave
`nonce_status === "fresh"`; rejections that happen at nonce lookup (15)
leave `nonce_status === "consumed"` with the nonce unchanged from its
prior state.

**Acceptance invariant.** On acceptance (14): `nonce_status === "consumed"`,
`settlement_ref` is a non-empty string, `budget_consumed_delta` records
the charge amount, `ledger_updated === true`.

#### Runner scope

The runner in this repo is a SHAPE VALIDATOR. It proves each `scenario.json`
is internally consistent and satisfies the invariants above. It does NOT
execute a state machine — that belongs in the implementation under test.

An implementation plugs into this suite by providing an executor that
consumes `(initial_state, envelope, attempt)` and produces
`(actual_outcome, actual_terminal_state)`. Conformance means the actual
values match `scenario.expected_*` on every fixture.

The state machine itself is formalized in `specs/pre-authorization-v0.9.md`
under "State transitions" (pending).

## Adding a new fixture

Fixtures are generated by `src/generate-canonicalization-fixtures.mjs`
(Tier 1), `src/generate-excluded-field-fixtures.mjs` (Tier 2), and
`src/generate-replay-boundary-fixtures.mjs` (Tier 3). Add an entry to the
relevant `FIXTURES` array (or `fixtures` for Tier 3), run the generator,
then run `verify.mjs` to confirm your new fixture is internally
consistent. Commit the generated files (they are the interop contract).

The generator refuses to emit a fixture where positive inputs disagree or
negative inputs agree — this is deliberate. If your generator run throws,
your proposed fixture is broken, not the runner.

## Status

- 2026-08-27: initial drop, canonicalization suite (8 fixtures). Excluded-
  fields and replay-boundaries suites tracked as follow-up.
- 2026-08-28: excluded-fields suite landed (5 fixtures). Replay-boundaries
  suite tracked as follow-up alongside the v0.9 spec doc update.
- 2026-08-28: replay-boundaries suite landed (6 fixtures). Runner
  implemented as a shape validator per Option C: fixtures ARE the
  interop contract; state-machine implementation belongs in
  `specs/pre-authorization-v0.9.md` (pending).

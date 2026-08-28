// Generate v0.9 replay-boundary (Tier 3) fixtures.
//
// Contract under test:
//   Every rejection of a PreAuthEnvelope attempt MUST leave the
//   authorization ledger in a well-defined terminal state. Specifically,
//   for every rejected attempt:
//     - budget_consumed_delta === "0"  (no partial charge)
//     - settlement_ref === null        (no settlement side-effect)
//     - nonce_status is either "fresh" (rejection happened before nonce
//       lookup) or "consumed" (already-consumed nonce, unchanged)
//
// For accepted attempts, the terminal state records the state transition:
//   - nonce_status === "consumed"
//   - budget_consumed_delta === <amount charged, XRP as decimal string>
//   - settlement_ref is a non-empty string (implementation-defined)
//
// This suite is spec-authoritative: an implementation whose state machine
// disagrees with any fixture's expected_terminal_state is non-conformant.
// See specs/pre-authorization-v0.9.md § "State transitions".
//
// Layout produced under test-vectors/v0.9/replay-boundaries/:
//   14-fresh-accept/          positive
//   15-replay-same-nonce/     rejection: nonce already consumed
//   16-expired-envelope/      rejection: valid_until in the past
//   17-budget-exhausted/      rejection: budget cap reached
//   18-endpoint-not-allowed/  rejection: attempt outside allowed_endpoints
//   19-signature-invalid/     rejection: bad envelope signature
//
// Each fixture is a directory containing:
//   description.md
//   scenario.json    — { initial_state, envelope, attempt, expected_outcome, expected_terminal_state }

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'test-vectors', 'v0.9', 'replay-boundaries');

// ---- Terminal-state contract ------------------------------------------------
// Every scenario.json's expected_terminal_state MUST match this shape.

const REJECTION_INVARIANTS = Object.freeze({
  // On any rejection, no partial charge, no settlement.
  budget_consumed_delta: '0',
  settlement_ref: null,
});

// ---- Realistic v0.9 PreAuthEnvelope base ------------------------------------
const baseEnvelope = () => ({
  version: '0.9',
  envelope_type: 'PreAuth',
  buyer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  payee: 'rTollBooTHxrpAgent1500PayeeXXXXXXXX',
  chain: 'xrpl:0',
  endpoint: '/wallet-risk',
  max_spend_xrp: '0.05',
  valid_until: '2026-09-01T00:00:00Z',
  budget_period_seconds: 3600,
  allowed_endpoints: ['/wallet-risk', '/contract-risk', '/tx-simulate-risk'],
});

const validSig = 'ed25519:0011223344556677889900aabbccddeeff00112233445566778899aabbccddeeff';

// ---- Fixture specs ----------------------------------------------------------
const fixtures = [
  {
    dir: '14-fresh-accept',
    title: 'positive baseline: fresh envelope, unused nonce',
    description: `An implementation MUST accept a well-formed
PreAuthEnvelope submitted with an unused nonce within its validity
window, against an authorized endpoint, when the buyer's budget has
remaining capacity.

The terminal state records the state transition: nonce marked
consumed, budget deducted by the attempt's charge amount, settlement
reference set.

This is the baseline positive case; every subsequent Tier 3 fixture
is a rejection.`,
    initial_state: {
      consumed_nonces: [],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0',
      settlements: [],
    },
    envelope: {
      ...baseEnvelope(),
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345200000,
      __sig: validSig,
      __timestamp: '2026-08-28T11:35:00Z',
    },
    attempt: {
      endpoint: '/wallet-risk',
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:35:01Z',
    },
    expected_outcome: 'accept',
    expected_terminal_state: {
      nonce_status: 'consumed',
      budget_consumed_delta: '0.01',
      settlement_ref: 'sim://settlement/tier3-14',
      ledger_updated: true,
    },
  },
  {
    dir: '15-replay-same-nonce',
    title: 'rejection: nonce already consumed',
    description: `An implementation MUST reject an attempt whose
\`nonce_client\` already appears in the consumed-nonce set for the
current budget period. The rejection MUST leave the ledger unchanged:
the nonce is already consumed (unchanged), no additional budget is
deducted, no new settlement is recorded.

This is the primary anti-replay test. Its failure mode is a
double-charge: buyer signs one authorization, seller consumes it
twice, buyer's budget is depleted at 2x rate.

The nonce_status remains "consumed" (not "fresh") because the nonce
was already consumed BEFORE this attempt. The invariant we assert is
that this attempt did not further modify state.`,
    initial_state: {
      consumed_nonces: ['01H9ZT3M4G5A7B8C9D0E1F2G3H'],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0.01',
      settlements: ['sim://settlement/prior-consumption'],
    },
    envelope: {
      ...baseEnvelope(),
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345260000,
      __sig: validSig,
      __timestamp: '2026-08-28T11:36:00Z',
    },
    attempt: {
      endpoint: '/wallet-risk',
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:36:01Z',
    },
    expected_outcome: 'reject',
    expected_reason_code: 'NONCE_ALREADY_CONSUMED',
    expected_terminal_state: {
      nonce_status: 'consumed',
      ...REJECTION_INVARIANTS,
      ledger_updated: false,
    },
  },
  {
    dir: '16-expired-envelope',
    title: 'rejection: envelope past valid_until',
    description: `An implementation MUST reject an attempt whose
envelope's \`valid_until\` is strictly before the attempt's
\`submitted_at\`. The rejection MUST happen before nonce lookup, so
the nonce remains fresh (unconsumed) — a replay of the same nonce
with a fresh envelope is still permitted.

The failure mode this catches: an implementation that consumes the
nonce first and then checks expiry burns the nonce on an
already-invalid envelope. That would let an attacker force-consume
a victim's nonce by replaying stale envelopes.`,
    initial_state: {
      consumed_nonces: [],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0',
      settlements: [],
    },
    envelope: {
      ...baseEnvelope(),
      valid_until: '2026-08-27T00:00:00Z', // 24h+ in the past
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345200000,
      __sig: validSig,
      __timestamp: '2026-08-27T00:00:00Z',
    },
    attempt: {
      endpoint: '/wallet-risk',
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:35:01Z',
    },
    expected_outcome: 'reject',
    expected_reason_code: 'ENVELOPE_EXPIRED',
    expected_terminal_state: {
      nonce_status: 'fresh',
      ...REJECTION_INVARIANTS,
      ledger_updated: false,
    },
  },
  {
    dir: '17-budget-exhausted',
    title: 'rejection: budget cap reached',
    description: `An implementation MUST reject an attempt whose
\`charge_xrp\` plus the current period's \`budget_consumed_xrp\`
exceeds the envelope's \`max_spend_xrp\`. The rejection MUST happen
before nonce lookup, so the nonce remains fresh.

The failure mode this catches: partial charge. An implementation that
deducts the allowable remainder and rejects the overage would violate
the authorization contract (the buyer authorized 0.05 total, not "up
to 0.05 with partial charge on the last attempt").

Budget is checked at the aggregate level (period-wide), not
per-attempt.`,
    initial_state: {
      consumed_nonces: ['01H9OLDPRIORNONCE0001'],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0.05', // at cap
      settlements: ['sim://settlement/prior-consumption'],
    },
    envelope: {
      ...baseEnvelope(),
      max_spend_xrp: '0.05',
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345200000,
      __sig: validSig,
      __timestamp: '2026-08-28T11:35:00Z',
    },
    attempt: {
      endpoint: '/wallet-risk',
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:35:01Z',
    },
    expected_outcome: 'reject',
    expected_reason_code: 'BUDGET_EXHAUSTED',
    expected_terminal_state: {
      nonce_status: 'fresh',
      ...REJECTION_INVARIANTS,
      ledger_updated: false,
    },
  },
  {
    dir: '18-endpoint-not-allowed',
    title: 'rejection: attempt outside allowed_endpoints',
    description: `An implementation MUST reject an attempt whose
\`endpoint\` is not present in the envelope's \`allowed_endpoints\`
list. The rejection MUST happen before nonce lookup, so the nonce
remains fresh.

The failure mode this catches: authorization laundering. An envelope
authorizes \`/wallet-risk\` cheaply; without endpoint scoping, an
attacker could redirect the authorization to a more expensive
endpoint like \`/tx-simulate-risk\` at a higher charge.`,
    initial_state: {
      consumed_nonces: [],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0',
      settlements: [],
    },
    envelope: {
      ...baseEnvelope(),
      allowed_endpoints: ['/wallet-risk'], // only wallet-risk
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345200000,
      __sig: validSig,
      __timestamp: '2026-08-28T11:35:00Z',
    },
    attempt: {
      endpoint: '/tx-simulate-risk', // NOT in allowed_endpoints
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:35:01Z',
    },
    expected_outcome: 'reject',
    expected_reason_code: 'ENDPOINT_NOT_AUTHORIZED',
    expected_terminal_state: {
      nonce_status: 'fresh',
      ...REJECTION_INVARIANTS,
      ledger_updated: false,
    },
  },
  {
    dir: '19-signature-invalid',
    title: 'rejection: envelope signature invalid',
    description: `An implementation MUST reject an envelope whose
\`__sig\` fails signature verification against the buyer's declared
public key. The rejection MUST happen before nonce lookup and before
budget check — signature verification is the first gate.

The failure mode this catches: state pollution from unauthenticated
input. If an implementation consumed the nonce and THEN verified the
signature, an attacker could force-consume a victim's nonce by
submitting a garbage-signed envelope with the victim's nonce.

The nonce_status remains "fresh" because the attempt failed before
reaching nonce lookup.`,
    initial_state: {
      consumed_nonces: [],
      budget_period_start: '2026-08-28T11:00:00Z',
      budget_consumed_xrp: '0',
      settlements: [],
    },
    envelope: {
      ...baseEnvelope(),
      nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
      timestamp_ms: 1756345200000,
      __sig: 'ed25519:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // bad
      __timestamp: '2026-08-28T11:35:00Z',
    },
    attempt: {
      endpoint: '/wallet-risk',
      charge_xrp: '0.01',
      submitted_at: '2026-08-28T11:35:01Z',
    },
    expected_outcome: 'reject',
    expected_reason_code: 'SIGNATURE_INVALID',
    expected_terminal_state: {
      nonce_status: 'fresh',
      ...REJECTION_INVARIANTS,
      ledger_updated: false,
    },
  },
];

// ---- Self-consistency check ------------------------------------------------
// Every rejection fixture must satisfy the REJECTION_INVARIANTS. This runs
// at generate time so an unsound fixture never reaches disk.

function validateFixture(f) {
  const t = f.expected_terminal_state;
  if (!t) throw new Error(`${f.dir}: missing expected_terminal_state`);
  if (f.expected_outcome === 'reject') {
    if (t.budget_consumed_delta !== '0') {
      throw new Error(`${f.dir}: rejection with non-zero budget_consumed_delta=${t.budget_consumed_delta}`);
    }
    if (t.settlement_ref !== null) {
      throw new Error(`${f.dir}: rejection with non-null settlement_ref=${JSON.stringify(t.settlement_ref)}`);
    }
    if (t.ledger_updated !== false) {
      throw new Error(`${f.dir}: rejection with ledger_updated=${t.ledger_updated} (must be false)`);
    }
    if (!f.expected_reason_code) {
      throw new Error(`${f.dir}: rejection with no expected_reason_code`);
    }
  } else if (f.expected_outcome === 'accept') {
    if (t.nonce_status !== 'consumed') {
      throw new Error(`${f.dir}: acceptance with nonce_status=${t.nonce_status} (must be "consumed")`);
    }
    if (t.settlement_ref === null || typeof t.settlement_ref !== 'string') {
      throw new Error(`${f.dir}: acceptance with settlement_ref=${JSON.stringify(t.settlement_ref)} (must be a non-empty string)`);
    }
    if (t.ledger_updated !== true) {
      throw new Error(`${f.dir}: acceptance with ledger_updated=${t.ledger_updated} (must be true)`);
    }
  } else {
    throw new Error(`${f.dir}: expected_outcome must be "accept" or "reject", got ${f.expected_outcome}`);
  }
}

// ---- Emit -------------------------------------------------------------------
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeText(path, text) {
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', 'utf8');
}

mkdirSync(OUT_ROOT, { recursive: true });

let count = 0;
for (const f of fixtures) {
  validateFixture(f);
  const dir = join(OUT_ROOT, f.dir);
  mkdirSync(dir, { recursive: true });

  const scenario = {
    initial_state: f.initial_state,
    envelope: f.envelope,
    attempt: f.attempt,
    expected_outcome: f.expected_outcome,
    ...(f.expected_reason_code ? { expected_reason_code: f.expected_reason_code } : {}),
    expected_terminal_state: f.expected_terminal_state,
  };
  writeJson(join(dir, 'scenario.json'), scenario);
  writeText(
    join(dir, 'description.md'),
    `# ${f.dir} — ${f.title}\n\n${f.description}\n`
  );
  count += 1;
  const outcome = f.expected_outcome === 'accept' ? 'accept' : `reject/${f.expected_reason_code}`;
  console.log(`  wrote ${f.dir} → ${outcome}`);
}

console.log(`\nWrote ${count} replay-boundary fixtures under ${OUT_ROOT}`);

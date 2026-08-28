// Generate v0.9 excluded-field (Tier 2) fixtures.
//
// Contract under test:
//   The `preAuthRequestDigest` function (digest.mjs) strips a specific
//   allow-listed set of volatile / transport fields before canonicalizing
//   and hashing. Two PreAuthEnvelopes that differ ONLY in those fields
//   MUST produce the same digest. Two envelopes that differ in ANY other
//   field MUST produce different digests.
//
// Layout produced under test-vectors/v0.9/excluded-fields/:
//   09-volatile-nonce-client/    positive
//   10-volatile-timestamp/       positive
//   11-volatile-trace-id/        positive
//   12-volatile-signature/       positive (both __sig and __timestamp)
//   13-non-volatile-mutation/    negative (max_spend_xrp differs)
//
// Each positive fixture is a directory containing:
//   description.md
//   input-a.json
//   input-b.json
//   expected-digest.txt      (single hex line — both inputs must match)
//
// The negative fixture instead emits:
//   expected-digest-a.txt
//   expected-digest-b.txt    (must differ)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preAuthRequestDigest } from './digest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'test-vectors', 'v0.9', 'excluded-fields');

// ---- Realistic v0.9 PreAuthEnvelope base ------------------------------------
// Semantic (non-volatile) fields only. Volatile fields are attached per fixture.
// Field names track the v0.9 design doc: buyer, payee, chain, endpoint,
// max_spend_xrp, valid_until, budget_period_seconds, allowed_endpoints.
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

// ---- Fixture specs ----------------------------------------------------------
const positiveFixtures = [
  {
    dir: '09-volatile-nonce-client',
    title: 'volatile field: nonce_client',
    description: `Two PreAuthEnvelopes identical in every semantic field but
differing in \`nonce_client\`. Because \`nonce_client\` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
\`preAuthRequestDigest\`.

Nonces are anti-replay metadata. They are bound elsewhere in the
signed envelope wrapper, not into the semantic identity of the
request itself.`,
    a: { ...baseEnvelope(), nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H' },
    b: { ...baseEnvelope(), nonce_client: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
  },
  {
    dir: '10-volatile-timestamp',
    title: 'volatile field: timestamp_ms',
    description: `Two PreAuthEnvelopes identical in every semantic field but
differing in \`timestamp_ms\`. Because \`timestamp_ms\` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
\`preAuthRequestDigest\`.

The wall clock is transport metadata used for freshness checks in
the outer signed wrapper; it is not part of the request's semantic
identity.`,
    a: { ...baseEnvelope(), timestamp_ms: 1756345200000 },
    b: { ...baseEnvelope(), timestamp_ms: 1756345260000 },
  },
  {
    dir: '11-volatile-trace-id',
    title: 'volatile field: trace_id',
    description: `Two PreAuthEnvelopes identical in every semantic field but
differing in \`trace_id\`. Because \`trace_id\` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
\`preAuthRequestDigest\`.

Trace IDs are observability metadata. Two different buyers of the
same authorization envelope will emit different trace IDs; that
must not fork the semantic identity of the request.`,
    a: { ...baseEnvelope(), trace_id: 'trace-abc-001' },
    b: { ...baseEnvelope(), trace_id: 'trace-xyz-999' },
  },
  {
    dir: '12-volatile-signature',
    title: 'volatile fields: __sig and __timestamp',
    description: `Two PreAuthEnvelopes identical in every semantic field but
differing in \`__sig\` and \`__timestamp\`. Because both are on the
v0.9 volatile-field allowlist, both envelopes MUST produce the same
\`preAuthRequestDigest\`.

The signature is a wrapper AROUND the digest, not a component OF
the digest. This is the fixture that catches a common
implementation bug: hashing the envelope after it has been signed
(digest ends up covering \`__sig\`, which is uncomputable
in-band).`,
    a: {
      ...baseEnvelope(),
      __sig: 'ed25519:0011223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
      __timestamp: '2026-08-28T11:35:00Z',
    },
    b: {
      ...baseEnvelope(),
      __sig: 'ed25519:9988776655443322110099aabbccddeeff99887766554433221100aabbccddeeff',
      __timestamp: '2026-08-28T11:36:00Z',
    },
  },
];

const negativeFixture = {
  dir: '13-non-volatile-mutation',
  title: 'negative: non-volatile field mutation',
  description: `Two PreAuthEnvelopes differing in a NON-volatile field
(\`max_spend_xrp\`: 0.05 vs 0.50). Both include identical volatile
fields. The digests MUST differ.

This is the critical safety test: it proves that the volatile-field
allowlist is a whitelist, not a blacklist. If an implementation
accidentally strips too much (for example, strips every field
starting with an underscore, or every field matching a heuristic),
this fixture will pass equality and fail Tier 2 loudly.

An implementation that widens the allowlist without spec approval
breaks payment integrity: a buyer signs authorization for 0.05 XRP,
the seller settles for 0.50 XRP, and the digests still match.`,
  a: {
    ...baseEnvelope(),
    max_spend_xrp: '0.05',
    nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
    timestamp_ms: 1756345200000,
  },
  b: {
    ...baseEnvelope(),
    max_spend_xrp: '0.50', // semantic change: 10x spend
    nonce_client: '01H9ZT3M4G5A7B8C9D0E1F2G3H',
    timestamp_ms: 1756345200000,
  },
};

// ---- Emit -------------------------------------------------------------------
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeText(path, text) {
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', 'utf8');
}

mkdirSync(OUT_ROOT, { recursive: true });

let count = 0;

for (const f of positiveFixtures) {
  const dir = join(OUT_ROOT, f.dir);
  mkdirSync(dir, { recursive: true });

  const digestA = preAuthRequestDigest(f.a);
  const digestB = preAuthRequestDigest(f.b);
  if (digestA !== digestB) {
    throw new Error(
      `[generator] positive fixture ${f.dir} produced non-matching digests: ${digestA} vs ${digestB}`
    );
  }

  writeJson(join(dir, 'input-a.json'), f.a);
  writeJson(join(dir, 'input-b.json'), f.b);
  writeText(join(dir, 'expected-digest.txt'), digestA);
  writeText(
    join(dir, 'description.md'),
    `# ${f.dir} — ${f.title}\n\n${f.description}\n`
  );
  count += 1;
  console.log(`  wrote ${f.dir} → ${digestA.slice(0, 16)}…`);
}

{
  const f = negativeFixture;
  const dir = join(OUT_ROOT, f.dir);
  mkdirSync(dir, { recursive: true });

  const digestA = preAuthRequestDigest(f.a);
  const digestB = preAuthRequestDigest(f.b);
  if (digestA === digestB) {
    throw new Error(
      `[generator] negative fixture ${f.dir} produced MATCHING digests: ${digestA}. ` +
        `This means the volatile-field allowlist stripped a semantic field.`
    );
  }

  writeJson(join(dir, 'input-a.json'), f.a);
  writeJson(join(dir, 'input-b.json'), f.b);
  writeText(join(dir, 'expected-digest-a.txt'), digestA);
  writeText(join(dir, 'expected-digest-b.txt'), digestB);
  writeText(
    join(dir, 'description.md'),
    `# ${f.dir} — ${f.title}\n\n${f.description}\n`
  );
  count += 1;
  console.log(`  wrote ${f.dir} → a=${digestA.slice(0, 16)}… b=${digestB.slice(0, 16)}…`);
}

console.log(`\nWrote ${count} excluded-field fixtures under ${OUT_ROOT}`);

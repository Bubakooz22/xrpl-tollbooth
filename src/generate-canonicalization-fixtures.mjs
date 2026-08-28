// Generates test-vectors/v0.9/canonicalization/**/*.
//
// Each fixture directory contains:
//   - description.md         — what the fixture proves
//   - input-a.json           — first serialization
//   - input-b.json           — second serialization (must digest identically)
//   - [input-c.json]         — optional third serialization
//   - expected-digest.txt    — the canonical hex digest all inputs must produce
//
// A compliant implementation MUST hash every input in a directory to the
// contents of expected-digest.txt. Any implementation that fails one of these
// has a canonicalization bug that will break signature verification in
// production.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestDigest } from './digest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'test-vectors', 'v0.9', 'canonicalization');

/**
 * A fixture is: { dir, description, inputs: { [filename]: object|string }, note? }
 * If inputs[key] is a string, it's written verbatim (used for whitespace /
 * pretty-printing cases where the JSON text is what differs, not the object).
 * If inputs[key] is an object, it's JSON.stringify'd with 2-space indent for
 * human readability; the canonicalizer will collapse whitespace regardless.
 */
const FIXTURES = [
  {
    dir: '01-key-ordering',
    description: `
# Key ordering

Object keys must be sorted lexicographically by UTF-16 code unit before
hashing. All three inputs describe the same object with keys emitted in
different orders on the wire; all three must digest identically.

## Why this matters

If two implementations disagree on key order, they will produce
different digests for the same request, and every signature will fail
verification. This is the single most common canonicalization bug in
production.
`.trim(),
    inputs: {
      'input-a.json': { offer_id: 'ofr_001', max_price: 5000, principal: 'raM5UMifT2mBfuE3CwERSHc9u2AsBEdUQp' },
      'input-b.json': { principal: 'raM5UMifT2mBfuE3CwERSHc9u2AsBEdUQp', offer_id: 'ofr_001', max_price: 5000 },
      'input-c.json': { max_price: 5000, principal: 'raM5UMifT2mBfuE3CwERSHc9u2AsBEdUQp', offer_id: 'ofr_001' },
    },
  },

  {
    dir: '02-whitespace',
    description: `
# Whitespace insensitivity

Pretty-printed and minified serializations of the same JSON value must
digest identically. Whitespace outside string literals carries no
semantic meaning; the canonicalizer strips it entirely.

Note: the inputs here are STRINGS, not objects, because the whole point
is that the on-the-wire byte representations differ. A compliant
verifier must JSON.parse each input and then canonicalize the parsed
value.
`.trim(),
    inputs: {
      'input-a.json': '{"a":1,"b":2}',
      'input-b.json': '{\n  "a": 1,\n  "b": 2\n}',
      'input-c.json': '  {   "a"   :   1  ,\t"b"\n:\n2\t}\t',
    },
    parseInputs: true,
  },

  {
    dir: '03-unicode-nfc',
    description: `
# Unicode normalization (NFC recommended)

JCS itself does NOT normalize Unicode; it hashes the literal code points
present in the input. This fixture documents that behavior AND the
recommended pre-canonicalization step: NFC normalization.

## The vectors

- input-a.json — the string "café" written as NFC (single code point é U+00E9)
- input-b.json — the same string as NFD (e + combining acute U+0065 U+0301)

Under raw JCS these produce DIFFERENT digests, which is a footgun.
The v0.9 spec REQUIRES both producers and verifiers to NFC-normalize
all string values before canonicalizing. When both sides normalize,
these inputs digest identically. When only one side normalizes,
signatures fail.

The expected digest below is the NFC-normalized digest, which is what
compliant implementations MUST produce for both inputs.
`.trim(),
    inputs: {
      'input-a.json': { note: 'caf\u00e9' },        // NFC
      'input-b.json': { note: 'cafe\u0301' },        // NFD
    },
    // Both sides normalize; digest is the NFC-normalized form.
    normalize: 'NFC',
  },

  {
    dir: '04-number-formatting',
    description: `
# Number formatting

JCS mandates the ECMAScript "shortest round-trip" number representation.
Different sources may emit the same numeric value in different textual
forms (1 vs 1.0 vs 1e0); after JSON.parse they're indistinguishable,
and the canonicalizer emits one form for all of them.

Compliant implementations MUST parse JSON into their language's
number type before canonicalizing — they must NOT preserve the input
text form.
`.trim(),
    inputs: {
      'input-a.json': '{"price":1000}',
      'input-b.json': '{"price":1000.0}',
      'input-c.json': '{"price":1.0e3}',
    },
    parseInputs: true,
  },

  {
    dir: '05-nested-key-ordering',
    description: `
# Nested-object key ordering

Key sorting applies recursively at every object depth. This fixture
proves that reordering keys inside a nested object produces the same
digest as reordering keys at the root.
`.trim(),
    inputs: {
      'input-a.json': { outer: { z: 1, a: 2, m: 3 }, top: 'x' },
      'input-b.json': { top: 'x', outer: { a: 2, m: 3, z: 1 } },
      'input-c.json': { outer: { m: 3, a: 2, z: 1 }, top: 'x' },
    },
  },

  {
    dir: '06-empty-containers',
    description: `
# Empty containers

Empty objects ({}) and empty arrays ([]) are legal JSON and must
digest identically regardless of source formatting. This fixture pins
the byte-level canonical form of empty containers ("{}", "[]") so
implementations that emit "{ }" or "[ ]" fail loudly.
`.trim(),
    inputs: {
      'input-a.json': { metadata: {}, tags: [] },
      'input-b.json': '{"tags":[],"metadata":{}}',
    },
    parseInputs: true,
  },

  {
    dir: '07-string-escapes',
    description: `
# String escapes

Per RFC 8785 §3.2.2, only these control characters get short escapes:
\\b \\t \\n \\f \\r \\" \\\\ — everything else < U+0020 uses \\uXXXX.
Characters ≥ U+0020 (including non-ASCII) pass through literally,
NOT as \\uXXXX escapes.

This fixture proves an implementation escapes exactly the mandated
set — no more, no less. Over-escaping (e.g. \\u0041 for "A") and
under-escaping (e.g. literal newlines inside strings) both break
digest agreement.
`.trim(),
    inputs: {
      'input-a.json': { field: 'line1\nline2\ttab"quote\\slash' },
    },
  },

  {
    dir: '08-array-order-significance',
    description: `
# Array order IS significant

Unlike object keys, arrays are ORDER-DEPENDENT. This is a NEGATIVE
fixture: input-a and input-b differ only in array order, and they
MUST produce DIFFERENT digests. An implementation that sorts array
elements is broken.

The expected-digest.txt contains the digest of input-a; input-b's
digest is written to expected-digest-b.txt so implementers can
verify both directions.
`.trim(),
    inputs: {
      'input-a.json': { assets: ['XRP', 'USD'], amounts: [1, 2, 3] },
      'input-b.json': { assets: ['USD', 'XRP'], amounts: [1, 2, 3] },
    },
    isNegative: true,
  },
];

function nfcNormalize(value) {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(nfcNormalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k.normalize('NFC')] = nfcNormalize(value[k]);
    return out;
  }
  return value;
}

for (const f of FIXTURES) {
  const dir = join(ROOT, f.dir);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'description.md'), f.description + '\n');

  const parsedValues = {};
  for (const [filename, content] of Object.entries(f.inputs)) {
    let bytes;
    let parsed;
    if (typeof content === 'string') {
      // Verbatim JSON text
      bytes = content;
      parsed = JSON.parse(content);
    } else {
      // Object; pretty-print for readability
      bytes = JSON.stringify(content, null, 2);
      parsed = content;
    }
    writeFileSync(join(dir, filename), bytes.endsWith('\n') ? bytes : bytes + '\n');
    parsedValues[filename] = parsed;
  }

  if (f.isNegative) {
    // Emit a digest for each input; they MUST differ
    const entries = Object.entries(parsedValues);
    const digests = entries.map(([name, val]) => {
      const v = f.normalize === 'NFC' ? nfcNormalize(val) : val;
      return { name, digest: requestDigest(v) };
    });
    const same = digests.every(d => d.digest === digests[0].digest);
    if (same) throw new Error(`Negative fixture ${f.dir} produced identical digests — invariant violated`);
    for (const d of digests) {
      const label = d.name.replace(/\.json$/, '').replace('input-', '');
      writeFileSync(join(dir, `expected-digest-${label}.txt`), d.digest + '\n');
    }
  } else {
    // Positive: all inputs must digest to the same value
    const digests = Object.entries(parsedValues).map(([name, val]) => {
      const v = f.normalize === 'NFC' ? nfcNormalize(val) : val;
      return { name, digest: requestDigest(v) };
    });
    const first = digests[0].digest;
    for (const d of digests) {
      if (d.digest !== first) {
        throw new Error(
          `Positive fixture ${f.dir} produced divergent digests:\n` +
          digests.map(x => `  ${x.name} → ${x.digest}`).join('\n')
        );
      }
    }
    writeFileSync(join(dir, 'expected-digest.txt'), first + '\n');
  }

  console.log(`  wrote ${f.dir}`);
}

console.log(`\nGenerated ${FIXTURES.length} canonicalization fixtures.`);

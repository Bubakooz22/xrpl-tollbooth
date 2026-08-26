// Test vectors for RFC 8785 canonicalization.
// These are the exact byte sequences a v0.8 verifier in ANY language must
// produce for these inputs. If any of these change, existing signatures
// break. Treat as append-only.

import { canonicalize } from "../lib/canonical-json.mjs";
import assert from "node:assert/strict";

const cases = [
  // Empty container basics.
  { name: "empty object", input: {}, expected: "{}" },
  { name: "empty array", input: [], expected: "[]" },

  // Primitives.
  { name: "null", input: null, expected: "null" },
  { name: "true", input: true, expected: "true" },
  { name: "false", input: false, expected: "false" },
  { name: "integer", input: 42, expected: "42" },
  { name: "negative integer", input: -7, expected: "-7" },
  { name: "float", input: 1.5, expected: "1.5" },
  { name: "negative zero -> 0", input: -0, expected: "0" },
  { name: "small string", input: "hi", expected: '"hi"' },

  // Key sort order (UTF-16 code units).
  {
    name: "keys sorted",
    input: { b: 1, a: 2, c: 3 },
    expected: '{"a":2,"b":1,"c":3}',
  },
  {
    name: "keys sorted case-sensitive",
    input: { B: 1, a: 2, A: 3, b: 4 },
    // Uppercase precedes lowercase in UTF-16.
    expected: '{"A":3,"B":1,"a":2,"b":4}',
  },
  {
    name: "keys sorted with digits",
    input: { key10: 1, key2: 2, key1: 3 },
    // Lexicographic: "key1" < "key10" < "key2"
    expected: '{"key1":3,"key10":1,"key2":2}',
  },

  // Whitespace in strings preserved, whitespace between tokens forbidden.
  {
    name: "no whitespace between tokens",
    input: { a: 1, b: [2, 3] },
    expected: '{"a":1,"b":[2,3]}',
  },
  {
    name: "whitespace in string preserved",
    input: { s: "hello world" },
    expected: '{"s":"hello world"}',
  },

  // Escapes.
  { name: "quote escaped", input: '"', expected: '"\\""' },
  { name: "backslash escaped", input: "\\", expected: '"\\\\"' },
  { name: "newline escaped", input: "\n", expected: '"\\n"' },
  { name: "tab escaped", input: "\t", expected: '"\\t"' },
  { name: "control char u0001", input: "\u0001", expected: '"\\u0001"' },

  // Arrays keep order.
  {
    name: "array preserves order",
    input: [3, 1, 2],
    expected: "[3,1,2]",
  },

  // Nested + realistic envelope shape.
  {
    name: "nested envelope-like",
    input: {
      version: "0.8",
      risk_level: "critical",
      reason_codes: [
        { code: "OFAC_SANCTIONED", severity: "critical" },
      ],
    },
    expected:
      '{"reason_codes":[{"code":"OFAC_SANCTIONED","severity":"critical"}],"risk_level":"critical","version":"0.8"}',
  },

  // undefined value in object is dropped (JSON.stringify semantic).
  {
    name: "undefined value in object dropped",
    input: { a: 1, b: undefined, c: 2 },
    expected: '{"a":1,"c":2}',
  },
  {
    name: "undefined in array -> null",
    input: [1, undefined, 3],
    expected: "[1,null,3]",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = canonicalize(c.input);
  if (got === c.expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${c.name}`);
    console.error(`  expected: ${c.expected}`);
    console.error(`  got:      ${got}`);
  }
}

// Refuse to serialize non-finite numbers.
try {
  canonicalize(NaN);
  fail++;
  console.error("FAIL: NaN should throw");
} catch { pass++; }
try {
  canonicalize(Infinity);
  fail++;
  console.error("FAIL: Infinity should throw");
} catch { pass++; }

// Refuse bigint (RFC 8785 does not define bigint canonicalization).
try {
  canonicalize(1n);
  fail++;
  console.error("FAIL: bigint should throw");
} catch { pass++; }

console.log(`canonical-json: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

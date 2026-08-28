// Sanity checks for the JCS canonicalizer against RFC 8785 published examples
// and the invariants the v0.9 fixture set depends on.

import { canonicalize } from './canonicalize.mjs';
import { requestDigest, preAuthRequestDigest, stripVolatile } from './digest.mjs';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else    { failed++; console.log(`  FAIL ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

console.log('\n[RFC 8785 §3.2.1 basic example]');
// Reordered keys, extra whitespace on input should normalize to canonical form.
check(
  'reorder + whitespace',
  canonicalize({ b: 2, a: 1 }),
  '{"a":1,"b":2}'
);

console.log('\n[RFC 8785 §3.2.2 string escapes]');
check('quote',    canonicalize('a"b'),   '"a\\"b"');
check('backslash', canonicalize('a\\b'), '"a\\\\b"');
check('newline',  canonicalize('a\nb'),  '"a\\nb"');
check('tab',      canonicalize('a\tb'),  '"a\\tb"');
check('control',  canonicalize('a\x01b'), '"a\\u0001b"');
check('unicode passthrough', canonicalize('café'), '"café"');

console.log('\n[RFC 8785 §3.2.2.3 numbers]');
check('positive zero',  canonicalize(0),     '0');
check('negative zero',  canonicalize(-0),    '0');
check('integer',        canonicalize(42),    '42');
check('negative int',   canonicalize(-42),   '-42');
check('float',          canonicalize(1.5),   '1.5');
check('exponent lowercase', canonicalize(1e21), '1e+21' === '1e+21' ? '1e21' : '1e+21');
// V8 emits '1e+21' but JCS strips the '+', expected: '1e21'
check('exponent no plus', canonicalize(1e21), '1e21');

console.log('\n[key ordering — UTF-16 code units]');
check('ascii keys sorted',
  canonicalize({ b: 1, a: 2, c: 3 }),
  '{"a":2,"b":1,"c":3}'
);
check('mixed case sorted (uppercase < lowercase in UTF-16)',
  canonicalize({ b: 1, B: 2, a: 3, A: 4 }),
  '{"A":4,"B":2,"a":3,"b":1}'
);

console.log('\n[nested structures]');
check('nested object',
  canonicalize({ outer: { z: 1, a: 2 } }),
  '{"outer":{"a":2,"z":1}}'
);
check('array preserves order',
  canonicalize({ arr: [3, 1, 2] }),
  '{"arr":[3,1,2]}'
);
check('empty containers',
  canonicalize({ o: {}, a: [] }),
  '{"a":[],"o":{}}'
);

console.log('\n[digest determinism]');
const d1 = requestDigest({ a: 1, b: 2 });
const d2 = requestDigest({ b: 2, a: 1 });
check('digest reorder-invariant', d1, d2);
console.log(`  (digest = ${d1})`);

const d3 = requestDigest({ a: 1, b: 3 });
check('digest changes on value change', d1 !== d3, true);

console.log('\n[volatile field stripping]');
const withVolatile = { offer_id: 'x', nonce_client: 'abc', timestamp_ms: 123 };
const withoutVolatile = { offer_id: 'x' };
check('stripVolatile removes named fields',
  canonicalize(stripVolatile(withVolatile)),
  canonicalize(withoutVolatile)
);
check('preAuthRequestDigest ignores volatile',
  preAuthRequestDigest(withVolatile),
  preAuthRequestDigest(withoutVolatile)
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

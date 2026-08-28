// RFC 8785 JSON Canonicalization Scheme (JCS) implementation.
//
// Spec reference: https://www.rfc-editor.org/rfc/rfc8785
//
// Key invariants enforced:
//   - Object keys sorted lexicographically by UTF-16 code unit (the JS default
//     for String comparisons; matches RFC 8785 §3.2.3).
//   - Strings escaped per RFC 8259 §7 with the JCS exceptions in RFC 8785 §3.2.2.
//   - Numbers serialized per ECMA-404 / RFC 8785 §3.2.2.3 using the double-
//     precision "shortest round-trip" representation. We rely on V8's built-in
//     Number.prototype.toString(), then normalize the few edge cases JCS
//     mandates (positive zero, no trailing decimals for integers ≤ 2^53).
//   - Unicode NFC normalization is NOT applied by JCS itself. Callers that
//     need NFC (recommended for spec conformance across implementations)
//     should normalize before passing objects in.
//   - No trailing whitespace, no insignificant whitespace anywhere.
//
// This implementation is deliberately dependency-free.

const JCS_STRING_ESCAPES = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

function serializeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (JCS_STRING_ESCAPES[cp] !== undefined) {
      out += JCS_STRING_ESCAPES[cp];
    } else if (cp < 0x20) {
      out += '\\u' + cp.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number ${n} is not permitted`);
  }
  if (n === 0) return '0'; // collapses +0 and -0 per RFC 8785 §3.2.2.3
  // V8's Number.prototype.toString() emits the shortest round-trip form,
  // matching the ECMAScript ToString(Number) algorithm that JCS builds on.
  let s = n.toString();
  // JCS wants lowercase 'e' — JS already emits lowercase, but be explicit.
  s = s.replace('E', 'e');
  // JCS §3.2.2.3 requires no leading '+' on exponents.
  s = s.replace('e+', 'e');
  return s;
}

function serialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'string') return serializeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[' + value.map(serialize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(); // UTF-16 code unit order
    if (keys.length === 0) return '{}';
    const parts = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      parts[i] = serializeString(k) + ':' + serialize(value[k]);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}

/**
 * Canonicalize a JSON-serializable value per RFC 8785.
 * @param {*} value - any JSON-serializable value
 * @returns {string} canonical JSON representation
 */
export function canonicalize(value) {
  return serialize(value);
}

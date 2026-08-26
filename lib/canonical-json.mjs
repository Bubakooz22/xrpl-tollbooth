// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// Rules enforced:
//   1. Object keys sorted lexicographically by their UTF-16 code units
//      (matches the ECMAScript sort for strings, which is what JS
//      does natively on Array.prototype.sort of code-point-BMP strings).
//   2. No insignificant whitespace: no spaces or newlines between tokens.
//   3. Strings serialized per RFC 8259 § 7 with the RFC 8785 escape
//      set: only \" \\ \b \f \n \r \t and \u00XX for control chars.
//      Characters that don't need escaping are emitted verbatim as UTF-8.
//   4. Numbers serialized per RFC 8785 § 3.2.2.3 (ECMAScript ToString for
//      finite doubles). This module refuses to serialize NaN/Infinity —
//      they are not permitted in canonical JSON. Integers safely
//      representable as doubles print without a decimal point.
//   5. Arrays are ordered by their input order (arrays have meaningful order).
//   6. `undefined` values inside objects are treated as "key not present"
//      (matches JSON.stringify semantics). `undefined` inside an array
//      becomes `null`.
//
// This is used to derive:
//   - envelope_hash: sha256 of canonical(envelope-minus-envelope_hash-field)
//   - signing input: canonical(envelope) fed to Ed25519.Sign
//
// Any deviation in canonicalization breaks signature verification, so this
// file MUST be byte-for-byte deterministic across Node versions.

const TWO_HEX = (n) => n.toString(16).padStart(2, "0");
const FOUR_HEX = (n) => n.toString(16).padStart(4, "0");

function serializeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';           // "
    else if (c === 0x5c) out += "\\\\";      // \
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + FOUR_HEX(c);
    else out += s[i];
  }
  out += '"';
  return out;
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new Error(`canonical-json: refusing to serialize non-finite number ${n}`);
  }
  // JS's ToString for a finite Number matches ECMAScript §7.1.12.1, which
  // RFC 8785 § 3.2.2.3 defers to. Node's toString gives the same output.
  // Special-case: negative zero -> "0" per RFC 8785 § 3.2.2.3 step 1.
  if (Object.is(n, -0)) return "0";
  return n.toString();
}

function serializeValue(v) {
  if (v === null) return "null";
  if (v === undefined) return "null"; // only reached inside arrays
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return serializeNumber(v);
  if (t === "bigint") {
    // RFC 8785 has no notion of bigints; require caller to stringify or
    // convert to Number if it fits. Fail loudly rather than silently truncate.
    throw new Error("canonical-json: bigint not permitted; convert upstream");
  }
  if (t === "string") return serializeString(v);
  if (Array.isArray(v)) return serializeArray(v);
  if (t === "object") return serializeObject(v);
  throw new Error(`canonical-json: unsupported type ${t}`);
}

function serializeArray(arr) {
  let out = "[";
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out += ",";
    // undefined inside an array -> null (matches JSON.stringify)
    out += serializeValue(arr[i] === undefined ? null : arr[i]);
  }
  out += "]";
  return out;
}

function serializeObject(obj) {
  // Collect defined keys, sort by UTF-16 code-unit order.
  const keys = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue; // JSON.stringify semantic
    keys.push(k);
  }
  keys.sort(); // ECMAScript default = UTF-16 code-unit order.
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    out += serializeString(keys[i]);
    out += ":";
    out += serializeValue(obj[keys[i]]);
  }
  out += "}";
  return out;
}

/**
 * Canonicalize a JSON-serializable JS value per RFC 8785.
 * Returns a UTF-8 string suitable for hashing or signing.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  return serializeValue(value);
}

/**
 * Canonicalize and return the UTF-8 Buffer, which is what hash/sign
 * functions actually consume. Provided so callers don't have to remember
 * to Buffer.from(..., "utf8") every time.
 *
 * @param {*} value
 * @returns {Buffer}
 */
export function canonicalizeToBuffer(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

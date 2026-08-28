# Number formatting

JCS mandates the ECMAScript "shortest round-trip" number representation.
Different sources may emit the same numeric value in different textual
forms (1 vs 1.0 vs 1e0); after JSON.parse they're indistinguishable,
and the canonicalizer emits one form for all of them.

Compliant implementations MUST parse JSON into their language's
number type before canonicalizing — they must NOT preserve the input
text form.

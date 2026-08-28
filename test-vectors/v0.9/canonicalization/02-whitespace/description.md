# Whitespace insensitivity

Pretty-printed and minified serializations of the same JSON value must
digest identically. Whitespace outside string literals carries no
semantic meaning; the canonicalizer strips it entirely.

Note: the inputs here are STRINGS, not objects, because the whole point
is that the on-the-wire byte representations differ. A compliant
verifier must JSON.parse each input and then canonicalize the parsed
value.

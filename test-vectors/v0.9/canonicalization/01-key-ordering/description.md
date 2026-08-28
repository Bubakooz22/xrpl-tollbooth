# Key ordering

Object keys must be sorted lexicographically by UTF-16 code unit before
hashing. All three inputs describe the same object with keys emitted in
different orders on the wire; all three must digest identically.

## Why this matters

If two implementations disagree on key order, they will produce
different digests for the same request, and every signature will fail
verification. This is the single most common canonicalization bug in
production.

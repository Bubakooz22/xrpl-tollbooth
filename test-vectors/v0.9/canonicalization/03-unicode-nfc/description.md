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

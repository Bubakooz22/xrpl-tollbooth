# 12-volatile-signature — volatile fields: __sig and __timestamp

Two PreAuthEnvelopes identical in every semantic field but
differing in `__sig` and `__timestamp`. Because both are on the
v0.9 volatile-field allowlist, both envelopes MUST produce the same
`preAuthRequestDigest`.

The signature is a wrapper AROUND the digest, not a component OF
the digest. This is the fixture that catches a common
implementation bug: hashing the envelope after it has been signed
(digest ends up covering `__sig`, which is uncomputable
in-band).

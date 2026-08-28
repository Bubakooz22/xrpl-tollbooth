# 09-volatile-nonce-client — volatile field: nonce_client

Two PreAuthEnvelopes identical in every semantic field but
differing in `nonce_client`. Because `nonce_client` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
`preAuthRequestDigest`.

Nonces are anti-replay metadata. They are bound elsewhere in the
signed envelope wrapper, not into the semantic identity of the
request itself.

# 10-volatile-timestamp — volatile field: timestamp_ms

Two PreAuthEnvelopes identical in every semantic field but
differing in `timestamp_ms`. Because `timestamp_ms` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
`preAuthRequestDigest`.

The wall clock is transport metadata used for freshness checks in
the outer signed wrapper; it is not part of the request's semantic
identity.

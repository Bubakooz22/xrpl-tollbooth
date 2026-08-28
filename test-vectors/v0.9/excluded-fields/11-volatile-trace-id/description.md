# 11-volatile-trace-id — volatile field: trace_id

Two PreAuthEnvelopes identical in every semantic field but
differing in `trace_id`. Because `trace_id` is on the v0.9
volatile-field allowlist, both envelopes MUST produce the same
`preAuthRequestDigest`.

Trace IDs are observability metadata. Two different buyers of the
same authorization envelope will emit different trace IDs; that
must not fork the semantic identity of the request.

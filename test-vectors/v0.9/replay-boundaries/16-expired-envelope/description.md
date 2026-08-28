# 16-expired-envelope — rejection: envelope past valid_until

An implementation MUST reject an attempt whose
envelope's `valid_until` is strictly before the attempt's
`submitted_at`. The rejection MUST happen before nonce lookup, so
the nonce remains fresh (unconsumed) — a replay of the same nonce
with a fresh envelope is still permitted.

The failure mode this catches: an implementation that consumes the
nonce first and then checks expiry burns the nonce on an
already-invalid envelope. That would let an attacker force-consume
a victim's nonce by replaying stale envelopes.

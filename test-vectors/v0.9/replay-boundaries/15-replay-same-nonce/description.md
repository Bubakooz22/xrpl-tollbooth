# 15-replay-same-nonce — rejection: nonce already consumed

An implementation MUST reject an attempt whose
`nonce_client` already appears in the consumed-nonce set for the
current budget period. The rejection MUST leave the ledger unchanged:
the nonce is already consumed (unchanged), no additional budget is
deducted, no new settlement is recorded.

This is the primary anti-replay test. Its failure mode is a
double-charge: buyer signs one authorization, seller consumes it
twice, buyer's budget is depleted at 2x rate.

The nonce_status remains "consumed" (not "fresh") because the nonce
was already consumed BEFORE this attempt. The invariant we assert is
that this attempt did not further modify state.

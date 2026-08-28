# 17-budget-exhausted — rejection: budget cap reached

An implementation MUST reject an attempt whose
`charge_xrp` plus the current period's `budget_consumed_xrp`
exceeds the envelope's `max_spend_xrp`. The rejection MUST happen
before nonce lookup, so the nonce remains fresh.

The failure mode this catches: partial charge. An implementation that
deducts the allowable remainder and rejects the overage would violate
the authorization contract (the buyer authorized 0.05 total, not "up
to 0.05 with partial charge on the last attempt").

Budget is checked at the aggregate level (period-wide), not
per-attempt.

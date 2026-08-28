# 14-fresh-accept — positive baseline: fresh envelope, unused nonce

An implementation MUST accept a well-formed
PreAuthEnvelope submitted with an unused nonce within its validity
window, against an authorized endpoint, when the buyer's budget has
remaining capacity.

The terminal state records the state transition: nonce marked
consumed, budget deducted by the attempt's charge amount, settlement
reference set.

This is the baseline positive case; every subsequent Tier 3 fixture
is a rejection.

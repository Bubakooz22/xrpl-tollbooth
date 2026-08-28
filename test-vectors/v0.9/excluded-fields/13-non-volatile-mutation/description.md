# 13-non-volatile-mutation — negative: non-volatile field mutation

Two PreAuthEnvelopes differing in a NON-volatile field
(`max_spend_xrp`: 0.05 vs 0.50). Both include identical volatile
fields. The digests MUST differ.

This is the critical safety test: it proves that the volatile-field
allowlist is a whitelist, not a blacklist. If an implementation
accidentally strips too much (for example, strips every field
starting with an underscore, or every field matching a heuristic),
this fixture will pass equality and fail Tier 2 loudly.

An implementation that widens the allowlist without spec approval
breaks payment integrity: a buyer signs authorization for 0.05 XRP,
the seller settles for 0.50 XRP, and the digests still match.

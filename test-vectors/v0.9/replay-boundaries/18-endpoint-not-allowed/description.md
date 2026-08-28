# 18-endpoint-not-allowed — rejection: attempt outside allowed_endpoints

An implementation MUST reject an attempt whose
`endpoint` is not present in the envelope's `allowed_endpoints`
list. The rejection MUST happen before nonce lookup, so the nonce
remains fresh.

The failure mode this catches: authorization laundering. An envelope
authorizes `/wallet-risk` cheaply; without endpoint scoping, an
attacker could redirect the authorization to a more expensive
endpoint like `/tx-simulate-risk` at a higher charge.

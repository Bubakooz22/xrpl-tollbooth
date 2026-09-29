# XRPL Toll Booth

Pay-per-call risk signals and verification tools for Web3 integrations, using x402 payments on XRP Ledger mainnet (`xrpl:0`). Risk signals are not a guarantee of transaction safety, complete sanctions coverage, or a security audit.

## Production API

- **Base URL:** [https://api.txnguardian.com](https://api.txnguardian.com).
- **API contract:** [OpenAPI](https://api.txnguardian.com/.well-known/openapi.json).
- **Agent discovery:** [Agent manifest](https://api.txnguardian.com/.well-known/agent.json).
- **Payment discovery:** [Current sample offers](https://api.txnguardian.com/.well-known/x402).
- **Public signing keys:** [Key manifest](https://api.txnguardian.com/.well-known/tollbooth-keys.json).

| Method and path | Purpose | Access | Successful response formats |
|---|---|---|---|
| POST `/wallet-risk` | Wallet risk signals | x402 | JSON; opt-in v0.8 |
| POST `/contract-risk` | Contract risk signals | x402 | JSON; opt-in v0.8 |
| POST `/tx-simulate-risk` | Ethereum transaction simulation on a local mainnet fork | x402 | JSON; opt-in v0.8 |
| POST `/scope-check` | Lookup against a local bounty-scope dataset | x402 | JSON only |
| POST `/verify-poc` | Foundry PoC grading on a mainnet fork | x402 | JSON; opt-in v0.8 |
| GET `/auth-ping` | Check an existing API key | Bearer API key | JSON |

The five paid routes advertised 5,000 drops (0.005 XRP) or 0.002 RLUSD on September 29, 2026; network fees are additional when not sponsored ([payment discovery](https://api.txnguardian.com/.well-known/x402)). These are dated observations, not a fixed-price guarantee; use the fresh challenge for the exact endpoint and request.

## Payment flow

1. POST JSON to the desired endpoint without a payment header.
2. Expect HTTP 402 with `PAYMENT-REQUIRED`, containing base64-encoded JSON payment requirements. This challenge is delivered over HTTPS; it is not a signed v0.8 report.
3. A compatible x402 XRPL client must validate the network, merchant, asset/issuer, amount, resource and expiry; enforce a total spend/fee cap before signing.
4. Retry the same request with `PAYMENT-SIGNATURE`. Signing may authorize a real XRP Ledger mainnet payment; do not automate funded retries without explicit spending controls.
5. Inspect the HTTP status, body and `PAYMENT-RESPONSE` receipt. Verify settlement independently; a settled payment does not by itself prove useful endpoint execution.

Do not use the historical `/challenge`, `/redeem`, `/gated`, DestinationTag/access-token flow or the old `pay-and-fetch.mjs` helper for this API. Those are not the current production integration.

### No-spend challenge example

This example requests a challenge only: it supplies no wallet or payment header, and performs no retry.

```sh
curl --silent --show-error --include \
  'https://api.txnguardian.com/tx-simulate-risk' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/vnd.tollbooth.v0.8+json' \
  --data '{"chain":"eth","from":"0x00000000000000000000000000000000a11ce123","to":"0x00000000000000000000000000000000cafe1234","data":"0x","value":"0"}'
```

Payment gating currently precedes request-body validation. Invalid input can therefore be charged; do not assume refunds or free retries. This revision preserves the available settlement receipt on the corrected early 400 paths, but does not promise receipts for every possible infrastructure failure.

## Signed-response boundaries

Request `Accept: application/vnd.tollbooth.v0.8+json` on wallet, contract, simulation or PoC routes. Only eligible HTTP 200 results are wrapped when signing is enabled; scope responses and errors remain ordinary JSON.

The v0.8 body is `{ "envelope": {...}, "signature": {...} }`. It authenticates the risk report, canonical request hash, issuance/expiry and key identifier; it does not contain raw simulation success/revert/gas/trace fields, and does not sign or include the XRP settlement receipt. Verify the separate receipt as well as the report.

Validate the response content type, envelope hash, Ed25519 signature, key identifier, request hash and timestamps. If wrapping fails, the server can return legacy JSON with `X-Tollbooth-V08-Warning: envelope_wrap_failed`; a caller requiring a signed report must reject that fallback. No cached replay or multi-party attestation guarantee is made here.

In legacy simulation JSON, check `success`, `reverted` and `reason_codes`, not just `risk_level`. A reverted transaction may carry a low risk label with `TX_REVERTED`; that is not a successful transaction. Even a successful no-flags result is not a safety guarantee.

## Verification status and limits

On September 29, 2026, one operator-funded XRP-mainnet `/tx-simulate-risk` call returned a verified signed high-risk `UNLIMITED_APPROVAL_GRANTED` result for a DAI approval. The recorded transaction is `D08E5E8FB029FAB97E04E0FCC36F8D55ADB3A7A4E7F4AEB56F55E4EFE7E70C6A`; total spend was 0.005012 XRP including the fee.

Four earlier isolated Ethereum mainnet-fork controls covered a benign transfer, bounded approval, unlimited approval and reverted transfer. This is bounded product verification, not independent customer revenue, proof of all endpoint paths, RLUSD end-to-end verification, or a general security audit.

No latency percentile, dataset-refresh SLA or exact coverage count is promised. The PoC x402 handler has no application-level per-key limiter; its old 10/minute API-key claim is withdrawn. Paid-route workload admission needs separate review before broad PoC promotion; this revision does not add that protection.

## Operator notes

Production source and published discovery must be reconciled from the verified deployed snapshot, not overwritten with an older checkout. The discovery documents are loaded at service startup, so publishing repository files alone does not update the running API.

The documentation revision `2026.09.29` is separate from the response-envelope protocol version `0.8`. Bearer access for `/auth-ping` and master-key access for administrative routes are unchanged; no new features, payment rails or key rotation are included.

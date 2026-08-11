# x402 on XRPL — Spec Research Notes (2026-08-11)

Research to inform refactoring tollbooth.mjs from a custom /challenge+/redeem+bearer
flow to the standard x402 protocol. Sources listed at bottom. NO CODE CHANGED YET.

## TL;DR
- x402 turns HTTP `402 Payment Required` into a real handshake: server advertises
  payment requirements -> client pays on-chain -> client retries with proof ->
  server verifies (via a facilitator) -> server returns 200 + settlement ref.
- There are TWO header conventions depending on protocol version. This matters and
  the sources disagree (see "Version discrepancy" below).
- For XRPL specifically, the reference facilitator is t54 (xrpl-x402.t54.ai),
  using the `exact` scheme with a payer-SIGNED XRPL Payment transaction blob.

## 1) HTTP status code for "payment required"
- `402 Payment Required`. Unambiguous across all sources.

## 2) Response headers the merchant sends on 402
The 402 carries a base64-encoded JSON "payment requirements" envelope.
- x402 v2 (current spec): header name `PAYMENT-REQUIRED`.
- x402 v1 (older / Coinbase early docs): requirements often placed in the JSON
  BODY as `{ x402Version, accepts: [...] }` rather than a header.
Requirements object / each entry of `accepts[]`:
  - `scheme`   : "exact" (fixed amount; also "upto", "batch" exist)
  - `network`  : CAIP-2-style id. XRPL uses `xrpl:0` (testnet-ish) / `xrpl:1`
                 per t54 middleware examples (network naming is a KNOWN AMBIGUITY).
  - `maxAmountRequired` (a.k.a. amount/price) : string, in asset base units
                 (XRP => DROPS; e.g. "1000" = 0.001 XRP)
  - `asset`    : "XRP" or an IOU (e.g. RLUSD with currency+issuer metadata)
  - `payTo` / `payToAddress` : merchant r-address
  - `resource` : the protected URL/path
  - `maxTimeoutSeconds` / expiry : payment validity window
  - `facilitatorUrl` : verify/settle endpoint (e.g. https://xrpl-x402.t54.ai)
  - `invoiceId` / invoice identifier : one-time id, bound into the XRPL tx
                 (via memo or InvoiceID field)

## 3) Request header the client sends after paying
- x402 v1: `X-PAYMENT` = base64(JSON { x402Version, scheme, network, payload }).
- x402 v2: `PAYMENT-SIGNATURE` = base64 payment payload.
- On XRPL (t54), the client retries with the SIGNED XRPL Payment transaction
  blob inside that header (t54 docs use `PAYMENT-SIGNATURE`; the xrpl.org doc
  uses `X-PAYMENT`). => Support/accept BOTH header names when we implement.

## 4) How the merchant verifies
Two-party model: resource server (us) + facilitator (t54).
- Merchant does NOT need to run its own chain logic; it forwards the payment
  payload to the facilitator's verify endpoint.
- Facilitator checks tx invariants: destination match, amount match, asset match,
  invoice binding (memo/InvoiceID), signature validity.
- Facilitator SETTLES by submitting the signed tx to XRPL (~4s), then returns a
  signed receipt.
- Merchant can alternatively do a direct on-chain check (our current account_tx
  approach) but the x402-standard path is facilitator verify+settle.

## 5) How XRPL encodes the payment proof
- `exact` scheme = a payer-SIGNED (presigned) XRPL `Payment` transaction blob
  (NOT just a tx hash). The facilitator submits it.
- Amount: XRP in drops; IOUs use {currency, issuer, value}.
- Invoice binding: invoice id embedded in tx Memos or the XRPL `InvoiceID` field.
- NOTE: xrpl.org's narrative says the agent submits the tx itself then sends the
  tx HASH to the facilitator for a receipt; t54's docs say the client sends the
  SIGNED BLOB and the facilitator submits it. => two integration styles
  (client-submits-then-hash vs facilitator-submits-blob). Confirm against the
  actual t54 API before coding.

## 6) Facilitator services for XRPL x402
- t54: https://xrpl-x402.t54.ai (public), docs https://docs.t54.ai/docs/xrpl/x402-facilitator
  Supports XRP + IOUs (RLUSD, USDC). Provides `requirePayment`/`require_payment`
  middleware and decode helpers. This is the de-facto XRPL facilitator today.
- SDKs: PyPI `x402-xrpl`, `xrpl-x402-client` (buyer-side). npm: `x402` core +
  `x402-express`/`x402-hono`/`x402-next`; `@x402/*` scoped packages for v2.
  (These are EVM/Solana-first; XRPL support is via t54's packages.)

## Version discrepancy (IMPORTANT before refactor)
- v1 headers: request `X-PAYMENT`; requirements typically in 402 JSON body
  (`x402Version:1`, `accepts[]`).
- v2 headers: `PAYMENT-REQUIRED` (402), `PAYMENT-SIGNATURE` (retry),
  `PAYMENT-RESPONSE` (200). New `SIGN-IN-WITH-X` coming.
- xrpl.org doc uses v1-style `X-PAYMENT`; t54 + x402.org v2 use the
  PAYMENT-* trio. Decide which version to target (recommend v2 header trio,
  but accept `X-PAYMENT` for back-compat).

## Settlement response (200)
- Optional `PAYMENT-RESPONSE` header (base64 JSON) with settlement details incl.
  the settled tx hash.

## Sources
- xrpl.org/docs/agents/agentic-payments-x402 (Ripple official; v1-style X-PAYMENT)
- x402.org and x402.org/x402-v2-launch (canonical spec; v2 PAYMENT-* headers)
- github.com/coinbase/x402 (fork of x402-foundation/x402; reference impl, exists)
- docs.t54.ai/docs/xrpl/x402-facilitator + xrpl-x402.t54.ai (XRPL facilitator)
- Avalanche Builder Hub, Faremeter, PayAI, Stripe x402 docs (cross-checks)
- PyPI: x402-xrpl, xrpl-x402-client ; npm: x402, x402-express, @x402/*

---

## SDK Source Review (Section 2) — official Coinbase x402 packages

Source: `npm pack @x402/core@2.21.0` and `@x402/evm@2.21.0` (Apache-2.0), inspected
`.d.mts` type declarations + compiled `.mjs`. No local SDK is installed in this
project (only `xrpl@^5`), so review was against upstream published sources.

### Package landscape
- `x402@1.2.0` (top-level), `@x402/core@2.21.0`, `@x402/extensions`, `@x402/evm`,
  `@x402/svm` (Solana), `@coinbase/x402@2.1.0`.
- IMPORTANT: there is **no `@x402/xrpl` package**. XRPL is NOT in the official
  Coinbase SDK. XRPL x402 support is provided by the **t54 facilitator service**
  (see t54-live-probe.md), not by a client-side chain adapter.
- `@x402/core` is chain-agnostic (only dep: `zod`). Chain adapters plug in via
  `register(network, server)`.

### Protocol wire types (@x402/core, authoritative)
- `Network` = template literal `` `${string}:${string}` `` (CAIP-2 style, e.g.
  `eip155:8453`; XRPL would be e.g. `xrpl:testnet` / a t54-defined id).
- `PaymentRequirements` = { scheme, network, asset, amount, payTo,
  maxTimeoutSeconds, extra: Record<string,unknown> }.
- `PaymentRequired` (402 body) = { x402Version, error?, resource: ResourceInfo,
  accepts: PaymentRequirements[], extensions? }.
- `PaymentPayload` (client->server) = { x402Version, resource?, accepted:
  PaymentRequirements, payload: Record<string,unknown>, extensions? }.
  -> the chain-specific signed authorization/tx blob goes in `payload`.
- `VerifyRequest`  = { x402Version, paymentPayload, paymentRequirements }.
- `VerifyResponse` = { isValid, invalidReason?, invalidMessage?, payer?,
  extensions?, extra? }.
- `SettleRequest`  = { x402Version, paymentPayload, paymentRequirements }.
- `SettleResponse` = { success, errorReason?, errorMessage?, payer?,
  transaction (string = on-chain tx hash), network, amount?, extensions?, extra? }.
- `SupportedResponse` = { kinds: {x402Version, scheme, network, extra?}[],
  extensions: string[], signers: Record<string,string[]> }.

### Facilitator interface (maps 1:1 to t54 probed endpoints)
- `verify(paymentPayload, paymentRequirements): Promise<VerifyResponse>`  -> /verify
- `settle(paymentPayload, paymentRequirements): Promise<SettleResponse>`  -> /settle
- `getSupported(): Promise<SupportedResponse>`                            -> /supported

### AMBIGUITY RESOLUTIONS
1. HTTP header names (was: X-PAYMENT vs PAYMENT-SIGNATURE?)
   Confirmed both eras coexist in v2.21 core:
   - 402 challenge  header: `PAYMENT-REQUIRED`  (base64 PaymentRequired)
   - client payment header: `PAYMENT-SIGNATURE` (base64 PaymentPayload)  [v2]
   - success receipt header:`PAYMENT-RESPONSE`  (base64 SettleResponse)  [v2]
   - legacy/v1 equivalents: `X-PAYMENT` / `X-PAYMENT-RESPONSE`
   - lowercase variants also read: `payment-signature`, `payment-verified`,
     `payment-error`.
   Server read logic: getHeader("payment-signature") || getHeader("PAYMENT-SIGNATURE").
   Client read logic: getHeader("PAYMENT-REQUIRED"); getHeader("X-PAYMENT-RESPONSE").
   base64 codec fns: encode/decodePaymentRequiredHeader, *SignatureHeader,
   *ResponseHeader (all base64 JSON).

2. Who submits the on-chain transaction? (was: server or facilitator?)
   The FACILITATOR submits. `SettleResponse.transaction` is the returned tx hash,
   and EVM adapter states signature "pre-verification ... is deferred to on-chain
   simulation or settle." Client signs; facilitator broadcasts on settle().
   -> Our tollbooth (resource server) should: return 402 w/ PaymentRequired,
      receive PAYMENT-SIGNATURE, call facilitator /verify then /settle, and
      return PAYMENT-RESPONSE with the tx hash. We do NOT broadcast ourselves.

3. x402Version / scheme
   - core schema accepts `x402Version` literal 1 and 2 (both supported).
   - scheme is a free string; EVM uses `exact` (and `upto` for batch). XRPL scheme
     name is defined by t54 /supported (query live before hardcoding).
   - `extra` on PaymentRequirements carries scheme config (e.g. asset decimals,
     default 6 fallback).

### Net implication for the refactor (NOT yet applied)
- Build on `xrpl@5` + raw HTTP to t54 facilitator; no chain adapter pkg needed.
- Query t54 /supported at startup to get exact {x402Version, scheme, network}
  and the signer/asset requirements before hardcoding PaymentRequirements.

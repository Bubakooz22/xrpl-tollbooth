# t54 Facilitator — Live Probe (2026-08-11)

Read-only probing to resolve ambiguities from docs/x402-spec-notes.md.
NO tollbooth.mjs / .env changes. Public data only.

## Hosts probed
| URL | GET status | Content-Type | Notes |
|-----|-----------|--------------|-------|
| https://xrpl-x402.t54.ai/ | 200 | text/html | Next.js marketing/docs site on Vercel (`server: Vercel`). NOT the API. |
| https://xrpl-x402.t54.ai/supported | 404 | text/html | Vercel catch-all 404 |
| https://xrpl-x402.t54.ai/networks | 404 | text/html | Vercel catch-all 404 |
| https://xrpl-x402.t54.ai/health | 404 | text/html | Vercel catch-all 404 |
| https://xrpl-x402.t54.ai/v1/supported | 404 | text/html | Vercel catch-all 404 |
| https://xrpl-x402.t54.ai/.well-known/x402 | 404 | text/html | Vercel catch-all 404 |
| https://xrpl-x402.t54.ai/verify | 404 | text/html | Vercel catch-all 404 (no method-not-allowed; endpoint not here) |
| https://xrpl-x402.t54.ai/settle | 404 | text/html | same |
| https://xrpl-x402.t54.ai/api/verify | 404 | text/html | same |
| https://xrpl-x402.t54.ai/openapi.json | 404 | text/html | same |
| https://facilitator.t54.ai/health | 000 | - | DNS does not resolve |
| https://api.xrpl-x402.t54.ai/supported | 000 | - | DNS does not resolve |
| https://docs.t54.ai/docs/xrpl | 404 | text/html | docs root 404; only /docs/xrpl/x402-facilitator sub-page exists |
| https://api.t54.ai/health | 200 | application/json | REAL API host. `server: uvicorn` (FastAPI). Body: {"status":"healthy"} |
| https://api.t54.ai/docs | 200 | text/html | FastAPI Swagger UI; references schema at /api/v1/openapi.json |
| https://api.t54.ai/api/v1/openapi.json | 200 | application/json | Full OpenAPI, 71 paths |

## api.t54.ai OpenAPI (/api/v1/openapi.json) — relevant finding
- 71 paths total. Domains: projects, balance/agent, api_key, users, login,
  agent_details, radar/audit, tportal/auth, payment_rules, websocket,
  virtual_account/withdraw.
- grep for x402|facilitator|settle|supported|xrpl => NONE.
  Only `verify` matches are `/api/v1/users/verify-email` and
  `/api/v1/virtual_account/withdraw/verify` (unrelated to x402).
- Conclusion: api.t54.ai is t54's Trustline PLATFORM API, NOT the x402
  facilitator verify/settle service. The facilitator's HTTP verify/settle
  endpoints are NOT publicly discoverable at the hosts probed above.

## Answers to Q1–Q5 (from live probe alone; see SDK section for more)
- Q1 (network id testnet vs mainnet): NOT resolved by live probe. Docs use
  `xrpl:0` / `xrpl:1` in middleware examples but no live discovery endpoint
  exposes the mapping. -> resolve via SDK source or email t54.
- Q2 (who submits the tx): docs contradict (xrpl.org = client submits then sends
  hash; t54 docs = facilitator submits signed blob). NOT resolved by probe.
  -> resolve via SDK source.
- Q3 (exact verify/settle paths): NOT found on any live host probed.
  -> resolve via SDK source or email t54.
- Q4 (/verify request body shape): no public OpenAPI for the facilitator found.
  -> resolve via SDK source.
- Q5 (testnet vs mainnet facilitator URLs): only one public host found
  (xrpl-x402.t54.ai, marketing). No separate testnet facilitator URL exposed.
  -> resolve via SDK source or email t54.

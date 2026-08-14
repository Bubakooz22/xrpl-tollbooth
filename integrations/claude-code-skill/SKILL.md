---
name: xrpl-tollbooth
description: Pay-per-call cybersecurity checks on XRPL. Use when the user wants to check a wallet for OFAC/scam-list membership, score a smart contract for known-exploit or heuristic risk, simulate an Ethereum transaction for unlimited approvals/ownership transfer/proxy upgrade/selfdestruct/reverts, check whether an address is in scope of any bug bounty program, verify a Foundry PoC against a mainnet fork, or ping the tollbooth to confirm the API key works. Trigger keywords include "wallet risk", "OFAC check", "sanctioned address", "contract risk", "known exploit", "simulate transaction", "unlimited approval", "scope check", "bounty scope", "verify PoC", "Foundry PoC", "grade this exploit".
---

# XRPL Toll Booth — Cybersecurity API skill

You have access to a live tollbooth on this droplet that charges 1000 drops XRP per call (or 0.002 RLUSD) settled on-chain via the x402 protocol, plus two API-key-gated endpoints in closed beta. Every helper handles auth and payment automatically.

## Before you call anything

Read the current manifest to see which endpoints are live and what they cost:

```bash
node integrations/claude-code-skill/helpers/list-endpoints.mjs
```

The manifest source of truth is `http://127.0.0.1:8787/.well-known/agent.json` — if a user asks "what can this API do", read that file instead of guessing.

## Endpoints and when to call each

| User intent | Helper | Auth | Cost |
|---|---|---|---|
| Check if an address is sanctioned or on a scam list | `walletRisk` | x402 | 1000 drops |
| Score a smart contract for known-exploit match / source heuristics | `contractRisk` | x402 | 1000 drops |
| Simulate an ETH transaction and detect malicious side effects | `txSimulateRisk` | x402 | 1000 drops |
| Check whether an address is in any bug bounty program's scope | `scopeCheck` | x402 | 1000 drops |
| Grade a Foundry `.t.sol` PoC against a mainnet fork | `verifyPoc` | API key | closed beta |
| Confirm the API key works | `authPing` | API key | closed beta |

## How to invoke a helper

All helpers are node scripts under `integrations/claude-code-skill/helpers/`. They read `TOLLBOOTH_URL` (default `http://127.0.0.1:8787`), `XRPL_SEED` (payer, from `.env`), and `TOLLBOOTH_API_KEY` (Bearer key, from `.env`) at runtime.

Example — wallet risk check:

```bash
node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs \
  walletRisk '{"chain":"eth","address":"0x8589427373D6D84E98730D7795D8f6f8731FDA16"}'
```

Example — verify a Foundry PoC:

```bash
node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs \
  verifyPoc '{"test_file":"'$(base64 -w0 /path/to/test.t.sol)'","expected_result":"revert"}'
```

Every helper prints JSON to stdout on success and non-zero exits on failure. Parse the JSON; the important fields are `risk_level` / `risk_score` / `reason_codes[]` for risk endpoints and `verified` / `reason_codes[]` for PoC verification.

## Reason codes

Every risk and verify endpoint returns a stable `reason_codes[]` array. Do not interpret prose — branch on codes. Full catalog with recommended actions in `references/reason-codes.md`.

Key codes to know:

- `OFAC_SANCTIONED` — refuse to interact. This wallet is on the U.S. Treasury OFAC list.
- `SCAM_LIST_HIT` — refuse to transact. Curated scam-address database match.
- `UNLIMITED_APPROVAL_GRANTED` — hard warning. The simulated tx would give the target contract permission to move any amount of an ERC-20.
- `OWNERSHIP_TRANSFERRED` / `PROXY_UPGRADED` / `SELFDESTRUCT_INVOKED` — hard warnings on tx simulation.
- `POC_VERIFIED` — the PoC ran and matched expected outcome. Finding is real.
- `POC_UNVERIFIED` — PoC compiled and ran but did not match expected outcome.
- `COMPILE_ERROR` / `PARSE_FAILURE` — user's PoC has a syntax problem; do not blame the API.

## Payment mechanics

The x402 endpoints charge 1000 drops (~$0.0005) per call. Payments settle on XRPL testnet via `https://xrpl-facilitator-testnet.t54.ai`. The payer wallet is configured on this droplet already; you do not need to construct payment payloads yourself. Just call the helper.

The two API-key endpoints (`verifyPoc`, `authPing`) use `Authorization: Bearer $TOLLBOOTH_API_KEY`. The key on this droplet is `tb_live_d169...` (see `.env`).

## When to refuse

If the tollbooth returns `risk_level: "critical"` or any of the codes above, tell the user directly and do not offer a workaround. This is a security tool — the "wait it's probably fine" instinct is wrong here.

## Example prompts

See `references/example-prompts.md` for six real prompts that trigger the skill correctly. Copy the shape when unsure.

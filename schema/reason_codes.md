# Reason Code Schema v1

Frozen as of Phase 2b (2026-08-13, commit `2e78822`).

The `/wallet-risk` endpoint returns a list of `reason_codes`. Each is an object with:

```json
{
  "code": "STRING",
  "severity": "critical" | "high" | "medium" | "low",
  "source": "STRING",
  "evidence": "STRING"
}
```

Severity → score mapping: `critical=100`, `high=40`, `medium=20`, `low=5`. Total score is capped at 100. `OFAC_SANCTIONED` short-circuits response to `score=100` without running further checks.

## Codes

| Code | Severity | Applies to | Trigger | Source tag |
|---|---|---|---|---|
| `OFAC_SANCTIONED` | critical | eth, base, xrpl, sol | Address on US Treasury SDN list | `us-treasury-sdn` |
| `SCAM_REPORTED` | high | eth, base | Address on MEW public darklist | `mew-darklist` |
| `MIXER_INTERACTION` | medium | eth | tx to/from Tornado Cash pool | `onchain` |
| `NEW_ACCOUNT` | low | eth, xrpl, sol | First tx < 7 days ago (only when full history seen) | `onchain` |
| `LOW_ACTIVITY` | low | eth, base, xrpl, sol | eth/base nonce<5, xrpl sequence<3, sol sigs<3 or account not found | `onchain` |
| `PROGRAM_ACCOUNT` | low | sol | account owner ≠ System Program | `onchain` |

## Chain coverage (v1)

| Chain | OFAC | Scam list | On-chain heuristics | Notes |
|---|---|---|---|---|
| eth | ✅ | ✅ (MEW) | Etherscan V2 — nonce, first-tx age, Tornado hits | Full coverage |
| base | ✅ (via eth list) | ✅ (via MEW list) | public Base RPC — nonce only | v0: no first-tx-age, no mixer coverage |
| xrpl | ✅ | — | XRPL testnet RPC — sequence, first-tx age | Testnet ledger |
| sol | ✅ | — | Solana mainnet RPC — sigs, first-tx age, program owner | Paginated (5×1000 sigs) |

## Sources tags (`sources_checked` field)

- `ofac_sdn_eth`, `ofac_sdn_xrpl`, `ofac_sdn_sol` — OFAC SDN lookups
- `ofac_sdn_base_via_eth` — Base OFAC check reusing the ETH SDN list (same L1 address space)
- `scam_lists_eth`, `scam_lists_base_via_eth` — MEW darklist lookups
- `onchain_eth`, `onchain_base`, `onchain_xrpl`, `onchain_sol` — on-chain heuristic fetches

## Notes field

`notes` is an optional array of freeform strings surfacing degraded coverage or upstream errors. Callers should not parse for logic; use `reason_codes` for that.

Current possible notes:
- `no_etherscan_key` — ETH on-chain checks skipped (`ETHERSCAN_API_KEY` env var missing)
- `base_v0_nonce_only` — Base coverage is nonce-only in v1
- `onchain_fetch_failed:<message>` — an on-chain fetcher threw
- `sol_info_<message>`, `sol_sigs_<message>` — Solana RPC returned an error
- `base_rpc_<message>` — Base RPC returned an error
- `xrpl_<status>`, `xrpl_fetch_failed:<message>` — XRPL RPC issue
- `evm_unknown_chain:<value>` — invalid `chain` override

## Response shape

```json
{
  "chain": "eth" | "base" | "xrpl" | "sol",
  "address": "<caller-provided>",
  "normalized_address": "<lowercase/trimmed>",
  "score": 0-100,
  "risk_level": "low" | "medium" | "high" | "critical",
  "reason_codes": [ ... ],
  "checked_at": "ISO-8601",
  "sources_checked": [ ... ],
  "cache_ttl_seconds": 3600,
  "notes": [ ... ]   // optional
}
```

If `OFAC_SANCTIONED` fires, `cache_ttl_seconds` is `86400` (longer cache for sanctions hits).

## Compatibility guarantees for v1

The following are contract-stable through v1:

- `code` string values (adding new codes is non-breaking; removing/renaming is breaking)
- `severity` enum values
- Response top-level fields (`chain`, `address`, `score`, `risk_level`, `reason_codes`, `checked_at`, `sources_checked`)
- Chain values (`eth`, `base`, `xrpl`, `sol`)

The following may change without a version bump:

- Contents of `notes` (freeform diagnostic)
- Contents of `evidence` per reason code (human-readable, not machine-parsed)
- New `source` values for existing codes (e.g., adding a second scam list)
- `cache_ttl_seconds` tuning

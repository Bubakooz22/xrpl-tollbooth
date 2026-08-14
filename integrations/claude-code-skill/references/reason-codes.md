# Reason codes — full catalog

Every risk and verify endpoint returns a `reason_codes[]` array. These are the stable strings you branch on. Do not try to interpret prose responses; the codes are the contract.

## `/wallet-risk`

| Code | Meaning | Recommended action |
|---|---|---|
| `OFAC_SANCTIONED` | Address matches a U.S. Treasury OFAC sanctions list entry (100 ETH, 1 XRPL, 4 SOL entries loaded). | **Refuse to interact.** Report to user with the specific list source. |
| `SCAM_LIST_HIT` | Address is on the curated scam-address database (652 ETH entries). | **Refuse to transact.** Warn user; if they insist, require an explicit override. |
| `UNKNOWN_ADDRESS` | No signal found. Not a green flag — just means this list didn't catch it. | Proceed, but do not assume safety. Consider running `contract-risk` if it's a contract. |

## `/contract-risk`

| Code | Meaning | Recommended action |
|---|---|---|
| `KNOWN_EXPLOIT_MATCH` | Address matches the curated exploit database. `known_exploit_match` object in response has the name and postmortem URL. | **Refuse to interact.** Show the postmortem link to the user. |
| `SELFDESTRUCT_PRESENT` | Source contains a `selfdestruct` opcode. | Warn user \u2014 contract can vanish with funds. |
| `DELEGATECALL_PRESENT` | Source contains `delegatecall`. Upgradeable or dangerous. | Warn; recommend the user check who the target library is. |
| `PROXY_UPGRADEABLE` | Contract is behind an upgradeable proxy. Owner can change logic. | Warn; explain the trust assumption. |
| `SOURCE_UNVERIFIED` | Etherscan has no verified source. | Warn strongly \u2014 you cannot audit what you cannot read. |

## `/tx-simulate-risk`

| Code | Meaning | Recommended action |
|---|---|---|
| `UNLIMITED_APPROVAL_GRANTED` | Simulation shows an ERC-20 `Approval(owner, spender, MAX_UINT256)` event. | **Hard warn.** The target can drain the token from this wallet forever. Suggest a limited approval instead. |
| `OWNERSHIP_TRANSFERRED` | An `OwnershipTransferred` event fires. | **Hard warn.** User is giving up admin control of a contract. |
| `PROXY_UPGRADED` | An `Upgraded` event fires. | **Hard warn.** Contract logic is being swapped. |
| `SELFDESTRUCT_INVOKED` | Trace contains `SELFDESTRUCT`. | **Hard warn.** Contract will vanish. |
| `TX_REVERTED` | Simulation reverted. | Not automatically dangerous but tell the user; the tx will fail on-chain and consume gas. |
| `MULTIPLE_OUTBOUND_TOKEN_TRANSFERS` | More than one ERC-20 leaves the sender's wallet in a single call. | Warn \u2014 legitimate DEX aggregator or malicious drainer. Explain both. |

## `/scope-check`

Returns `in_scope: true|false` plus a `programs[]` array. No `reason_codes[]` field. Interpretation:

- `in_scope: true` \u2014 there is at least one active bug bounty program covering this address. Look at `programs[]` for platform, name, url, `max_bounty`.
- `in_scope: false` \u2014 address is not in the current scope index (15 programs, 109 contracts, refreshed daily). Absence of coverage is not proof; the user's target may just not be tracked.

## `/verify-poc`

Long code list because the endpoint distinguishes grading outcome, user error, sandbox policy, and infrastructure.

### Grading outcome

| Code | Meaning |
|---|---|
| `POC_VERIFIED` | Test ran, matched `expected_result`. **The exploit is real.** |
| `POC_UNVERIFIED` | Test compiled and ran, but did not match `expected_result` (expected revert but passed, or expected pass but reverted). |

### User error \u2014 do not blame the API

| Code | Meaning |
|---|---|
| `MISSING_TEST_FILE` | Request body missing `test_file` field. |
| `INVALID_BASE64` | `test_file` did not decode as base64. |
| `TEST_FILE_TOO_LARGE` | Decoded source exceeded 128 KB. |
| `UNSUPPORTED_CHAIN` | Only `eth` is supported today. |
| `INVALID_EXPECTED_RESULT` | Must be `"pass"` or `"revert"`. |
| `COMPILE_ERROR` | Solc rejected the source. Response `notes[]` has compiler output. |
| `PARSE_FAILURE` | Forge JSON output was unparseable (rare, likely toolchain skew). |
| `NO_TESTS_FOUND` | Source compiled but contains no `test*` functions. |

### Sandbox policy \u2014 explain to user

| Code | Meaning |
|---|---|
| `FFI_DISALLOWED` | Source uses `vm.ffi(...)`. Banned. |
| `FS_WRITE_DISALLOWED` | Source uses `vm.writeFile(...)` / `vm.closeFile(...)` / `vm.removeFile(...)`. Banned. |
| `ENV_WRITE_DISALLOWED` | Source uses `vm.setEnv(...)`. Banned. |

### Infrastructure

| Code | Meaning |
|---|---|
| `RPC_UNREACHABLE` | Upstream Ethereum RPC (publicnode.com primary, eth.merkle.io fallback) failed. Try again in a minute. |
| `TIMEOUT` | Forge subprocess exceeded 120s wall clock. |
| `FORGE_STD_BOOTSTRAP_FAILED` | `/tmp/verify-poc-cache/forge-std` could not be cloned. |
| `INTERNAL_ERROR` | Unclassified server error. Report the request ID. |

## `/auth-ping`

No `reason_codes[]`. Returns `{ok: true, key_prefix, key_id}` on success or `401` with `{error, code}` on failure.

## Handling multiple codes

Endpoints may return multiple codes in one response (e.g. a simulated tx that both reverts *and* attempts an unlimited approval before reverting). Treat the array as a set; act on the most severe. Severity order:

1. `OFAC_SANCTIONED`, `SCAM_LIST_HIT`, `KNOWN_EXPLOIT_MATCH`, `SELFDESTRUCT_INVOKED` \u2014 refuse
2. `UNLIMITED_APPROVAL_GRANTED`, `OWNERSHIP_TRANSFERRED`, `PROXY_UPGRADED` \u2014 hard warn
3. `SELFDESTRUCT_PRESENT`, `DELEGATECALL_PRESENT`, `PROXY_UPGRADEABLE`, `SOURCE_UNVERIFIED`, `MULTIPLE_OUTBOUND_TOKEN_TRANSFERS` \u2014 warn
4. `TX_REVERTED`, `UNKNOWN_ADDRESS` \u2014 inform

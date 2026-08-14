# /verify-poc

**Status:** Phase 6.1 — API-key gated, single-file only, Ethereum mainnet only.

Runs an auditor-submitted Foundry PoC (`.t.sol`) against a mainnet fork
and grades whether the actual outcome matches what the caller claimed
would happen. Designed for bounty triage: paste a test file, get back
`verified: true|false` plus a short reason code the triager can act on.

---

## Auth & rate limits

- **Auth:** `Authorization: Bearer tb_live_<32 hex>` — same API-key
  scheme as `/auth-ping`, `/scope-check`, etc. Issue keys with the
  admin API (`POST /admin/keys`, see `docs/api-key-auth.md`).
- **Per-route cap:** `10 requests/minute/key` (env
  `VERIFY_POC_CAP_PER_MINUTE`). This is a *separate* bucket from the
  global 60/min cap — burning your verify budget does not lock you out
  of `/scope-check` or `/tx-simulate-risk`.
- **Rate-limit headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`, plus `Retry-After` on 429.

---

## Request

`POST /verify-poc` — Content-Type: application/json

| Field              | Type    | Required | Default            | Notes |
|--------------------|---------|----------|--------------------|-------|
| `test_file`        | string  | yes      | —                  | Base64-encoded `.t.sol` source. Max **128 KB** decoded. |
| `chain`            | string  | no       | `"eth"`            | Only `"eth"` accepted in 6.1. |
| `fork_block`       | number  | no       | latest             | Ethereum block number to fork at. |
| `expected_result`  | string  | no       | `"pass"`           | `"pass"` or `"revert"`. Grades against this. |
| `solidity_version` | string  | no       | auto-detected      | Ignored today — forge picks from pragma. |
| `rpc_url`          | string  | no       | server default     | Override upstream RPC. Kept for CI use, not recommended in prod. |

**Constraints (enforced server-side):**

- Single file only. Multi-file PoCs / OZ imports arrive in 6.2.
- Only `forge-std/Test.sol` is on the import path.
- `vm.ffi()`, `vm.writeFile()`, `vm.setEnv()`, `vm.closeFile()`,
  `vm.removeFile()` are all rejected pre-compile with a 400. Deeper
  Docker sandboxing is Phase 6.3.
- Hard 120s wall-clock timeout on the forge subprocess.

---

## Response

Always returns a JSON object with the same shape. Read `reason_codes`
before `verified`.

```json
{
  "verified": true,
  "expected": "pass",
  "actual": "pass",
  "test_name": "testExploit()",
  "gas_used": 123456,
  "logs": ["x: 2", "..."],
  "traces_head": "[...first 2000 chars...]",
  "fork_block": 20000000,
  "duration_ms": 34500,
  "reason_codes": ["POC_VERIFIED"],
  "notes": []
}
```

`verified = (actual === expected)`. That's the only thing a triage
workflow needs to check.

### Reason codes

| Code                        | HTTP | Meaning |
|-----------------------------|------|---------|
| `POC_VERIFIED`              | 200  | Outcome matched expected. |
| `POC_UNVERIFIED`            | 200  | Outcome did not match expected. |
| `COMPILE_ERROR`             | 422  | Source failed to compile. `notes[]` carries the compiler error head. |
| `PARSE_FAILURE`             | 422  | forge produced non-JSON output we couldn't parse. Rare. |
| `NO_TESTS_FOUND`            | 422  | Contract compiled but has no `testX()` functions. |
| `TIMEOUT`                   | 504  | 120s wall-clock exceeded. |
| `RPC_UNREACHABLE`           | 502  | Couldn't resolve latest block or run the fork. |
| `MISSING_TEST_FILE`         | 400  | Body did not include `test_file`. |
| `INVALID_BASE64`            | 400  | `test_file` was not valid base64. |
| `TEST_FILE_TOO_LARGE`       | 400  | Decoded source > 128 KB. |
| `UNSUPPORTED_CHAIN`         | 400  | `chain` was not `"eth"`. |
| `INVALID_EXPECTED_RESULT`   | 400  | `expected_result` was not `"pass"` or `"revert"`. |
| `FFI_DISALLOWED`            | 400  | Source contains `vm.ffi(`. |
| `FS_WRITE_DISALLOWED`       | 400  | Source contains `vm.writeFile(` / `closeFile` / `removeFile`. |
| `ENV_WRITE_DISALLOWED`      | 400  | Source contains `vm.setEnv(`. |
| `FORGE_STD_BOOTSTRAP_FAILED`| 500  | Server failed to clone forge-std into its cache. |
| `INTERNAL_ERROR`            | 500  | Anything else. `notes[]` has details. |

---

## Grading model

The endpoint does not care whether the test *itself* passes; it cares
whether the outcome the auditor claimed matches what actually
happened. Two conventions:

- **`expected_result = "pass"`** — the auditor is claiming the exploit
  succeeds. The test function should execute a real exploit and its
  assertions should pass. `success = true` from forge → `actual = "pass"`.
- **`expected_result = "revert"`** — the auditor is claiming the
  attack path reverts. The test function's assertions should fail (or
  it should hit an unexpected revert). `success = false` from forge →
  `actual = "revert"`.

Use `vm.expectRevert` inside the test only when you want to prove a
call reverts *as part of a passing test* — that still grades as
`actual = "pass"`.

---

## Curl example

```bash
SRC=$(base64 -w0 my-poc.t.sol)
curl -s -X POST http://45.55.48.101:8787/verify-poc \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"test_file\":\"$SRC\",\"chain\":\"eth\",\"expected_result\":\"pass\"}" \
  | jq
```

---

## Server-side setup

- Requires `forge` on `PATH` (Foundry 1.7+). Override with `FOUNDRY_BIN`.
- On first request, the server clones `foundry-rs/forge-std` into
  `/tmp/verify-poc-cache/forge-std` (~2 MB). Subsequent requests reuse
  the clone. Override the cache path with `FORGE_STD_CACHE`.
- Each request creates and tears down its own `/tmp/verify-poc-<uuid>`
  sandbox. `foundry.toml` inside the sandbox pins `ffi = false` and
  `optimizer = false`. Users cannot override.
- Default RPC: `https://ethereum.publicnode.com`. Override with the
  `SIM_RPC_ETH_MAINNET` env var.

---

## Known limits (documented, not bugs)

1. **Single test file.** Multi-file PoCs, custom libraries, OZ
   contracts → Phase 6.2. The current sandbox does not run `forge
   install`.
2. **First test function only.** If a file has three `testX()`s, we
   grade the first and note the count in `notes[]`.
3. **No Docker isolation.** Cheatcodes are filtered by regex + a
   `ffi = false` config file. This is defense-in-depth, not a hard
   sandbox — a determined attacker with fresh Foundry cheatcodes could
   probably still misbehave. Phase 6.3 moves the subprocess into an
   ephemeral container.
4. **fork_block is trusted.** We do not validate that the block exists
   before invoking forge; you'll get an `RPC_UNREACHABLE` if not.
5. **Traces are truncated to 2000 chars.** Full traces would blow past
   response-size budgets and aren't useful for triage-time decisions.

---

## Related endpoints

- `POST /tx-simulate-risk` — per-tx simulation, no Solidity required
- `POST /scope-check` — bounty-scope lookup
- `GET /auth-ping` — verify API key works

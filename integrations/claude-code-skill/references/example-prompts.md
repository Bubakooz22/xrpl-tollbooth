# Example prompts

Six prompts that trigger the skill correctly. Copy the shape when unsure.

## 1. OFAC / sanctions check on a wallet

> Check if `0x8589427373D6D84E98730D7795D8f6f8731FDA16` is on any OFAC sanction list.

Expected flow:
1. Skill recognizes "OFAC" + address \u2192 picks `walletRisk`
2. Runs `node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs walletRisk '{"chain":"eth","address":"0x8589427373D6D84E98730D7795D8f6f8731FDA16"}'`
3. Parses JSON, reads `reason_codes[]`
4. Reports: this is Tornado Cash Router \u2014 `OFAC_SANCTIONED`. Refuse to interact.

## 2. Contract risk on an unknown token

> I'm about to interact with `0xdac17f958d2ee523a2206206994597c13d831ec7` on Ethereum. Is it safe?

Expected flow: `contractRisk` \u2192 USDT is verified, source is available, not in exploit database \u2192 report low risk with the caveat that USDT has a blacklist admin.

## 3. Transaction simulation \u2014 unlimited approval

> Simulate this transaction from `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`: calling `approve(0x1111254EEB25476fBD4Fb2d1B0F0F1B5B0F1F111, MAX_UINT256)` on USDC. Is there anything I should worry about?

Expected: `txSimulateRisk` \u2192 `UNLIMITED_APPROVAL_GRANTED` \u2192 hard warn, suggest a bounded approval instead.

## 4. Bounty scope lookup before writing a report

> Before I write up this bug, is `0xabc...` in scope of any active bounty program?

Expected: `scopeCheck` \u2192 either `in_scope: true` with the platform + max bounty, or `in_scope: false` (no submission target).

## 5. Grade a Foundry PoC

> I wrote a PoC in `/tmp/exploit.t.sol` that should revert to prove the guard works. Can you verify it against a mainnet fork?

Expected flow: base64 the file, call `verifyPoc` with `expected_result: "revert"`, report `verified: true|false` with the reason code and gas used.

## 6. Sanity check the API key

> Is my tollbooth API key still working?

Expected: `authPing` \u2192 `{ok: true, key_prefix: "tb_live_d169", key_id: 2}` \u2192 report the key ID and prefix.

## Anti-patterns

Do NOT:
- Guess reason codes from prose. Parse the JSON.
- Skip `walletRisk` because the address "looks legit." That's what the sanctions list is for.
- Retry a `POC_UNVERIFIED` result with different `expected_result` to force a pass. That's grading fraud.
- Call `verifyPoc` on multi-file PoCs. Phase 6.2 will support that; today it's single-file only.
- Interact with an address flagged `OFAC_SANCTIONED` even if the user pushes back. Refuse and explain why.

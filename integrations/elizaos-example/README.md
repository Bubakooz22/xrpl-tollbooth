# XRPL Toll Booth — ElizaOS plugin

Copy-paste-ready ElizaOS plugin exposing the XRPL Toll Booth API as
character actions. The agent auto-invokes the right action based on
similes + examples in the frontmatter.

## What's included

`src/index.ts` exports `xrplTollboothPlugin` implementing `Plugin` from
`@elizaos/core`. It ships four actions:

| Action name | Similes / triggers | Endpoint | Auth |
|---|---|---|---|
| `TOLLBOOTH_WALLET_RISK` | "check wallet", "OFAC", "sanctioned", "scam lookup" | `/wallet-risk` | x402 (1000 drops) |
| `TOLLBOOTH_CONTRACT_RISK` | "check contract", "is exploit", "audit contract" | `/contract-risk` | x402 |
| `TOLLBOOTH_SCOPE_CHECK` | "bounty scope", "in scope" | `/scope-check` | x402 |
| `TOLLBOOTH_AUTH_PING` | "check tollbooth key", "ping tollbooth" | `/auth-ping` | Bearer API key |

`verify-poc` and `tx-simulate-risk` are intentionally left out — their
inputs (base64-encoded Foundry test files, hex calldata) don't come out
of natural-language extraction cleanly. Wire them behind a
slash-command action or a UI hook in your character rather than an
LLM-selected action.

## Install into a character

From your character workspace:

```
npm install /path/to/xrpl-tollbooth/integrations/elizaos-example
```

Then in the character definition:

```ts
import { xrplTollboothPlugin } from '@xrpl-tollbooth/elizaos-plugin';

export const character = {
  name: 'Sentinel',
  bio: ['On-chain security triage for Web3 agents.'],
  plugins: [xrplTollboothPlugin],
  settings: {
    secrets: {
      TOLLBOOTH_URL: 'http://127.0.0.1:8787',
      TOLLBOOTH_API_KEY: 'tb_live_...',    // optional
      XRPL_SEED: 's...',                    // required for x402 actions
    },
  },
};
```

`runtime.getSetting(name)` reads from `settings.secrets` and process env,
so either wiring works.

## Auto-invoke behavior

ElizaOS picks the action to run by matching the incoming message
against each action's `name`, `similes`, `description`, and `examples`
(see [ElizaOS Actions docs](https://docs.elizaos.ai/core-concepts/plugins/actions)).
The plugin's `validate` callbacks also gate execution — for example,
`TOLLBOOTH_WALLET_RISK` only fires when the message contains something
that looks like a wallet address.

If the LLM picks the wrong action, the fix is usually adding more
`similes` to that action's frontmatter or a fresh example pair that
distinguishes the two intents.

## Address extraction

The plugin uses simple regex to pull an address out of the user
message. It recognizes:

- Ethereum: `0x[0-9a-fA-F]{40}`
- XRPL: `r[base58]{24-34}`
- Solana: base58 32–44 chars

For anything more structured (multiple addresses, calldata, expected
outcome), define a `parameters` field on the action or use ElizaOS's
built-in state composition to have the LLM extract structured JSON
before your handler runs. The action interface supports both patterns —
this example keeps it minimal on purpose.

## Cost + reason-code reminders

The plugin's `handler` returns the raw JSON response in `ActionResult.data`
so downstream actions or evaluators can inspect `risk_level`,
`reason_codes`, `score`, etc. The default `text` field is a one-liner
suitable for a chat reply.

If you're building a triage agent, add an **evaluator** downstream that
short-circuits the conversation when `reason_codes` contains any of:

- `OFAC_SANCTIONED`
- `KNOWN_EXPLOIT_MATCH`
- `SELFDESTRUCT_INVOKED`
- `UNLIMITED_APPROVAL_GRANTED`

See `references/reason-codes.md` in the Claude Code skill folder for the
full catalog.

## Build

```
npm install
npm run build       # writes dist/
npm run typecheck   # verify without emit
```

## Why shell out to `paid-call.mjs`?

Same reason as the LangChain example — one canonical XRPL payer
implementation lives in the repo (`scripts/paid-call.mjs`) and the
smoke tests use it. Reimplementing x402 v2 in the plugin would double
the code you have to keep in sync with facilitator behavior.

If you're vendoring this plugin outside the `xrpl-tollbooth` checkout,
set `PAID_CALL_SCRIPT_PATH` in the runtime config to point at your copy.

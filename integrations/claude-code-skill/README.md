# XRPL Toll Booth \u2014 Claude Code skill

A Claude Code skill that lets the agent call the XRPL Toll Booth's cybersecurity API directly from your terminal. The tollbooth charges per call in XRP (1000 drops \u2248 $0.0005) settled on-chain via the x402 protocol. Two endpoints are API-key gated (closed beta).

## What it does

The skill maps natural-language security intents to the right tollbooth endpoint and handles payment automatically:

| You say | Skill calls | Auth |
|---|---|---|
| "check if this wallet is on OFAC" | `walletRisk` | x402 |
| "is this contract safe" | `contractRisk` | x402 |
| "simulate this transaction" | `txSimulateRisk` | x402 |
| "is this address in bounty scope" | `scopeCheck` | x402 |
| "verify my PoC" | `verifyPoc` | API key |
| "is my API key working" | `authPing` | API key |

The skill reads `/.well-known/agent.json` on every call, so any endpoint added to the tollbooth appears in the skill automatically \u2014 no re-install required.

## Install

Run from the repo root on the droplet:

```bash
bash integrations/claude-code-skill/install.sh
```

This symlinks `integrations/claude-code-skill/` into `~/.claude/skills/xrpl-tollbooth/`. Because it's a symlink, `git pull` on the repo updates the installed skill in place.

## Configure

The skill reads three env vars, all typically set in `xrpl-tollbooth/.env`:

- `TOLLBOOTH_URL` \u2014 default `http://127.0.0.1:8787` (localhost on the droplet). Override if pointing at a remote deployment.
- `TOLLBOOTH_API_KEY` \u2014 Bearer key for `verify-poc` and `auth-ping`. Closed beta \u2014 open a GitHub issue on `xrpl-tollbooth` to request one.
- `XRPL_SEED` \u2014 payer seed for x402 endpoints. Already configured on this droplet.

## Sanity check

Print the current manifest:

```bash
node integrations/claude-code-skill/helpers/list-endpoints.mjs
```

You should see all 7 endpoints, pricing, and reason codes.

## Direct helper invocation

The skill invokes the helper for you, but you can call it manually to smoke test:

```bash
node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs authPing
```

```bash
node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs \
  walletRisk '{"chain":"eth","address":"0x8589427373D6D84E98730D7795D8f6f8731FDA16"}'
```

```bash
node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs \
  contractRisk '{"chain":"eth","address":"0xdac17f958d2ee523a2206206994597c13d831ec7"}'
```

## Example prompts

See `references/example-prompts.md` for six real prompts that trigger the skill correctly.

## Reason codes

Every risk and verify endpoint returns a stable `reason_codes[]` array. Full catalog with recommended actions in `references/reason-codes.md`.

## Cost per call

- **x402 endpoints** (`walletRisk`, `contractRisk`, `txSimulateRisk`, `scopeCheck`): 1000 drops XRP (\u2248 $0.0005) or 0.002 RLUSD per call. Payment settles on XRPL testnet before the endpoint executes.
- **API-key endpoints** (`verifyPoc`, `authPing`): no per-call charge in closed beta.

## How the skill discovers the API

Every helper invocation begins by fetching `${TOLLBOOTH_URL}/.well-known/agent.json`. This makes the skill self-updating: when a new endpoint ships on the tollbooth, the skill sees it on the next call.

The manifest also tells the skill which auth model to use per endpoint (`x402` or `bearer_api_key`), so adding new x402 or API-key endpoints upstream requires no change here.

## Troubleshooting

**"XRPL_SEED not set"** \u2014 the shell running Claude Code needs the seed. Either put it in `xrpl-tollbooth/.env` (default) or `export XRPL_SEED=...` before starting Claude Code.

**"agent.json fetch failed: ECONNREFUSED"** \u2014 the tollbooth server isn't running. Start it:

```bash
cd /root/xrpl-tollbooth
kill $(lsof -t -i :8787) 2>/dev/null; sleep 2
nohup npm start > /tmp/tollbooth.log 2>&1 & disown
```

**"paid-call.mjs exited 1"** \u2014 usually means the payer wallet has insufficient testnet XRP. Fund it at <https://faucet.altnet.rippletest.net/accounts>.

**Skill not triggering** \u2014 confirm the install symlink resolved:

```bash
ls -la ~/.claude/skills/xrpl-tollbooth
```

Should point at the repo directory. If not, re-run `install.sh`.

## Related

- Full API spec: `../../.well-known/openapi.json`
- Agent manifest: `../../.well-known/agent.json`
- Discovery docs: `../../docs/discovery.md`

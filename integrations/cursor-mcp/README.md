# XRPL Toll Booth — Cursor MCP Server

An MCP (Model Context Protocol) server that exposes the seven XRPL Toll Booth
endpoints as tools your Cursor editor (and any other MCP host — Claude
Desktop, custom clients) can invoke natively.

## What you get

Seven MCP tools, dropped into Cursor's tool palette:

| Tool | Auth | Cost | Purpose |
|------|------|------|---------|
| `wallet_risk` | x402 | 1000 drops | Score any wallet — OFAC + curated scam lists |
| `contract_risk` | x402 | 1000 drops | Score a contract — known-exploit DB + heuristics |
| `tx_simulate_risk` | x402 | 1000 drops | Simulate an ETH tx on a mainnet fork, grade the trace |
| `scope_check` | x402 | 1000 drops | Is this address in a live bug-bounty program? |
| `verify_poc` | Bearer key | free (rate-limited) | Grade a Foundry `.t.sol` PoC against a mainnet fork |
| `auth_ping` | Bearer key | free | Sanity-check the API key |
| `list_endpoints` | none | free | Fetch `/.well-known/agent.json` |

## Prerequisites

- Node.js ≥ 18
- Cursor 0.45 or later (any version that supports `.cursor/mcp.json`)
- A clone of this repo — the MCP server delegates x402 payments to
  `scripts/paid-call.mjs` in the repo root.
- A funded XRPL **testnet** seed in `.env` at the repo root (`XRPL_SEED=...`)
- A tollbooth API key if you want to call `verify_poc` or `auth_ping`

## Install

```bash
cd integrations/cursor-mcp
npm install
npm run build
```

That produces `dist/index.js`, which is what Cursor spawns.

## Wire it into Cursor

Two options. **Project-scoped** (recommended if you're the sole developer of a
codebase; teammates get the same tools automatically) or **global** (available
in every workspace).

### Project-scoped: `.cursor/mcp.json` in your project root

Create `.cursor/mcp.json` in whichever project you want tollbooth tools
available in:

```json
{
  "mcpServers": {
    "xrpl-tollbooth": {
      "command": "node",
      "args": ["/absolute/path/to/xrpl-tollbooth/integrations/cursor-mcp/dist/index.js"],
      "env": {
        "TOLLBOOTH_URL": "http://127.0.0.1:8787",
        "TOLLBOOTH_API_KEY": "tb_live_...",
        "XRPL_SEED": "s...testnet-seed..."
      }
    }
  }
}
```

**Use absolute paths for `args`** — Cursor spawns the process from a working
directory you don't control, so relative paths break. On Windows, escape
backslashes: `"C:\\Users\\you\\..."`.

### Global: `~/.cursor/mcp.json`

Same shape, dropped into `~/.cursor/mcp.json` (Linux/Mac) or
`%USERPROFILE%\.cursor\mcp.json` (Windows). Merged with any project-scoped
config; project wins on name collision.

After saving, restart Cursor (or Settings → Tools & MCP → refresh). The
`xrpl-tollbooth` server should appear in the list and enumerate seven tools.

## Environment variables

| Var | Required | Notes |
|-----|----------|-------|
| `TOLLBOOTH_URL` | no | Defaults to `http://127.0.0.1:8787`. Point at the droplet (`http://45.55.48.101:8787`) for remote calls. |
| `TOLLBOOTH_API_KEY` | for `verify_poc` and `auth_ping` | From your closed-beta credential |
| `XRPL_SEED` | for the four x402 tools | Testnet-only. Never commit. Testnet faucet: <https://xrpl.org/xrp-testnet-faucet.html> |
| `PAID_CALL_SCRIPT_PATH` | no | Override the path to `scripts/paid-call.mjs`. Defaults to `../../../scripts/paid-call.mjs` relative to `dist/index.js`. |

## Testing it works

Once Cursor loads the server, try any of these prompts in a chat:

- *"Use xrpl-tollbooth to check auth_ping."* → should return `{ ok: true, key: {...}, rate_limit: {...} }`
- *"Use wallet_risk on the ETH address 0x0000000000000000000000000000000000000000."* → should return a risk report with `reason_codes: []` for a low-risk address, or `OFAC_SANCTIONED` / `SCAM_LIST_HIT` if the address is on a list.
- *"List all tollbooth endpoints."* → should call `list_endpoints` and return the manifest.

## Reason codes cheat sheet

`wallet_risk` / `contract_risk` return a `reason_codes[]` array. The
important ones for agent decisions:

- `OFAC_SANCTIONED` — hard block. Refuse to proceed.
- `SCAM_LIST_HIT` — hard block. Curated multi-source scam DB.
- `KNOWN_EXPLOIT_MATCH` — contract is on a public exploit list. Refuse.
- `SELFDESTRUCT_PRESENT` / `DELEGATECALL_PRESENT` — soft warn. Ask the user.
- `PROXY_UPGRADEABLE` — soft warn. State is mutable by an admin.
- `SOURCE_UNVERIFIED` — soft warn. Bytecode-only assessment.
- `UNKNOWN_ADDRESS` — nothing matched. Not proof of safety.

`tx_simulate_risk` returns similar codes plus:

- `SELFDESTRUCT_INVOKED` — the simulated tx kills a contract. Hard warn.
- `UNLIMITED_APPROVAL_GRANTED` — the tx grants type(uint256).max approval. Hard warn.
- `OWNERSHIP_TRANSFERRED` / `PROXY_UPGRADED` — governance change during tx. Hard warn.
- `TX_REVERTED` — the tx would fail. Informational.
- `MULTIPLE_OUTBOUND_TOKEN_TRANSFERS` — potential drain pattern. Informational.

## Troubleshooting

**"XRPL_SEED not set" or "TOLLBOOTH_API_KEY not set"** — env vars in
`.cursor/mcp.json`, not your shell. Cursor spawns the process fresh; your
`~/.bashrc` doesn't apply.

**"manifest fetch failed"** — `TOLLBOOTH_URL` is wrong or the tollbooth
server isn't reachable. Test with `curl $TOLLBOOTH_URL/.well-known/agent.json`.

**"paid-call.mjs exited N"** — the x402 subprocess hit an error. Set
`XRPL_SEED` to a funded testnet address, or run the script standalone with
the same args to see full logs.

**Server doesn't appear in Cursor** — restart Cursor (fully, not just window
reload). Check `.cursor/mcp.json` parses as valid JSON. Look for
`[xrpl-tollbooth-mcp]` lines in Cursor's MCP log panel.

**Windows path with spaces** — wrap with `cmd /c` per the [Cursor forum
workaround](https://forum.cursor.com/t/mcp-stdio-command-with-spaces-in-path-broken-on-windows-cmd-splits-at-space-same-mcp-json-works-in-vs-code/160842):

```json
"command": "cmd",
"args": ["/c", "node", "C:\\Users\\You\\...\\dist\\index.js"]
```

## Design notes (matches other integrations in this repo)

1. **Auto-discovery** — on boot, the server pings `/.well-known/agent.json`
   and logs the manifest version + endpoint count. Same pattern as the
   LangChain and ElizaOS integrations.
2. **x402 delegation** — the four paid tools shell out to
   `scripts/paid-call.mjs`, which handles the HTTP 402 payment challenge,
   XRPL signing, and retry. No wallet code lives in the MCP process.
3. **Reason-code guidance in tool descriptions** — Cursor uses the tool
   description verbatim when deciding whether to call. Guidance like "Refuse
   to proceed if reason_codes contains OFAC_SANCTIONED" lives in the tool's
   own description string.

## What this doesn't do

- **No dashboards / no HTTP transport.** stdio only — that's what Cursor and
  Claude Desktop need. If you want an SSE variant for remote MCP hosts, open
  an issue.
- **No caching.** Every call round-trips to the tollbooth. If you're hitting
  rate limits, batch on the caller side.
- **No wallet balance checks.** If `XRPL_SEED` is unfunded, the four paid
  tools will fail on the first call. Fund from
  <https://xrpl.org/xrp-testnet-faucet.html> before use.

## Also see

- [`../langchain-example/`](../langchain-example/) — Python + JavaScript LangChain integrations
- [`../elizaos-example/`](../elizaos-example/) — ElizaOS plugin (4 actions)
- [`../claude-code-skill/`](../claude-code-skill/) — Claude Code skill package
- [`../../README.md`](../../README.md) — the tollbooth itself

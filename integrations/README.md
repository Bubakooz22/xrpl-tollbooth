# XRPL Toll Booth — Agent Integrations

Reference integrations that plug the XRPL Toll Booth API into
common AI agent frameworks. Each directory is standalone: copy it into
your project, install its deps, and go.

## Directory

| Integration | Framework | Language | Status | Path |
|---|---|---|---|---|
| Claude Code skill | Anthropic Claude Code | Node (mjs) | ✅ Shipped | [`claude-code-skill/`](./claude-code-skill/) |
| LangChain tools | LangChain | Python + JS | ✅ Shipped | [`langchain-example/`](./langchain-example/) |
| ElizaOS plugin | ElizaOS | TypeScript | ✅ Shipped | [`elizaos-example/`](./elizaos-example/) |
| Cursor MCP server | Cursor / MCP | TypeScript | 🔜 Planned | (Phase 7.2b) |

## Shared design across integrations

Every integration follows the same three rules:

1. **Auto-discover the manifest.** Load `/.well-known/agent.json` on
   init and use it as the source of truth for endpoint list, pricing,
   and auth mode. New endpoints show up without a code change.
2. **Delegate x402 payment to one script.** All examples shell out to
   `scripts/paid-call.mjs` at the repo root for the four x402 endpoints,
   so wallet-key handling, sequence numbers, and facilitator flow live
   in one place. Only `verify-poc` and `auth-ping` (Bearer-authed) are
   direct HTTP fetches.
3. **Carry reason-code guidance inline.** The tool/action description
   the LLM sees names the reason codes and their severities, so the
   agent defaults to refusing critical outcomes without extra prompt
   engineering.

The seven endpoints are:

| Endpoint | Auth | Cost | Notes |
|---|---|---|---|
| `GET /wallet-risk` | x402 | 1000 drops | OFAC + scam-list, 3 chains |
| `GET /contract-risk` | x402 | 1000 drops | Known-exploit + heuristics, eth only |
| `POST /tx-simulate-risk` | x402 | 1000 drops | Anvil fork, eth only |
| `GET /scope-check` | x402 | 1000 drops | 15 bounty programs, 109 contracts |
| `POST /verify-poc` | Bearer key | Free (10/min) | Foundry sandbox, closed beta |
| `GET /auth-ping` | Bearer key | Free | Key health check |
| `GET /.well-known/{openapi,agent}.json` | Public | Free | Discovery manifests |

Full schema: `../docs/discovery.md`, or fetch
`http://<host>/.well-known/openapi.json` and
`http://<host>/.well-known/agent.json` directly.

## Environment variables (common)

All integrations read the same three env vars:

- `TOLLBOOTH_URL` — default `http://127.0.0.1:8787`
- `TOLLBOOTH_API_KEY` — required for `verify-poc` + `auth-ping`
- `XRPL_SEED` — required for the four x402-paid endpoints (payer wallet)

## Which integration should I use?

- **Coding in the terminal with Claude Code?** →
  [`claude-code-skill/`](./claude-code-skill/). Install once with
  `install.sh`, then the skill auto-invokes on trigger keywords like
  "wallet risk" or "OFAC check".
- **Building a LangChain agent (Python or JS)?** →
  [`langchain-example/`](./langchain-example/). Six ready-made tools;
  drop them into `initialize_agent(...)`.
- **Deploying an ElizaOS character?** →
  [`elizaos-example/`](./elizaos-example/). One `Plugin` export with four
  actions and auto-invoke via similes.
- **Something else (LlamaIndex, AutoGen, custom)?** — Read
  `/.well-known/agent.json` yourself; wrap each endpoint as a tool in
  your framework's idiom. The three shipped examples show the pattern.

## Contributing

New integration? Follow the shape of the three shipped examples:

1. Root under `integrations/<framework-name>/`
2. `README.md` at the top of the directory with install + run steps
3. If the integration needs x402, shell out to `scripts/paid-call.mjs`
   instead of reimplementing the payment flow
4. Reference `/.well-known/agent.json` at load time; don't hardcode
   endpoint pricing or paths
5. Bearer + x402 endpoints live in one file when possible so the
   auth-switching pattern stays obvious

Open a PR against `master` with a `phase-7.2x-<framework>` branch name.

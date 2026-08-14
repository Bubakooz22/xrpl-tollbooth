# XRPL Toll Booth — LangChain example

Copy-paste-ready LangChain tools for the XRPL Toll Booth API, in both
Python and JavaScript. Each of the seven tollbooth endpoints becomes a
tool the agent can call.

## What you get

- **`python/tollbooth_tools.py`** — six `@tool`-decorated functions:
  `wallet_risk`, `contract_risk`, `tx_simulate_risk`, `scope_check`,
  `verify_poc`, `auth_ping`. Import `build_tollbooth_tools()` and pass
  the result to any LangChain agent.
- **`python/example_agent.py`** — a small OpenAI-Functions agent that
  triages a "should I send ETH to X?" prompt using the tools.
- **`javascript/tollboothTools.mjs`** — the same surface as
  `DynamicStructuredTool` instances with Zod input schemas.
- **`javascript/exampleAgent.mjs`** — matching JS agent example.

The tools auto-discover pricing and auth mode from the tollbooth's
`/.well-known/agent.json` on load, so if the manifest changes (new
endpoint, price update) they stay in sync.

## Environment

Both examples read the same three env vars:

- `TOLLBOOTH_URL` — default `http://127.0.0.1:8787`
- `TOLLBOOTH_API_KEY` — required for `verify_poc` and `auth_ping`
  (closed beta; open a GitHub issue on `xrpl-tollbooth` to request one)
- `XRPL_SEED` — required for the four x402-paid endpoints (payer wallet
  seed on XRPL testnet)

## Auth model per endpoint

| Endpoint | Auth | Cost |
|---|---|---|
| `wallet_risk` | x402 payment on XRPL testnet | 1000 drops (~$0.0005) |
| `contract_risk` | x402 | 1000 drops |
| `tx_simulate_risk` | x402 | 1000 drops |
| `scope_check` | x402 | 1000 drops |
| `verify_poc` | Bearer API key | Free (closed beta, 10/min) |
| `auth_ping` | Bearer API key | Free |

The x402 tools shell out to `scripts/paid-call.mjs` in the repo root — the
same script the smoke tests use — so the payment flow is identical.
That's why the examples need to run from inside a full `xrpl-tollbooth`
checkout (or override `PAID_CALL_SCRIPT_PATH`).

## Python quickstart

```
cd python/
pip install -r requirements.txt
export TOLLBOOTH_URL=http://127.0.0.1:8787
export XRPL_SEED=s...            # payer seed
export OPENAI_API_KEY=sk-...     # for example_agent.py
python tollbooth_tools.py        # prints exposed tools + manifest info
python example_agent.py          # runs the triage agent
```

## JavaScript quickstart

```
cd javascript/
npm install
export TOLLBOOTH_URL=http://127.0.0.1:8787
export XRPL_SEED=s...
export OPENAI_API_KEY=sk-...
node tollboothTools.mjs          # smoke: lists tools
node exampleAgent.mjs            # runs the triage agent
```

## Design notes

- **Fail loud on missing env.** If `TOLLBOOTH_API_KEY` is unset the
  bearer tools throw immediately rather than sending an anonymous
  request. Same for `XRPL_SEED` on x402 tools.
- **The x402 tools call `paid-call.mjs` via `spawnSync` / `subprocess`.**
  This keeps the payment logic in one place (the Node script owns wallet
  keying, sequence handling, and facilitator flow). If you want a pure-JS
  or pure-Python payer, replace `_call_x402` with your own implementation
  that speaks x402 v2.
- **Docstrings and descriptions carry the reason-code catalog.** LangChain
  uses those strings as the tool description the LLM sees, so keeping
  severity guidance inline steers the agent toward safe defaults.
- **System prompt does the routing.** The `example_agent.py` /
  `exampleAgent.mjs` system prompt names the exact reason codes that
  should trigger refusal vs warning. Copy that into your own prompt if
  you're wiring the tools into an existing agent.

## Non-goals

This example is not a production wrapper. It doesn't:

- Retry on transient facilitator errors (`paid-call.mjs` doesn't either)
- Rate-limit at the client
- Cache manifest across processes
- Expose the tools as an MCP server (see `../cursor-mcp/` if/when it
  ships)

Grab what you need, throw the rest out.

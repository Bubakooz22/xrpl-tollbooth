# Discovery — `.well-known/` endpoints

The XRPL Toll Booth ships two machine-readable manifests so agent frameworks and API catalogs can autodiscover the surface without prose reading.

| Path | Purpose | Consumers |
|---|---|---|
| `/.well-known/openapi.json` | OpenAPI 3.1 spec, all routes + schemas. | Postman, Insomnia, Stainless, Speakeasy, ChatGPT actions, generic OpenAPI tooling. |
| `/.well-known/agent.json`   | Agent-oriented manifest: endpoint id, pricing table, reason codes, rate limits. | x402 discovery ecosystem, LangChain / ElizaOS / Crew, custom skill loaders. |
| `/.well-known/x402`         | Legacy: single `accepts[]` sample at the current `TOLL_PRICE_DROPS`. Kept for backward compatibility. | x402 v2 native clients that only speak this shape. |

All three are unauthenticated. Both new endpoints ship with `Cache-Control: public, max-age=300` plus a strong `ETag` (sha256 of the file bytes, truncated to 16 hex chars, marked weak per RFC 7232). Conditional GET (`If-None-Match`) returns `304 Not Modified`.

## Why two files instead of one

OpenAPI 3.1 is verbose and describes HTTP shape. It's excellent input for typed SDK generation, request validators, and human-facing docs. It's not the file an agent wants to read at runtime to answer "which endpoint should I call and what does it cost."

`agent.json` is the answer to that question. Each entry is:

- `id`, `method`, `path`, `auth` — the routing bits.
- `summary` — one sentence a planner can slot into a tool description.
- `pricing[]` — asset, amount, issuer. Missing on API-key routes.
- `reason_codes[]` — stable enums the endpoint may return. Lets the agent branch without parsing prose.
- `input_schema_ref` / `output_schema_ref` — JSON pointers back into `openapi.json` for the full schema when the agent needs to marshal a call.

The two files reference each other. `openapi.json` links `agent.json` in `info.description`; `agent.json` points at `openapi.json` via `openapi` and schema refs.

## Contact identity

`info.contact.name` in the OpenAPI doc and `contact.name` in the agent manifest are both `transactionguardian2025` — the maintainer's HackenProof handle. The GitHub org is `Bubakooz22`; issues at <https://github.com/Bubakooz22/xrpl-tollbooth/issues>.

## Auth models exposed to agents

- **`x402`** — pay-per-call on XRPL testnet. First request returns 402 with signed payment requirements; sign and retry. Uniform price: 1000 drops XRP **or** 0.002 RLUSD across all four risk/scope endpoints. Facilitator: `https://xrpl-facilitator-testnet.t54.ai`.
- **`bearer_api_key`** — `Authorization: Bearer tb_live_<32hex>`. Closed beta. To request access, open a GitHub issue on `xrpl-tollbooth` with a one-line use case.

The `bearer_api_key` routes are documented but not price-attached. When we open general availability we'll add a `pricing[]` block and drop the `beta: true` flag.

## Rate limits documented in agent.json

Only endpoints with unusual limits are annotated:

- `/verify-poc` — `10/min` on a dedicated bucket, plus a `hard_timeout_ms: 120000` on the forge subprocess.
- `/auth-ping` — `60/min` (shared global bucket).

Everything else is on the shared global limiter.

## Reason codes are load-bearing

Every risk and verify endpoint returns `reason_codes[]`. These are stable strings — we don't rename them silently. Additions get called out in the changelog; removals go through a deprecation window.

Full list per endpoint is in `agent.json` under `endpoints[].reason_codes`. The `/verify-poc` list is longest because it distinguishes user error (`INVALID_BASE64`, `TEST_FILE_TOO_LARGE`) from sandbox policy (`FFI_DISALLOWED`, `FS_WRITE_DISALLOWED`) from infrastructure (`RPC_UNREACHABLE`, `TIMEOUT`) from grading outcome (`POC_VERIFIED`, `POC_UNVERIFIED`).

## Cross-doc consistency

`scripts/smoke-discovery.mjs` runs on every merge:

- Both files load with 200 + `application/json` + `Cache-Control` + `ETag`.
- Conditional GET (`If-None-Match: <etag>`) returns 304.
- Every `agent.endpoints[].path` exists in `openapi.paths`.
- `openapi.info.version === agent.version`.

If any of these break the build fails.

## How to consume from an agent

Minimal LangChain-shaped example:

```js
const manifest = await fetch("http://45.55.48.101:8787/.well-known/agent.json").then(r => r.json());
const tools = manifest.endpoints
  .filter((e) => e.auth === "x402" || (e.auth === "bearer_api_key" && MY_KEY))
  .map((e) => ({
    name: e.id,
    description: e.summary,
    path: e.path,
    method: e.method,
    reasonCodes: e.reason_codes ?? [],
  }));
```

Consuming the OpenAPI spec through a typed generator (Stainless / Speakeasy / openapi-typescript) works the same as any other REST API — feed it the URL, get a client.

## Versioning

Both files carry an explicit `version` string tied to the tollbooth's `package.json`. When the version bumps, the ETag changes, cached agents refetch, and the smoke check re-verifies the two versions match.

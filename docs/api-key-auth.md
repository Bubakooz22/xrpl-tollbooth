# API Key Auth (Phase 6.0)

Second auth path alongside x402. Used by Phase 6+ partner endpoints
(`/verify-poc`, coming in Phase 6.1). Existing x402 endpoints
(`/wallet-risk`, `/contract-risk`, `/tx-simulate-risk`, `/scope-check`)
are unchanged.

## Auth model

Two levels of credential:

| Credential          | Where it lives                    | What it can do                                  |
| ------------------- | --------------------------------- | ----------------------------------------------- |
| `ADMIN_MASTER_KEY`  | `.env` on the server              | Issue, list, revoke API keys via `/admin/keys*` |
| Tenant API keys     | sqlite (`data/api-keys.sqlite`)   | Call API-key-gated endpoints                    |

**Bearer scheme, one header for both:**
```
Authorization: Bearer <token>
```

The server picks the right verification path by route:
- `/admin/*` \u2192 compared against `ADMIN_MASTER_KEY` (constant-time)
- API-key-gated routes \u2192 sha256(token) looked up in sqlite

## Key format

```
tb_live_<32 hex chars>
```

- `tb_live_` prefix: leak-grep friendly (Stripe convention). If we ever
  add sandbox keys the prefix becomes `tb_test_`.
- 32 hex chars = 128 bits entropy.
- We store `sha256(key)` in sqlite, never plaintext. A leaked DB dump
  reveals no usable keys.
- Plaintext is returned exactly once on creation. Lost keys = revoke +
  reissue.

## Rate limiting

- Fixed window, **60 requests per minute per key** (override via
  `RATE_LIMIT_PER_MINUTE`).
- In-memory counters, reset on process restart. Distributed rate limits
  (redis-backed) are a later phase.
- Exceeded requests: `429 Too Many Requests` + `Retry-After: <sec>` and
  `X-RateLimit-*` headers on every response.

## Setup

1. Generate a master key:
   ```bash
   openssl rand -hex 32
   ```
2. Add to `.env`:
   ```
   ADMIN_MASTER_KEY=<paste from above>
   API_KEY_DB_PATH=./data/api-keys.sqlite
   RATE_LIMIT_PER_MINUTE=60
   ```
3. Install the sqlite native binding (one-time on the droplet):
   ```bash
   npm install
   ```
4. Restart tollbooth. On startup you should see:
   ```
   [startup] api-key auth enabled: db=./data/api-keys.sqlite rate_limit=60/min
   ```

If `ADMIN_MASTER_KEY` is unset the server still starts (x402 endpoints
keep working) but `/admin/keys*` returns `503 admin_key_not_configured`
and API-key-gated routes return `401`.

## Admin \u2014 HTTP API

All routes require `Authorization: Bearer $ADMIN_MASTER_KEY`.

### Create a key

```bash
curl -X POST http://localhost:8787/admin/keys \\
  -H "Authorization: Bearer $ADMIN_MASTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "sherlock-poc-prod"}'
```

Response (`201`):
```json
{
  "id": 1,
  "name": "sherlock-poc-prod",
  "prefix": "tb_live_a1b2",
  "key": "tb_live_a1b2c3d4e5f6...",
  "created_at": 1755188400,
  "warning": "Store this key immediately \u2014 it will never be shown again."
}
```

### List keys

```bash
curl http://localhost:8787/admin/keys \\
  -H "Authorization: Bearer $ADMIN_MASTER_KEY"

# Only active (non-revoked):
curl "http://localhost:8787/admin/keys?include_revoked=false" \\
  -H "Authorization: Bearer $ADMIN_MASTER_KEY"
```

### Revoke a key

```bash
curl -X DELETE http://localhost:8787/admin/keys/1 \\
  -H "Authorization: Bearer $ADMIN_MASTER_KEY"
```

Response: `{"revoked": true, "id": 1}` (200) or `{"revoked": false, "id": 1}` (404).

## Admin \u2014 CLI (offline)

For droplet ops without curl. Talks directly to the sqlite file, so
`ADMIN_MASTER_KEY` is not needed (filesystem permissions are the guard).

```bash
node scripts/admin-key.mjs create "sherlock-poc-prod"
node scripts/admin-key.mjs list
node scripts/admin-key.mjs list --active
node scripts/admin-key.mjs revoke 1
```

## Using a key

For API-key-gated endpoints (Phase 6+):

```bash
curl http://localhost:8787/auth-ping \\
  -H "Authorization: Bearer tb_live_a1b2c3d4e5f6..."
```

Successful response (`200`):
```json
{
  "ok": true,
  "key": { "id": 1, "name": "sherlock-poc-prod", "prefix": "tb_live_a1b2" },
  "rate_limit": { "per_minute": 60 }
}
```

Response headers on every authenticated request:
- `X-RateLimit-Limit: 60`
- `X-RateLimit-Remaining: 59`
- `X-RateLimit-Reset: <unix-seconds>`

## Error codes

| Status | Error                       | Meaning                                      |
| ------ | --------------------------- | -------------------------------------------- |
| 401    | `missing_api_key`           | No `Authorization: Bearer` header            |
| 401    | `invalid_api_key`           | Key not found, or revoked                    |
| 401    | `invalid_admin_credentials` | Master key mismatch on `/admin/*`            |
| 429    | `rate_limited`              | Per-key cap hit; check `Retry-After` header  |
| 503    | `admin_key_not_configured`  | Server missing `ADMIN_MASTER_KEY`            |

## Security notes

- **Never commit `.env`** \u2014 `.gitignore` already blocks it.
- **`data/*.sqlite` is gitignored** \u2014 don't check in the key DB.
- **Master key rotation**: change `.env`, restart. All admin curl calls
  must switch. Tenant keys are unaffected.
- **Tenant key rotation**: no in-place rotation in v1. Issue a new key,
  hand it off, revoke the old one after cutover.
- **Backups**: back up the sqlite DB with restrictive perms (600 recommended). A
  DB dump reveals prefixes and metadata but not usable keys.

## Not in Phase 6.0 (deferred)

- Per-key monthly caps (column exists, not enforced)
- Redis-backed distributed rate limiting
- IP allowlisting
- Key rotation endpoint with grace window
- Admin audit log
- OpenAPI publish for admin endpoints

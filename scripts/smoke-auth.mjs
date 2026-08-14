#!/usr/bin/env node
// scripts/smoke-auth.mjs
//
// Phase 6.0 smoke test. Spins up the sqlite store in a temp dir, issues
// a key via the lib directly, then hits the running tollbooth's HTTP
// routes with fetch(). Requires ADMIN_MASTER_KEY in the env and the
// server already running on TOLLBOOTH_URL (default http://localhost:8787).
//
// Usage:
//   ADMIN_MASTER_KEY=xxx node scripts/smoke-auth.mjs

import assert from "node:assert/strict";

const BASE = process.env.TOLLBOOTH_URL || "http://localhost:8787";
const ADMIN = process.env.ADMIN_MASTER_KEY;
const RATE = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);

if (!ADMIN) {
  console.error("FATAL: ADMIN_MASTER_KEY must be set in env");
  process.exit(1);
}

function h(extra = {}) {
  return { "Content-Type": "application/json", ...extra };
}

async function req(method, path, { body, auth } = {}) {
  const headers = h(auth ? { Authorization: `Bearer ${auth}` } : {});
  const opts = { method, headers };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, headers: res.headers, json };
}

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log(`  \u2713 ${name}`);
}
function fail(name, err) {
  failed++;
  console.log(`  \u2717 ${name}`);
  console.log(`    ${err.message || err}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

console.log(`smoke-auth against ${BASE}\n`);

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
console.log("admin auth:");

await test("POST /admin/keys without auth \u2192 401", async () => {
  const r = await req("POST", "/admin/keys", { body: { name: "x" } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "invalid_admin_credentials");
});

await test("POST /admin/keys with wrong master \u2192 401", async () => {
  const r = await req("POST", "/admin/keys", { body: { name: "x" }, auth: "wrongkey" });
  assert.equal(r.status, 401);
});

let createdKey;
let createdId;
await test("POST /admin/keys with master \u2192 201, returns key", async () => {
  const r = await req("POST", "/admin/keys", {
    body: { name: `smoke-${Date.now()}` },
    auth: ADMIN,
  });
  assert.equal(r.status, 201);
  assert.match(r.json.key, /^tb_live_[a-f0-9]{32}$/);
  assert.equal(r.json.prefix, r.json.key.slice(0, 12));
  createdKey = r.json.key;
  createdId = r.json.id;
});

await test("GET /admin/keys \u2192 200 with our new key present", async () => {
  const r = await req("GET", "/admin/keys", { auth: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.json.keys.some((k) => k.id === createdId && k.active === true));
});

// ---------------------------------------------------------------------------
// API-key gated auth-ping
// ---------------------------------------------------------------------------
console.log("\nauth-ping (api-key gated):");

await test("GET /auth-ping without auth \u2192 401 missing_api_key", async () => {
  const r = await req("GET", "/auth-ping");
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "missing_api_key");
});

await test("GET /auth-ping with bogus key \u2192 401 invalid_api_key", async () => {
  const r = await req("GET", "/auth-ping", { auth: "tb_live_" + "0".repeat(32) });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "invalid_api_key");
});

await test("GET /auth-ping with valid key \u2192 200 + rate-limit headers", async () => {
  const r = await req("GET", "/auth-ping", { auth: createdKey });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.key.id, createdId);
  assert.equal(r.headers.get("x-ratelimit-limit"), String(RATE));
  assert.ok(Number(r.headers.get("x-ratelimit-remaining")) >= 0);
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------
console.log("\nrate limit:");

await test(`burst until 429 (cap=${RATE}/min)`, async () => {
  // Fire cap+5 requests. Some should 429. We already consumed ~1 in prior test.
  let seen429 = false;
  let remaining = null;
  for (let i = 0; i < RATE + 5; i++) {
    const r = await req("GET", "/auth-ping", { auth: createdKey });
    if (r.status === 429) {
      seen429 = true;
      assert.equal(r.json.error, "rate_limited");
      assert.ok(Number(r.headers.get("retry-after")) > 0);
      break;
    }
    remaining = r.headers.get("x-ratelimit-remaining");
  }
  assert.ok(seen429, `expected 429 within ${RATE + 5} requests, last remaining=${remaining}`);
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------
console.log("\nrevocation:");

await test("DELETE /admin/keys/:id \u2192 200 revoked=true", async () => {
  const r = await req("DELETE", `/admin/keys/${createdId}`, { auth: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.json.revoked, true);
});

await test("DELETE same key again \u2192 404 revoked=false (idempotent-ish)", async () => {
  const r = await req("DELETE", `/admin/keys/${createdId}`, { auth: ADMIN });
  assert.equal(r.status, 404);
  assert.equal(r.json.revoked, false);
});

await test("Revoked key can no longer auth \u2192 401 invalid_api_key", async () => {
  const r = await req("GET", "/auth-ping", { auth: createdKey });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "invalid_api_key");
});

// ---------------------------------------------------------------------------
// x402 endpoints unaffected
// ---------------------------------------------------------------------------
console.log("\nx402 endpoints (should still challenge with 402):");

await test("POST /wallet-risk without payment \u2192 402", async () => {
  const r = await req("POST", "/wallet-risk", { body: { address: "0x0" } });
  assert.equal(r.status, 402);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

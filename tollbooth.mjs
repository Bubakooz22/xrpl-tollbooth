import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { scoreWallet } from './lib/wallet-risk.mjs';
import { scoreContract } from './lib/contract-risk.mjs';
import { simulateTransaction } from './lib/tx-simulate-risk.mjs';
import { lookupScope, lookupScopeBatch } from './lib/scope-check.mjs';
import {
  initApiKeyStore,
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  listApiKeys,
} from './lib/api-keys.mjs';
import { initRateLimiter, checkRateLimit } from './lib/rate-limit.mjs';
import { verifyPoc } from './lib/verify-poc.mjs';

// Phase 6.1 — per-route rate limit override.
// /verify-poc spawns a forge subprocess + RPC fetch, so we cap tighter
// than the global 60/min to protect the single-vCPU droplet.
const VERIFY_POC_CAP_PER_MINUTE = Number(process.env.VERIFY_POC_CAP_PER_MINUTE || 10);

// Phase 7.1 — static discovery documents (OpenAPI 3.1 + agent manifest).
// Loaded once at boot. ETag = sha256 of the raw bytes. Served with a short
// public max-age so CDNs / agent frameworks can cache while iterating.
const DISCOVERY_DOCS = loadDiscoveryDocs();

function loadDiscoveryDocs() {
  const docs = {};
  for (const [key, path] of [
    ["openapi", "./.well-known/openapi.json"],
    ["agent", "./.well-known/agent.json"],
  ]) {
    try {
      const raw = readFileSync(path);
      const etag = 'W/"' + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16) + '"';
      docs[key] = { body: raw, etag, contentType: "application/json; charset=utf-8" };
    } catch (err) {
      console.warn(`[startup] discovery doc missing: ${path} (${err.message})`);
    }
  }
  return docs;
}

// ---------------------------------------------------------------------------
// x402 v2 compliant tollbooth merchant server.
// Node built-ins only. No express/fastify. Async/await throughout.
// ---------------------------------------------------------------------------


// Trust X-Forwarded-Proto / X-Forwarded-Host from upstream reverse proxy (Caddy).
// Falls back to http + host header when running without a proxy.
function externalUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}${req.url}`;
}

const REQUIRED_ENV = ["TOLL_DESTINATION", "TOLL_PRICE_DROPS", "FACILITATOR_URL", "PORT"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] FATAL: missing required env var ${key}`);
    process.exit(1);
  }
}

// API-key auth is optional at boot — endpoints that require it will 500
// if ADMIN_MASTER_KEY is missing. This lets the existing x402 paths keep
// working during a partial rollout.
const ADMIN_MASTER_KEY = process.env.ADMIN_MASTER_KEY || null;
const API_KEY_DB_PATH = process.env.API_KEY_DB_PATH || './data/api-keys.sqlite';
initApiKeyStore(API_KEY_DB_PATH);
const RATE_LIMIT_CONFIG = initRateLimiter();
if (!ADMIN_MASTER_KEY) {
  console.warn(
    "[startup] WARN: ADMIN_MASTER_KEY not set — /admin/keys* routes will return 503. " +
      "API-key-gated endpoints (Phase 6+) will 401."
  );
} else {
  console.log(
    `[startup] api-key auth enabled: db=${API_KEY_DB_PATH} rate_limit=${RATE_LIMIT_CONFIG.cap}/min`
  );
}

const TOLL_DESTINATION = process.env.TOLL_DESTINATION;
const TOLL_PRICE_DROPS = process.env.TOLL_PRICE_DROPS;
const FACILITATOR_URL = process.env.FACILITATOR_URL.replace(/\/+$/, "");
const PORT = Number(process.env.PORT);
const SOURCE_TAG = Number(process.env.TOLL_SOURCE_TAG ?? 804681468);

// --- RLUSD (Ripple USD) support -------------------------------------------------
// Mainnet RLUSD issuer per Ripple docs (docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)
// and confirmed via t54's XRPL x402 facilitator scheme docs (xrpl-x402.t54.ai/docs/xrpl-scheme).
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
// "RLUSD" ASCII right-padded to a 40-hex-char currency code (XRPL non-standard currency code format).
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';
// Price for the RLUSD-priced accept entry, as a decimal string (IOU amounts are decimal, not drops).
const RLUSD_PRICE = process.env.TOLL_PRICE_RLUSD || '0.002';

function log(fields) {
  const { method, path, status, payment_status, extra } = fields;
  const parts = [
    `method=${method ?? "-"}`,
    `path=${path ?? "-"}`,
    `status=${status ?? "-"}`,
    `payment_status=${payment_status ?? "-"}`,
  ];
  if (extra) parts.push(extra);
  console.log(`[req] ${parts.join(" ")}`);
}

function b64encode(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function b64decode(str) {
  return JSON.parse(Buffer.from(str, "base64").toString("utf8"));
}

function getHeaderCI(req, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Facilitator discovery — probed once at startup. Cached tuple is used for
// every subsequent 402 challenge and verify/settle call. Never hardcoded.
// ---------------------------------------------------------------------------

let FACILITATOR; // { scheme, network, x402Version }

function extractXrplScheme(discoveryJson) {
  // Discovery payloads vary by facilitator implementation. Look for an
  // XRPL-network scheme entry wherever it may live: top-level `kinds`,
  // `accepts`, or `schemes` arrays are all plausible shapes.
  const candidates = [];
  if (Array.isArray(discoveryJson?.kinds)) candidates.push(...discoveryJson.kinds);
  if (Array.isArray(discoveryJson?.accepts)) candidates.push(...discoveryJson.accepts);
  if (Array.isArray(discoveryJson?.schemes)) candidates.push(...discoveryJson.schemes);
  if (Array.isArray(discoveryJson)) candidates.push(...discoveryJson);

  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") continue;
    const network = String(entry.network ?? "").toLowerCase();
    const scheme = entry.scheme;
    if (!scheme) continue;
    if (network.includes("xrpl") || network.startsWith("xrpl")) {
      return {
        scheme,
        network: entry.network,
        x402Version: entry.x402Version ?? discoveryJson.x402Version ?? 2,
      };
    }
  }
  return null;
}

async function probeFacilitator() {
  const probePaths = ["/supported", "/v1/supported", "/.well-known/x402"];
  for (const path of probePaths) {
    const url = `${FACILITATOR_URL}${path}`;
    try {
      const res = await fetch(url, { method: "GET" });
      console.log(`[startup] probe GET ${url} -> ${res.status}`);
      if (res.status !== 200) continue;
      let json;
      try {
        json = await res.json();
      } catch {
        console.log(`[startup] probe ${url} returned 200 but non-JSON body, skipping`);
        continue;
      }
      const found = extractXrplScheme(json);
      if (found) {
        return found;
      }
      console.log(`[startup] probe ${url} returned 200 but no usable XRPL scheme in body`);
    } catch (err) {
      console.log(`[startup] probe GET ${url} -> ERROR ${err.message}`);
    }
  }
  return null;
}

async function initFacilitator() {
  const found = await probeFacilitator();
  if (!found) {
    console.error(
      "[startup] FATAL: facilitator discovery failed — no probe returned 200 with a usable XRPL scheme. " +
        `Tried GET ${FACILITATOR_URL}/supported, ${FACILITATOR_URL}/v1/supported, ${FACILITATOR_URL}/.well-known/x402.`
    );
    process.exit(1);
  }
  FACILITATOR = found;
  console.log(
    `[startup] facilitator discovery OK: scheme=${FACILITATOR.scheme} network=${FACILITATOR.network} x402Version=${FACILITATOR.x402Version}`
  );
}

// ---------------------------------------------------------------------------
// Payment requirements builder
// ---------------------------------------------------------------------------

function buildPaymentRequirements(req, { invoiceId, asset, amount, issuer } = {}) {
  const isIou = asset !== undefined && asset !== "XRP";
  return {
    scheme: FACILITATOR.scheme,
    network: FACILITATOR.network,
    amount: amount !== undefined ? String(amount) : String(TOLL_PRICE_DROPS),
    asset: asset !== undefined ? asset : "XRP",
    payTo: TOLL_DESTINATION,
    resource: { url: externalUrl(req) },
    maxTimeoutSeconds: 300,
    facilitatorUrl: FACILITATOR_URL,
    extra: {
      sourceTag: SOURCE_TAG,
      areFeesSponsored: false,
      ...(isIou ? { issuer: issuer !== undefined ? issuer : RLUSD_ISSUER } : {}),
      ...(invoiceId !== undefined ? { invoiceId } : {}),
    },
  };
}

// Build the paymentRequirements shape expected by the facilitator /verify and
// /settle endpoints. Mirrors the `accepted` object the payer echoes back:
// { scheme, network, asset, payTo, amount, maxTimeoutSeconds, extra }
function buildFacilitatorPaymentRequirements(accepted) {
  return {
    scheme: accepted.scheme,
    network: accepted.network,
    asset: accepted.asset ?? "XRP",
    payTo: accepted.payTo,
    amount: accepted.amount,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    extra: accepted.extra,
  };
}

// ---------------------------------------------------------------------------
// requirePayment middleware
// Returns true  -> caller may proceed to the gated handler (paymentReceipt
//                  is attached to res.paymentReceipt).
// Returns false -> response has already been fully written; caller must stop.
// ---------------------------------------------------------------------------

async function requirePayment(req, res) {
  const sigHeader = getHeaderCI(req, "PAYMENT-SIGNATURE") ?? getHeaderCI(req, "X-PAYMENT");

  if (!sigHeader) {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: externalUrl(req) },
      accepts: [
      buildPaymentRequirements(req, { invoiceId: crypto.randomUUID() }),
      buildPaymentRequirements(req, {
        invoiceId: crypto.randomUUID(),
        asset: RLUSD_CURRENCY_HEX,
        amount: RLUSD_PRICE,
        issuer: RLUSD_ISSUER,
      }),
    ],
    };
    const encoded = b64encode(paymentRequired);
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encoded,
    });
    res.end(JSON.stringify(paymentRequired));
    log({ method: req.method, path: req.url, status: 402, payment_status: "unpaid" });
    return false;
  }

  let decoded;
  try {
    decoded = b64decode(sigHeader);
  } catch (err) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-ERROR": b64encode("malformed_payment_signature"),
    });
    res.end(JSON.stringify({ error: "malformed_payment_signature", code: 402 }));
    log({ method: req.method, path: req.url, status: 402, payment_status: "error" });
    return false;
  }

  const accepted = decoded?.accepted;
  if (!accepted || !decoded?.payload?.signedTxBlob) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-ERROR": b64encode("malformed_payment_signature"),
    });
    res.end(JSON.stringify({ error: "malformed_payment_signature", code: 402 }));
    log({ method: req.method, path: req.url, status: 402, payment_status: "error", extra: "missing_accepted_or_signedTxBlob" });
    return false;
  }

  const paymentPayload = decoded;
  const paymentRequirements = buildFacilitatorPaymentRequirements(accepted);

  let verifyJson;
  try {
    const verifyBody = { paymentPayload, paymentRequirements, x402Version: 2 };
    console.log("[verify-request] body:", JSON.stringify(verifyBody));
    const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
    verifyJson = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok || verifyJson?.isValid === false || verifyJson?.valid === false) {
      console.error(
        "[verify-failed] status:",
        verifyRes.status,
        "body:",
        JSON.stringify(verifyJson)
      );
      const reason = verifyJson?.invalidReason ?? verifyJson?.error ?? "verify_failed";
      res.writeHead(402, {
        "Content-Type": "application/json",
        "PAYMENT-ERROR": b64encode(String(reason)),
      });
      res.end(JSON.stringify({ error: String(reason), code: 402 }));
      log({ method: req.method, path: req.url, status: 402, payment_status: "error", extra: `verify_reason=${reason}` });
      return false;
    }
  } catch (err) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-ERROR": b64encode(`verify_request_failed: ${err.message}`),
    });
    res.end(JSON.stringify({ error: "verify_request_failed", code: 402 }));
    log({ method: req.method, path: req.url, status: 402, payment_status: "error", extra: `verify_exception=${err.message}` });
    return false;
  }

  let settleJson;
  try {
    const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements, x402Version: 2 }),
    });
    settleJson = await settleRes.json().catch(() => ({}));
    if (!settleRes.ok || settleJson?.success === false) {
      console.error(
        "[settle-failed] status:",
        settleRes.status,
        "body:",
        JSON.stringify(settleJson)
      );
      const reason = settleJson?.error ?? "settle_failed";
      res.writeHead(402, {
        "Content-Type": "application/json",
        "PAYMENT-ERROR": b64encode(String(reason)),
      });
      res.end(JSON.stringify({ error: String(reason), code: 402 }));
      log({ method: req.method, path: req.url, status: 402, payment_status: "error", extra: `settle_reason=${reason}` });
      return false;
    }
  } catch (err) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-ERROR": b64encode(`settle_request_failed: ${err.message}`),
    });
    res.end(JSON.stringify({ error: "settle_request_failed", code: 402 }));
    log({ method: req.method, path: req.url, status: 402, payment_status: "error", extra: `settle_exception=${err.message}` });
    return false;
  }

  res.paymentReceipt = settleJson;
  return true;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(req, res) {
  const body = { ok: true, facilitator: FACILITATOR };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  log({ method: req.method, path: req.url, status: 200, payment_status: "unpaid" });
}

async function handleDiscoveryDoc(req, res, key) {
  const doc = DISCOVERY_DOCS[key];
  if (!doc) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `discovery_doc_missing:${key}`, code: 503 }));
    log({ method: req.method, path: req.url, status: 503, payment_status: "unpaid" });
    return;
  }
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch === doc.etag) {
    res.writeHead(304, { ETag: doc.etag, "Cache-Control": "public, max-age=300" });
    res.end();
    log({ method: req.method, path: req.url, status: 304, payment_status: "unpaid" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": doc.contentType,
    "Cache-Control": "public, max-age=300",
    ETag: doc.etag,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(doc.body);
  log({ method: req.method, path: req.url, status: 200, payment_status: "unpaid" });
}

async function handleDiscovery(req, res) {
  const sample = {
    x402Version: 2,
    accepts: [
      buildPaymentRequirements(req, { invoiceId: crypto.randomUUID() }),
      buildPaymentRequirements(req, {
        invoiceId: crypto.randomUUID(),
        asset: RLUSD_CURRENCY_HEX,
        amount: RLUSD_PRICE,
        issuer: RLUSD_ISSUER,
      }),
    ],
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(sample));
  log({ method: req.method, path: req.url, status: 200, payment_status: "unpaid" });
}

async function handleWalletRisk(req, res) {
  const ok = await requirePayment(req, res);
  if (!ok) return; // response already sent by requirePayment

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  const receipt = res.paymentReceipt;
  const addr = body.address;
  const chainOverride = typeof body.chain === 'string' ? body.chain.toLowerCase() : undefined;

  if (!addr) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing_address", message: 'provide {"address":"..."} in request body' }));
    log({ method: req.method, path: req.url, status: 400, payment_status: "settled" });
    return;
  }

  let responseBody;
  let statusCode;
  try {
    const result = await scoreWallet(addr, chainOverride);
    if (result && result.error) {
      statusCode = 400;
      responseBody = result;
    } else {
      statusCode = 200;
      responseBody = result;
    }
  } catch (e) {
    console.error('[wallet-risk] handler error:', e);
    statusCode = 500;
    responseBody = { error: "internal_error", message: e.message };
  }

  const headers = { "Content-Type": "application/json" };
  if (statusCode === 200) headers["PAYMENT-RESPONSE"] = b64encode(receipt);
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(responseBody));
  log({ method: req.method, path: req.url, status: statusCode, payment_status: "settled" });
}

async function handleContractRisk(req, res) {
  const ok = await requirePayment(req, res);
  if (!ok) return;

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  const receipt = res.paymentReceipt;
  const addr = body.address;
  const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : 'eth';

  if (!addr) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing_address", message: 'provide {"address":"...","chain":"eth|base"} in request body' }));
    log({ method: req.method, path: req.url, status: 400, payment_status: "settled" });
    return;
  }

  let responseBody;
  let statusCode;
  try {
    const result = await scoreContract(addr, chain);
    if (result && result.error) {
      statusCode = 400;
      responseBody = result;
    } else {
      statusCode = 200;
      responseBody = result;
    }
  } catch (e) {
    console.error('[contract-risk] handler error:', e);
    statusCode = 500;
    responseBody = { error: "internal_error", message: e.message };
  }

  const headers = { "Content-Type": "application/json" };
  if (statusCode === 200) headers["PAYMENT-RESPONSE"] = b64encode(receipt);
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(responseBody));
  log({ method: req.method, path: req.url, status: statusCode, payment_status: "settled" });
}

async function handleTxSimulateRisk(req, res) {
  const ok = await requirePayment(req, res);
  if (!ok) return;

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  const receipt = res.paymentReceipt;
  const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : 'eth';
  const from = body.from;
  const to = body.to;
  const data = body.data;
  const value = body.value;

  if (!from) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "missing_from",
      message: 'provide {"chain":"eth","from":"0x...","to":"0x...","data":"0x...","value":"0"} in request body'
    }));
    log({ method: req.method, path: req.url, status: 400, payment_status: "settled" });
    return;
  }

  let responseBody;
  let statusCode;
  try {
    const result = await simulateTransaction({ chain, from, to, data, value });
    if (result && result.error) {
      statusCode = 400;
      responseBody = result;
    } else {
      statusCode = 200;
      responseBody = result;
    }
  } catch (e) {
    console.error('[tx-simulate-risk] handler error:', e);
    statusCode = 500;
    responseBody = { error: "internal_error", message: e.message };
  }

  const headers = { "Content-Type": "application/json" };
  if (statusCode === 200) headers["PAYMENT-RESPONSE"] = b64encode(receipt);
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(responseBody));
  log({ method: req.method, path: req.url, status: statusCode, payment_status: "settled" });
}

async function handleScopeCheck(req, res) {
  const ok = await requirePayment(req, res);
  if (!ok) return;

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  const receipt = res.paymentReceipt;
  const chain = typeof body.chain === 'string' ? body.chain : undefined;
  const addr = body.address;
  const addrs = body.addresses;

  if (!addr && !Array.isArray(addrs)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "missing_address",
      message: 'provide {"address":"0x...","chain":"eth|base|arb|opt|polygon|..."} or {"addresses":[...]} in request body'
    }));
    log({ method: req.method, path: req.url, status: 400, payment_status: "settled" });
    return;
  }

  let responseBody;
  let statusCode;
  try {
    const result = Array.isArray(addrs)
      ? lookupScopeBatch(addrs, chain)
      : lookupScope(addr, chain);
    if (result && result.error) {
      statusCode = 400;
      responseBody = result;
    } else {
      statusCode = 200;
      responseBody = result;
    }
  } catch (e) {
    console.error('[scope-check] handler error:', e);
    statusCode = 500;
    responseBody = { error: "internal_error", message: e.message };
  }

  const headers = { "Content-Type": "application/json" };
  if (statusCode === 200) headers["PAYMENT-RESPONSE"] = b64encode(receipt);
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(responseBody));
  log({ method: req.method, path: req.url, status: statusCode, payment_status: "settled" });
}

async function handleNotFound(req, res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", code: 404 }));
  log({ method: req.method, path: req.url, status: 404, payment_status: "unpaid" });
}

// ---------------------------------------------------------------------------
// Phase 6.0 — API-key auth
// ---------------------------------------------------------------------------

/**
 * Extract a Bearer token from the Authorization header. Returns the raw
 * token (no scheme prefix) or null.
 */
function extractBearer(req) {
  const raw = getHeaderCI(req, "authorization");
  if (!raw || typeof raw !== "string") return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Constant-time string comparison. Length differences leak, which is
 * acceptable here since the admin key length is fixed.
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Middleware for API-key-gated endpoints. Verifies the Bearer token,
 * enforces rate limits, and writes a 401/429 response on failure.
 * Returns { ok: true, key } on success (caller should proceed with the
 * business logic) or { ok: false } if the response has already been sent.
 */
async function requireApiKey(req, res, rateLimitOpts = {}) {
  const bearer = extractBearer(req);
  if (!bearer) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="xrpl-tollbooth"',
    });
    res.end(JSON.stringify({ error: "missing_api_key", code: 401 }));
    log({ method: req.method, path: req.url, status: 401, payment_status: "unauthenticated" });
    return { ok: false };
  }

  const key = verifyApiKey(bearer);
  if (!key) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="xrpl-tollbooth", error="invalid_token"',
    });
    res.end(JSON.stringify({ error: "invalid_api_key", code: 401 }));
    log({ method: req.method, path: req.url, status: 401, payment_status: "unauthenticated" });
    return { ok: false };
  }

  const rl = checkRateLimit(key.id, rateLimitOpts);
  res.setHeader("X-RateLimit-Limit", String(rl.cap));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rl.remaining)));
  res.setHeader("X-RateLimit-Reset", String(rl.resetAt));
  if (!rl.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(rl.retryAfterSec),
    });
    res.end(JSON.stringify({ error: "rate_limited", code: 429, retryAfterSec: rl.retryAfterSec }));
    log({
      method: req.method,
      path: req.url,
      status: 429,
      payment_status: "authenticated",
      extra: `key=${key.prefix} rate_limited`,
    });
    return { ok: false };
  }

  return { ok: true, key };
}

/**
 * Middleware for admin routes. Requires ADMIN_MASTER_KEY as Bearer.
 * Returns { ok: true } or writes the response and returns { ok: false }.
 */
function requireMasterKey(req, res) {
  if (!ADMIN_MASTER_KEY) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "admin_key_not_configured", code: 503 }));
    log({ method: req.method, path: req.url, status: 503, payment_status: "unauthenticated" });
    return { ok: false };
  }
  const bearer = extractBearer(req);
  if (!bearer || !timingSafeEqualStr(bearer, ADMIN_MASTER_KEY)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="xrpl-tollbooth-admin"',
    });
    res.end(JSON.stringify({ error: "invalid_admin_credentials", code: 401 }));
    log({ method: req.method, path: req.url, status: 401, payment_status: "unauthenticated" });
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin route handlers (Phase 6.0)
// ---------------------------------------------------------------------------

async function handleAdminCreateKey(req, res) {
  if (!requireMasterKey(req, res).ok) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json_body", code: 400 }));
    return;
  }
  const name = body?.name;
  try {
    const created = createApiKey(name);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: created.id,
        name: created.name,
        prefix: created.prefix,
        key: created.plaintext, // shown exactly once
        created_at: created.createdAt,
        warning: "Store this key immediately — it will never be shown again.",
      })
    );
    log({
      method: req.method,
      path: req.url,
      status: 201,
      payment_status: "admin",
      extra: `created_key=${created.prefix} name=${created.name}`,
    });
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, code: 400 }));
  }
}

async function handleAdminListKeys(req, res) {
  if (!requireMasterKey(req, res).ok) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const includeRevoked = url.searchParams.get("include_revoked") !== "false";
  const keys = listApiKeys({ includeRevoked });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ keys, count: keys.length }));
  log({ method: req.method, path: req.url, status: 200, payment_status: "admin" });
}

async function handleAdminRevokeKey(req, res, idStr) {
  if (!requireMasterKey(req, res).ok) return;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_key_id", code: 400 }));
    return;
  }
  const result = revokeApiKey(id);
  const status = result.revoked ? 200 : 404;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
  log({
    method: req.method,
    path: req.url,
    status,
    payment_status: "admin",
    extra: `revoke_id=${id} revoked=${result.revoked}`,
  });
}

// ---------------------------------------------------------------------------
// Phase 6.1 — /verify-poc (API-key gated, per-route rate limit)
// ---------------------------------------------------------------------------

async function handleVerifyPoc(req, res) {
  const auth = await requireApiKey(req, res, {
    cap: VERIFY_POC_CAP_PER_MINUTE,
    bucket: "verify-poc",
  });
  if (!auth.ok) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json_body", code: 400 }));
    log({
      method: req.method,
      path: req.url,
      status: 400,
      payment_status: "authenticated",
      extra: `key=${auth.key.prefix} invalid_json`,
    });
    return;
  }

  const result = await verifyPoc({
    test_file_b64: body?.test_file,
    chain: body?.chain,
    fork_block: body?.fork_block,
    expected_result: body?.expected_result,
    solidity_version: body?.solidity_version,
    rpc_url: body?.rpc_url,
  });

  // Choose HTTP status from reason codes.
  //   200 — grading completed (verified true or false, or POC_UNVERIFIED)
  //   400 — bad input the caller can fix (missing/oversize/base64/chain/policy)
  //   422 — compile / parse issue — caller's Solidity, not our fault
  //   504 — timeout
  //   502 — upstream (RPC) unreachable
  //   500 — internal
  const codes = new Set(result.reason_codes);
  const status =
    codes.has("UNSUPPORTED_CHAIN") ||
    codes.has("INVALID_EXPECTED_RESULT") ||
    codes.has("MISSING_TEST_FILE") ||
    codes.has("TEST_FILE_TOO_LARGE") ||
    codes.has("INVALID_BASE64") ||
    codes.has("FFI_DISALLOWED") ||
    codes.has("FS_WRITE_DISALLOWED") ||
    codes.has("ENV_WRITE_DISALLOWED")
      ? 400
      : codes.has("COMPILE_ERROR") || codes.has("PARSE_FAILURE") || codes.has("NO_TESTS_FOUND")
      ? 422
      : codes.has("TIMEOUT")
      ? 504
      : codes.has("RPC_UNREACHABLE")
      ? 502
      : codes.has("INTERNAL_ERROR") || codes.has("FORGE_STD_BOOTSTRAP_FAILED")
      ? 500
      : 200;

  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
  log({
    method: req.method,
    path: req.url,
    status,
    payment_status: "authenticated",
    extra: `key=${auth.key.prefix} verified=${result.verified} codes=${result.reason_codes.join(",")} duration=${result.duration_ms}ms`,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      return await handleHealth(req, res);
    }
    if (req.method === "GET" && path === "/.well-known/openapi.json") {
      return await handleDiscoveryDoc(req, res, "openapi");
    }

    if (req.method === "GET" && path === "/.well-known/agent.json") {
      return await handleDiscoveryDoc(req, res, "agent");
    }

    if (req.method === "GET" && path === "/.well-known/x402") {
      return await handleDiscovery(req, res);
    }
    if (req.method === "POST" && path === "/wallet-risk") {
      return await handleWalletRisk(req, res);
    }
    if (req.method === "POST" && path === "/contract-risk") {
      return await handleContractRisk(req, res);
    }
    if (req.method === "POST" && path === "/tx-simulate-risk") {
      return await handleTxSimulateRisk(req, res);
    }
    if (req.method === "POST" && path === "/scope-check") {
      return await handleScopeCheck(req, res);
    }

    // Phase 6.0 — admin routes (master-key gated)
    if (req.method === "POST" && path === "/admin/keys") {
      return await handleAdminCreateKey(req, res);
    }
    if (req.method === "GET" && path === "/admin/keys") {
      return await handleAdminListKeys(req, res);
    }
    const revokeMatch = path.match(/^\/admin\/keys\/(\d+)$/);
    if (req.method === "DELETE" && revokeMatch) {
      return await handleAdminRevokeKey(req, res, revokeMatch[1]);
    }

    // Phase 6.1 — /verify-poc (API-key gated, tighter per-route cap)
    if (req.method === "POST" && path === "/verify-poc") {
      return await handleVerifyPoc(req, res);
    }

    // Phase 6.0 — auth ping (api-key gated, no business logic).
    // Lets partners verify their key works without spending credits.
    if (req.method === "GET" && path === "/auth-ping") {
      const auth = await requireApiKey(req, res);
      if (!auth.ok) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          key: { id: auth.key.id, name: auth.key.name, prefix: auth.key.prefix },
          rate_limit: { per_minute: RATE_LIMIT_CONFIG.cap },
        })
      );
      log({
        method: req.method,
        path,
        status: 200,
        payment_status: "authenticated",
        extra: `key=${auth.key.prefix}`,
      });
      return;
    }

    return await handleNotFound(req, res);
  } catch (err) {
    console.error(`[error] ${req.method} ${path}: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", code: 500 }));
    }
    log({ method: req.method, path, status: 500, payment_status: "error" });
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await initFacilitator();

const server = http.createServer((req, res) => {
  router(req, res);
});

server.listen(PORT, () => {
  console.log(
    `tollbooth listening on :${PORT} (dest=${TOLL_DESTINATION}, price=${TOLL_PRICE_DROPS} drops, facilitator=${FACILITATOR_URL}, scheme=${FACILITATOR.scheme}, network=${FACILITATOR.network}, x402Version=${FACILITATOR.x402Version})`
  );
});

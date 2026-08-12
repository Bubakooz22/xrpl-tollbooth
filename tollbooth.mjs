import http from "node:http";
import crypto from "node:crypto";
import { scoreWallet } from './lib/wallet-risk.mjs';

// ---------------------------------------------------------------------------
// x402 v2 compliant tollbooth merchant server.
// Node built-ins only. No express/fastify. Async/await throughout.
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ["TOLL_DESTINATION", "TOLL_PRICE_DROPS", "FACILITATOR_URL", "PORT"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] FATAL: missing required env var ${key}`);
    process.exit(1);
  }
}

const TOLL_DESTINATION = process.env.TOLL_DESTINATION;
const TOLL_PRICE_DROPS = process.env.TOLL_PRICE_DROPS;
const FACILITATOR_URL = process.env.FACILITATOR_URL.replace(/\/+$/, "");
const PORT = Number(process.env.PORT);
const SOURCE_TAG = Number(process.env.TOLL_SOURCE_TAG ?? 804681468);

// --- RLUSD (Ripple USD) support -------------------------------------------------
// Testnet RLUSD issuer per Ripple docs (docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)
// and confirmed via t54's XRPL x402 facilitator scheme docs (xrpl-x402.t54.ai/docs/xrpl-scheme).
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
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
    resource: { url: `http://${req.headers.host}${req.url}` },
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
      resource: { url: `http://${req.headers.host}${req.url}` },
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

  if (!addr) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing_address", message: 'provide {"address":"..."} in request body' }));
    log({ method: req.method, path: req.url, status: 400, payment_status: "settled" });
    return;
  }

  let responseBody;
  let statusCode;
  try {
    const result = await scoreWallet(addr);
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

async function handleNotFound(req, res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", code: 404 }));
  log({ method: req.method, path: req.url, status: 404, payment_status: "unpaid" });
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
    if (req.method === "GET" && path === "/.well-known/x402") {
      return await handleDiscovery(req, res);
    }
    if (req.method === "POST" && path === "/wallet-risk") {
      return await handleWalletRisk(req, res);
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

#!/usr/bin/env node
// scripts/paid-call.mjs
//
// End-to-end x402 paid call to any tollbooth endpoint.
//
//   1. GET /endpoint -> 402 with paymentRequired
//   2. Pick the XRP rail (default) or --asset RLUSD
//   3. Sign & submit XRPL Payment (SourceTag from 402.extra)
//   4. Re-POST with X-PAYMENT: base64({accepted, payload:{signedTxBlob}})
//   5. Print status, decoded PAYMENT-RESPONSE, and response body
//
// Env:
//   XRPL_SEED             payer seed (required)
//   TESTNET_URL           optional, defaults wss://s.altnet.rippletest.net:51233
//   TOLLBOOTH_URL         optional, defaults http://localhost:8787
//
// Usage:
//   node --env-file=.env scripts/paid-call.mjs <path> <json-body-file-or-inline>
//
// Examples:
//   node --env-file=.env scripts/paid-call.mjs /tx-simulate-risk '{"chain":"eth","from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0x0000000000000000000000000000000000000000","value":"1000000000000000000"}'
//   node --env-file=.env scripts/paid-call.mjs /contract-risk '{"address":"0xdac17f958d2ee523a2206206994597c13d831ec7","chain":"eth"}'
//   node --env-file=.env scripts/paid-call.mjs /tx-simulate-risk ./fixtures/eth-transfer.json

import { Client, Wallet } from "xrpl";
import { XRPLPresignedPaymentPayer } from "x402-xrpl";
import fs from "node:fs";

const TESTNET_URL = process.env.TESTNET_URL ?? "wss://s.altnet.rippletest.net:51233";
const TOLLBOOTH_URL = process.env.TOLLBOOTH_URL ?? "http://localhost:8787";
const LEDGER_BUFFER = 300;

function b64encode(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function b64decode(s) {
  try { return JSON.parse(Buffer.from(s, "base64").toString("utf8")); }
  catch { return null; }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { asset: "XRP", verbose: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--asset") { opts.asset = args[++i]; continue; }
    if (a === "--verbose" || a === "-v") { opts.verbose = true; continue; }
    if (a === "--help" || a === "-h") { opts.help = true; continue; }
    positional.push(a);
  }
  opts.path = positional[0];
  opts.body = positional[1];
  return opts;
}

function loadBody(bodyArg) {
  if (!bodyArg) return {};
  // If it looks like JSON, parse inline
  const trimmed = bodyArg.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // Otherwise treat as file path
  return JSON.parse(fs.readFileSync(bodyArg, "utf8"));
}

async function main() {
  const opts = parseArgs();
  if (opts.help || !opts.path) {
    console.error("usage: node --env-file=.env scripts/paid-call.mjs <path> <json-body-or-file> [--asset XRP|RLUSD] [--verbose]");
    console.error("");
    console.error("example: node --env-file=.env scripts/paid-call.mjs /tx-simulate-risk '{\"chain\":\"eth\",\"from\":\"0x...\",\"to\":\"0x...\",\"value\":\"0\"}'");
    process.exit(1);
  }

  const seed = process.env.XRPL_SEED;
  if (!seed) {
    console.error("XRPL_SEED not set (run with --env-file=.env)");
    process.exit(1);
  }

  const url = `${TOLLBOOTH_URL}${opts.path}`;
  const bodyObj = loadBody(opts.body);
  const bodyStr = JSON.stringify(bodyObj);

  // --- Step 1: initial POST, expect 402 ---
  console.log(`[1/4] POST ${url} (unauthenticated)`);
  const r402 = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyStr,
  });
  if (r402.status !== 402) {
    console.error(`  expected 402, got ${r402.status}`);
    console.error(await r402.text());
    process.exit(2);
  }
  const challenge = await r402.json();
  const wantAsset = opts.asset === "RLUSD" ? "524C555344000000000000000000000000000000" : "XRP";
  const accepted = challenge.accepts.find(a => a.asset === wantAsset);
  if (!accepted) {
    console.error(`  no accepts entry for asset=${opts.asset}`);
    console.error(JSON.stringify(challenge, null, 2));
    process.exit(2);
  }
  console.log(`  402 OK. Selected rail: ${opts.asset} amount=${accepted.amount} payTo=${accepted.payTo}`);
  if (opts.verbose) console.log("  accepted:", JSON.stringify(accepted, null, 2));

  if (opts.asset === "RLUSD") {
    console.error("  RLUSD payment not implemented in this helper yet (need TrustSet + IOU Payment). Use --asset XRP.");
    process.exit(2);
  }

  // --- Step 2: sign XRPL Payment via x402-xrpl library ---
  // The library handles: canonical JSON, invoiceId in payload, sha256 InvoiceID field,
  // invoice memo, LastLedgerSequence math, and the exact envelope shape the facilitator expects.
  console.log(`[2/4] Signing XRPL Payment on ${TESTNET_URL}`);
  const wallet = Wallet.fromSeed(seed);
  const client = new Client(TESTNET_URL);
  await client.connect();
  let xPayment, signedHash;
  try {
    const payer = new XRPLPresignedPaymentPayer(
      { wallet, wsUrl: TESTNET_URL, network: accepted.network },
      { client },
    );
    const prepared = await payer.preparePayment(accepted);
    xPayment = prepared.paymentHeader;
    // Compute tx hash for logging only
    const { hashes } = await import("xrpl");
    signedHash = hashes?.hashSignedTx?.(prepared.signedTxBlob) ?? "(unknown)";
    console.log(`  signed. tx_hash=${signedHash} from=${wallet.address}`);
    console.log(`  (facilitator will submit — client does not pre-submit)`);
  } finally {
    await client.disconnect();
  }

  // --- Step 3: re-POST with X-PAYMENT header ---
  console.log(`[3/4] Re-POST ${url} with X-PAYMENT`);
  const t0 = Date.now();
  const rFinal = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": xPayment,
    },
    body: bodyStr,
  });
  const dt = Date.now() - t0;
  console.log(`  status ${rFinal.status} (${dt}ms)`);

  const pr = rFinal.headers.get("payment-response") ?? rFinal.headers.get("PAYMENT-RESPONSE");
  if (pr) {
    const decoded = b64decode(pr);
    console.log(`  PAYMENT-RESPONSE: ${JSON.stringify(decoded)}`);
  }

  // --- Step 4: print body ---
  console.log(`[4/4] Response body:`);
  const text = await rFinal.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }

  process.exit(rFinal.status >= 200 && rFinal.status < 300 ? 0 : 4);
}

main().catch(err => {
  console.error("paid-call error:", err);
  process.exit(99);
});

#!/usr/bin/env node
// integrations/claude-code-skill/helpers/tollbooth.mjs
//
// One-shot dispatcher for the seven tollbooth endpoints. Reads
// /.well-known/agent.json at each invocation to auto-detect auth mode.
//
// Usage:
//   node --env-file=.env integrations/claude-code-skill/helpers/tollbooth.mjs <endpointId> [jsonBody]
//
// Examples:
//   node --env-file=.env .../tollbooth.mjs authPing
//   node --env-file=.env .../tollbooth.mjs walletRisk '{"chain":"eth","address":"0x..."}'
//   node --env-file=.env .../tollbooth.mjs contractRisk '{"chain":"eth","address":"0x..."}'
//   node --env-file=.env .../tollbooth.mjs txSimulateRisk '{"chain":"eth","from":"0x...","to":"0x...","data":"0x..."}'
//   node --env-file=.env .../tollbooth.mjs scopeCheck '{"address":"0x..."}'
//   node --env-file=.env .../tollbooth.mjs verifyPoc '{"test_file":"<base64>","expected_result":"pass"}'
//
// Env:
//   TOLLBOOTH_URL       default http://127.0.0.1:8787
//   TOLLBOOTH_API_KEY   required for verifyPoc + authPing
//   XRPL_SEED           required for x402 endpoints (payer)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TOLLBOOTH_URL = process.env.TOLLBOOTH_URL ?? "http://127.0.0.1:8787";
const API_KEY = process.env.TOLLBOOTH_API_KEY ?? "";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

// Camel-case aliases the user is likely to type -> canonical agent.json id.
const ALIASES = {
  walletRisk: "wallet-risk",
  contractRisk: "contract-risk",
  txSimulateRisk: "tx-simulate-risk",
  scopeCheck: "scope-check",
  verifyPoc: "verify-poc",
  authPing: "auth-ping",
  "wallet-risk": "wallet-risk",
  "contract-risk": "contract-risk",
  "tx-simulate-risk": "tx-simulate-risk",
  "scope-check": "scope-check",
  "verify-poc": "verify-poc",
  "auth-ping": "auth-ping",
};

function usage(code = 2) {
  const script = "integrations/claude-code-skill/helpers/tollbooth.mjs";
  console.error(`Usage: node --env-file=.env ${script} <endpointId> [jsonBody]`);
  console.error("");
  console.error("Endpoints: walletRisk contractRisk txSimulateRisk scopeCheck verifyPoc authPing");
  process.exit(code);
}

async function loadManifest() {
  const url = `${TOLLBOOTH_URL}/.well-known/agent.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`agent.json fetch failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function callBearer(endpoint, body) {
  if (!API_KEY) {
    throw new Error("TOLLBOOTH_API_KEY not set. This endpoint is in closed beta; set the key in .env.");
  }
  const url = `${TOLLBOOTH_URL}${endpoint.path}`;
  const init = {
    method: endpoint.method,
    headers: { Authorization: `Bearer ${API_KEY}` },
  };
  if (body !== null && body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, body: json ?? text };
}

function callX402(endpoint, body) {
  // Shell out to scripts/paid-call.mjs so the skill inherits the same
  // battle-tested x402 flow every smoke test uses.
  if (!process.env.XRPL_SEED) {
    throw new Error("XRPL_SEED not set. x402 endpoints need a payer seed in .env.");
  }
  const paidCall = path.join(REPO_ROOT, "scripts", "paid-call.mjs");
  const args = ["--env-file=" + path.join(REPO_ROOT, ".env"), paidCall, endpoint.path];
  if (body !== null && body !== undefined) args.push(JSON.stringify(body));
  const result = spawnSync("node", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, TOLLBOOTH_URL },
  });
  if (result.status !== 0) {
    throw new Error(
      `paid-call.mjs exited ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`
    );
  }
  // paid-call.mjs prints human-readable status + response body. We extract
  // the final JSON payload if present, otherwise return raw stdout.
  const stdout = result.stdout;
  const jsonStart = stdout.lastIndexOf("{");
  if (jsonStart === -1) return { status: 200, body: stdout };
  try {
    const candidate = stdout.slice(jsonStart);
    return { status: 200, body: JSON.parse(candidate) };
  } catch {
    return { status: 200, body: stdout };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();
  if (args[0] === "--help" || args[0] === "-h") usage(0);

  const rawId = args[0];
  const canonicalId = ALIASES[rawId];
  if (!canonicalId) {
    console.error(`Unknown endpoint: ${rawId}`);
    usage();
  }

  let body = null;
  if (args.length >= 2) {
    try {
      body = JSON.parse(args[1]);
    } catch (err) {
      console.error(`Invalid JSON body: ${err.message}`);
      process.exit(2);
    }
  }

  const manifest = await loadManifest();
  const endpoint = manifest.endpoints.find((e) => e.id === canonicalId);
  if (!endpoint) {
    console.error(`Endpoint ${canonicalId} not listed in current agent.json.`);
    console.error(`Available: ${manifest.endpoints.map((e) => e.id).join(", ")}`);
    process.exit(3);
  }

  let result;
  if (endpoint.auth === "bearer_api_key") {
    result = await callBearer(endpoint, body);
  } else if (endpoint.auth === "x402") {
    result = callX402(endpoint, body);
  } else {
    throw new Error(`Unsupported auth model: ${endpoint.auth}`);
  }

  // Print JSON to stdout, use stderr for meta so callers can pipe.
  console.error(`[tollbooth] ${endpoint.method} ${endpoint.path} \u2192 ${result.status}`);
  console.log(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[tollbooth] FATAL: ${err.message}`);
  process.exit(4);
});

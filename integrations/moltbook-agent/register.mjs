#!/usr/bin/env node
// XRPL Toll Booth — Moltbook agent registration
//
// One-shot registration for the tollbooth agent. Persists the API key to a
// file under XDG_CONFIG_HOME (default ~/.config/moltbook/credentials.json),
// then prints the claim URL for the human to complete X verification.
//
// Never logs the API key. Never writes it to stdout. Never commits it.
//
// Usage:
//   node register.mjs              # register with defaults
//   node register.mjs --dry-run    # print the payload we'd send, don't send
//   node register.mjs --show-claim # re-print the last-saved claim URL, don't re-register

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// -------- config --------
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
// The 'www.' is REQUIRED — per skill.md, non-www strips Auth headers.

const AGENT_NAME = process.env.MOLTBOOK_AGENT_NAME || "tollbooth";
const AGENT_DESC =
  process.env.MOLTBOOK_AGENT_DESC ||
  "The pay-per-call safety layer for AI agents. OFAC + scam + exploit checks on any wallet or contract, priced in XRP via x402. Refuses at critical, warns at soft. https://github.com/Bubakooz22/xrpl-tollbooth";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "moltbook")
  : path.join(os.homedir(), ".config", "moltbook");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");

// -------- helpers --------
function log(msg) {
  process.stderr.write(`[register] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[register] ERROR: ${msg}\n`);
  process.exit(code);
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function saveCredentials(payload) {
  ensureConfigDir();
  // Write with mode 0600 — owner read/write only.
  const tmp = CREDS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDS_FILE);
  fs.chmodSync(CREDS_FILE, 0o600);
}

function loadCredentials() {
  if (!fs.existsSync(CREDS_FILE)) return null;
  return JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
}

// -------- main --------
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const showClaim = args.has("--show-claim");

if (showClaim) {
  const existing = loadCredentials();
  if (!existing) die(`No credentials found at ${CREDS_FILE}. Run without --show-claim first.`);
  if (!existing.claim_url) die("Saved credentials have no claim_url. Was verification already completed?");
  console.log(existing.claim_url);
  process.exit(0);
}

// Refuse to re-register if we already have credentials for this name.
const existing = loadCredentials();
if (existing && existing.agent_name === AGENT_NAME) {
  log(`Agent '${AGENT_NAME}' is already registered.`);
  log(`Credentials file: ${CREDS_FILE}`);
  if (existing.claimed_at) {
    log(`Claimed at: ${existing.claimed_at}`);
    log("Nothing to do. Use heartbeat.mjs from here.");
  } else {
    log("Not yet claimed. Human still needs to X-verify.");
    log(`Claim URL: ${existing.claim_url}`);
  }
  process.exit(0);
}

const payload = { name: AGENT_NAME, description: AGENT_DESC };

if (dryRun) {
  log(`DRY RUN — would POST ${MOLTBOOK_API}/agents/register with:`);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

log(`Registering agent '${AGENT_NAME}'...`);

const res = await fetch(`${MOLTBOOK_API}/agents/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const bodyText = await res.text();
let body;
try {
  body = JSON.parse(bodyText);
} catch {
  die(`Non-JSON response (HTTP ${res.status}): ${bodyText.slice(0, 400)}`);
}

if (!res.ok) {
  die(`Registration failed (HTTP ${res.status}): ${body.error || bodyText.slice(0, 400)}`);
}

if (!body.api_key || !body.claim_url) {
  die(`Malformed success response — missing api_key or claim_url. Raw: ${bodyText.slice(0, 400)}`);
}

// Persist. Never echo api_key to stdout.
const record = {
  agent_name: AGENT_NAME,
  agent_id: body.agent_id || body.id || null,
  api_key: body.api_key,
  claim_url: body.claim_url,
  verification_code: body.verification_code || null,
  registered_at: new Date().toISOString(),
  claimed_at: null,
};
saveCredentials(record);

log(`Registration succeeded.`);
log(`Credentials written to: ${CREDS_FILE} (mode 0600)`);
log(``);
log(`NEXT STEP — human action required:`);
log(`  1. Open the claim URL below in a browser.`);
log(`  2. Sign in with the X account you want to claim this agent.`);
log(`  3. Post the auto-generated tweet.`);
log(`  4. Moltbook verifies the tweet and marks the agent as claimed.`);
log(``);
log(`Claim URL:`);
console.log(body.claim_url);

// XRPL Toll Booth — LangChain.js tools.
//
// Copy-paste-ready. Each of the seven tollbooth endpoints is exposed as a
// LangChain.js DynamicStructuredTool with a Zod input schema. Auto-discovers
// pricing + auth mode from /.well-known/agent.json on first import.
//
// Usage:
//   import { buildTollboothTools } from './tollboothTools.mjs';
//   import { ChatOpenAI } from '@langchain/openai';
//   import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
//
//   const tools = await buildTollboothTools();
//   const llm = new ChatOpenAI({ model: 'gpt-4o', temperature: 0 });
//   ...
//
// Dependencies:
//   npm install @langchain/core @langchain/openai langchain zod
//
// Env vars: TOLLBOOTH_URL, TOLLBOOTH_API_KEY, XRPL_SEED (same as Python version).

import { DynamicStructuredTool } from '@langchain/core/tools';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const TOLLBOOTH_URL = process.env.TOLLBOOTH_URL || 'http://127.0.0.1:8787';
const TOLLBOOTH_API_KEY = process.env.TOLLBOOTH_API_KEY || '';

// Resolve scripts/paid-call.mjs relative to this file (repo/integrations/langchain-example/javascript/tollboothTools.mjs)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAID_CALL_SCRIPT = process.env.PAID_CALL_SCRIPT_PATH
  || path.join(REPO_ROOT, 'scripts', 'paid-call.mjs');

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function loadManifest() {
  const r = await fetch(`${TOLLBOOTH_URL}/.well-known/agent.json`);
  if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
  return r.json();
}

async function callBearer(pathname, method, body) {
  if (!TOLLBOOTH_API_KEY) {
    throw new Error(
      'TOLLBOOTH_API_KEY not set. This endpoint is in closed beta; open a '
      + 'GitHub issue on xrpl-tollbooth to request a key.'
    );
  }
  const r = await fetch(`${TOLLBOOTH_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOLLBOOTH_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try { return await r.json(); }
  catch { return { status: r.status, text: await r.text() }; }
}

function callX402(pathname, body) {
  if (!process.env.XRPL_SEED) {
    throw new Error(
      'XRPL_SEED not set. x402 endpoints need a payer seed. Add it to .env '
      + 'or export it before running.'
    );
  }
  const result = spawnSync(
    'node',
    [
      `--env-file=${path.join(REPO_ROOT, '.env')}`,
      PAID_CALL_SCRIPT,
      pathname,
      JSON.stringify(body),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TOLLBOOTH_URL },
      timeout: 180_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `paid-call.mjs exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`
    );
  }
  const stdout = result.stdout || '';
  const idx = stdout.lastIndexOf('{');
  if (idx === -1) return { raw: stdout };
  try { return JSON.parse(stdout.slice(idx)); }
  catch { return { raw: stdout }; }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const walletRiskTool = new DynamicStructuredTool({
  name: 'wallet_risk',
  description:
    'Score a wallet address for OFAC + curated scam-list membership. Costs '
    + '5000 drops XRP (~$0.0025) per call via x402. Chains: eth, xrpl, sol. '
    + 'Returns risk_level, score, reason_codes[], sources_checked[]. Codes: '
    + 'OFAC_SANCTIONED, SCAM_LIST_HIT, UNKNOWN_ADDRESS. Refuse to interact '
    + "if risk_level is 'critical'.",
  schema: z.object({
    chain: z.enum(['eth', 'xrpl', 'sol']).describe('Chain identifier'),
    address: z.string().describe('Wallet address to score'),
  }),
  func: async ({ chain, address }) =>
    JSON.stringify(callX402('/wallet-risk', { chain, address })),
});

const contractRiskTool = new DynamicStructuredTool({
  name: 'contract_risk',
  description:
    'Score a smart-contract address for known-exploit matches and source-code '
    + 'heuristics. Costs 5000 drops XRP per call via x402. Chain eth only. '
    + 'Codes: KNOWN_EXPLOIT_MATCH (refuse), SELFDESTRUCT_PRESENT, '
    + 'DELEGATECALL_PRESENT, PROXY_UPGRADEABLE, SOURCE_UNVERIFIED (warn).',
  schema: z.object({
    chain: z.literal('eth'),
    address: z.string(),
  }),
  func: async ({ chain, address }) =>
    JSON.stringify(callX402('/contract-risk', { chain, address })),
});

const txSimulateRiskTool = new DynamicStructuredTool({
  name: 'tx_simulate_risk',
  description:
    'Simulate an Ethereum transaction on a mainnet fork and grade the outcome. '
    + 'Costs 5000 drops XRP per call via x402. Detects unlimited approvals, '
    + 'ownership transfer, proxy upgrade, selfdestruct, reverts, and multi-token '
    + 'outbound flows. Codes: SELFDESTRUCT_INVOKED, UNLIMITED_APPROVAL_GRANTED, '
    + 'OWNERSHIP_TRANSFERRED, PROXY_UPGRADED (hard warn); TX_REVERTED, '
    + 'MULTIPLE_OUTBOUND_TOKEN_TRANSFERS (inform).',
  schema: z.object({
    chain: z.literal('eth'),
    from: z.string().describe('Sender address'),
    to: z.string().describe('Recipient / contract address'),
    data: z.string().default('').describe('Hex calldata (0x prefix optional)'),
    value: z.string().default('0').describe('Wei as decimal string'),
  }),
  func: async ({ chain, from, to, data, value }) =>
    JSON.stringify(callX402('/tx-simulate-risk', { chain, from, to, data, value })),
});

const scopeCheckTool = new DynamicStructuredTool({
  name: 'scope_check',
  description:
    'Check whether an address is in scope of any active bug bounty program. '
    + 'Costs 5000 drops XRP per call via x402. Returns in_scope (bool) and '
    + 'programs[] with platform, name, url, max_bounty. Absence of a match '
    + 'is not proof — the target may just not be tracked.',
  schema: z.object({
    address: z.string(),
    chain: z.enum(['eth', 'xrpl', 'sol']).default('eth'),
  }),
  func: async ({ address, chain }) =>
    JSON.stringify(callX402('/scope-check', { address, chain })),
});

const verifyPocTool = new DynamicStructuredTool({
  name: 'verify_poc',
  description:
    'Grade a Foundry PoC (.t.sol) against an Ethereum mainnet fork. Closed '
    + 'beta — requires TOLLBOOTH_API_KEY. Rate limit 10/min. Runs '
    + '`forge test --fork-url --json` in an ephemeral sandbox with ffi=false '
    + 'pinned. Single-file only, max 128 KB decoded. Returns verified (bool), '
    + 'reason_codes[], actual, gas_used, logs[], traces_head, duration_ms.',
  schema: z.object({
    test_file_base64: z.string().describe('.t.sol source, base64 encoded'),
    expected_result: z.enum(['pass', 'revert']).default('pass'),
    fork_block: z.number().int().optional(),
  }),
  func: async ({ test_file_base64, expected_result, fork_block }) => {
    const body = { test_file: test_file_base64, expected_result };
    if (fork_block !== undefined) body.fork_block = fork_block;
    return JSON.stringify(await callBearer('/verify-poc', 'POST', body));
  },
});

const authPingTool = new DynamicStructuredTool({
  name: 'auth_ping',
  description:
    'Verify the tollbooth API key is working. No side effects, no charge. '
    + 'Returns { ok, key: { id, name, prefix }, rate_limit: { per_minute } }.',
  schema: z.object({}),
  func: async () => JSON.stringify(await callBearer('/auth-ping', 'GET')),
});

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

export async function buildTollboothTools({ includeBeta = true } = {}) {
  // Warm the manifest so early config errors surface at import time.
  try { await loadManifest(); }
  catch (err) {
    throw new Error(
      `Could not reach tollbooth at ${TOLLBOOTH_URL}: ${err.message}. `
      + 'Set TOLLBOOTH_URL to a reachable host.'
    );
  }
  const tools = [walletRiskTool, contractRiskTool, txSimulateRiskTool, scopeCheckTool];
  if (includeBeta) tools.push(verifyPocTool, authPingTool);
  return tools;
}

// Smoke: `node tollboothTools.mjs` prints exposed tools.
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await loadManifest();
  console.log(`Tollbooth: ${m.display_name} v${m.version}`);
  console.log(`Endpoints in manifest: ${m.endpoints.length}`);
  const tools = await buildTollboothTools();
  console.log(`LangChain.js tools exposed: ${tools.length}`);
  for (const t of tools) console.log(`  - ${t.name}: ${t.description.split('.')[0]}.`);
}

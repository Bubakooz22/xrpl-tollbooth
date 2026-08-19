#!/usr/bin/env node
/**
 * XRPL Toll Booth — Cursor MCP server.
 *
 * Exposes the seven tollbooth endpoints as MCP tools over stdio, so Cursor
 * (and any other MCP client — Claude Desktop, custom hosts) can invoke them
 * from any project.
 *
 * Same design contract as the other integrations in this repo:
 *   1. Auto-discover /.well-known/agent.json on init
 *   2. Delegate x402 payment to scripts/paid-call.mjs
 *   3. Reason-code guidance carried inline in tool descriptions
 *
 * Environment variables (read at process start):
 *   TOLLBOOTH_URL       default http://127.0.0.1:8787
 *   TOLLBOOTH_API_KEY   required for verify_poc + auth_ping
 *   XRPL_SEED           required for x402 endpoints
 *   PAID_CALL_SCRIPT_PATH  optional override; defaults to ../../scripts/paid-call.mjs
 *
 * Wired into Cursor via .cursor/mcp.json — see README.md.
 *
 * NOTE: stdout is reserved for MCP JSON-RPC. All human logs go to stderr.
 *
 * Uses MCP SDK v1 (@modelcontextprotocol/sdk) — the stable line that Cursor
 * and Claude Desktop currently target. When v2 (@modelcontextprotocol/server)
 * stabilizes, the imports and registerTool shape will need a small refactor.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const TOLLBOOTH_URL = process.env.TOLLBOOTH_URL || 'http://127.0.0.1:8787';
const TOLLBOOTH_API_KEY = process.env.TOLLBOOTH_API_KEY || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js lives at integrations/cursor-mcp/dist/index.js
// scripts/paid-call.mjs lives at <repo>/scripts/paid-call.mjs
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAID_CALL_SCRIPT = process.env.PAID_CALL_SCRIPT_PATH
  || path.join(REPO_ROOT, 'scripts', 'paid-call.mjs');

function log(message: string): void {
  // stderr only — stdout is JSON-RPC.
  process.stderr.write(`[xrpl-tollbooth-mcp] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

async function callBearer(
  pathname: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!TOLLBOOTH_API_KEY) {
    throw new Error(
      'TOLLBOOTH_API_KEY not set in the MCP server env. Add it to '
      + '.cursor/mcp.json under this server\'s "env" field.',
    );
  }
  const res = await fetch(`${TOLLBOOTH_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOLLBOOTH_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try { return await res.json() as Record<string, unknown>; }
  catch { return { status: res.status, text: await res.text() }; }
}

function callX402(
  pathname: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!process.env.XRPL_SEED) {
    throw new Error(
      'XRPL_SEED not set in the MCP server env. Add it to .cursor/mcp.json '
      + 'under this server\'s "env" field. Testnet-only seeds recommended.',
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
      `paid-call.mjs exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  const stdout = result.stdout ?? '';
  const idx = stdout.lastIndexOf('{');
  if (idx === -1) return { raw: stdout };
  try { return JSON.parse(stdout.slice(idx)); }
  catch { return { raw: stdout }; }
}

function textResponse(data: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      { type: 'text' as const, text: `Error: ${message}` },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'xrpl-tollbooth',
  version: '0.1.0',
});

// wallet_risk — x402 paid
server.registerTool(
  'wallet_risk',
  {
    description:
      'Score a wallet address for OFAC sanctions and curated scam-list '
      + 'membership using the XRPL Toll Booth API. Costs 5000 drops XRP '
      + '(~$0.0005) per call, settled on XRPL mainnet via x402. Chains: '
      + 'eth, xrpl, sol. Returns risk_level, score, reason_codes[], '
      + 'sources_checked[]. Reason codes: OFAC_SANCTIONED, SCAM_LIST_HIT, '
      + "UNKNOWN_ADDRESS. Refuse to proceed if risk_level is 'critical'.",
    inputSchema: {
      chain: z.enum(['eth', 'xrpl', 'sol']).describe('Chain identifier'),
      address: z.string().describe('Wallet address to score'),
    },
  },
  async ({ chain, address }) => {
    try { return textResponse(callX402('/wallet-risk', { chain, address })); }
    catch (err) { return errorResponse(err); }
  },
);

// contract_risk — x402 paid
server.registerTool(
  'contract_risk',
  {
    description:
      'Score a smart-contract address for known-exploit database matches '
      + 'and source-code heuristics. Chain eth only. Costs 5000 drops XRP '
      + 'per call via x402. Reason codes: KNOWN_EXPLOIT_MATCH (refuse), '
      + 'SELFDESTRUCT_PRESENT, DELEGATECALL_PRESENT, PROXY_UPGRADEABLE, '
      + 'SOURCE_UNVERIFIED (warn).',
    inputSchema: {
      chain: z.literal('eth'),
      address: z.string().describe('Contract address to score'),
    },
  },
  async ({ chain, address }) => {
    try { return textResponse(callX402('/contract-risk', { chain, address })); }
    catch (err) { return errorResponse(err); }
  },
);

// tx_simulate_risk — x402 paid
server.registerTool(
  'tx_simulate_risk',
  {
    description:
      'Simulate an Ethereum transaction on a mainnet fork and grade the '
      + 'outcome. Costs 5000 drops XRP per call via x402. Detects unlimited '
      + 'approvals, ownership transfer, proxy upgrade, selfdestruct, reverts, '
      + 'and multi-token outbound flows. Reason codes: SELFDESTRUCT_INVOKED, '
      + 'UNLIMITED_APPROVAL_GRANTED, OWNERSHIP_TRANSFERRED, PROXY_UPGRADED '
      + '(hard warn); TX_REVERTED, MULTIPLE_OUTBOUND_TOKEN_TRANSFERS (inform).',
    inputSchema: {
      chain: z.literal('eth'),
      from: z.string().describe('Sender address'),
      to: z.string().describe('Recipient / contract address'),
      data: z.string().default('').describe('Hex calldata (0x prefix optional)'),
      value: z.string().default('0').describe('Wei as decimal string'),
    },
  },
  async ({ chain, from, to, data, value }) => {
    try { return textResponse(callX402('/tx-simulate-risk', { chain, from, to, data, value })); }
    catch (err) { return errorResponse(err); }
  },
);

// scope_check — x402 paid
server.registerTool(
  'scope_check',
  {
    description:
      'Check whether an address is in scope of any active bug bounty '
      + 'program. Costs 5000 drops XRP per call via x402. Returns in_scope '
      + '(bool) and programs[] with platform, name, url, max_bounty. '
      + 'Absence of a match is not proof — the target may just not be tracked.',
    inputSchema: {
      address: z.string(),
      chain: z.enum(['eth', 'xrpl', 'sol']).default('eth'),
    },
  },
  async ({ address, chain }) => {
    try { return textResponse(callX402('/scope-check', { address, chain })); }
    catch (err) { return errorResponse(err); }
  },
);

// verify_poc — Bearer key
server.registerTool(
  'verify_poc',
  {
    description:
      'Grade a Foundry PoC (.t.sol) against an Ethereum mainnet fork. '
      + 'Closed beta — requires TOLLBOOTH_API_KEY. Rate limit 10/min. Runs '
      + 'forge test --fork-url --json in an ephemeral sandbox with ffi=false '
      + 'pinned. Single-file only, max 128 KB decoded. Returns verified '
      + '(bool), reason_codes[], actual, gas_used, logs[], traces_head, '
      + 'duration_ms.',
    inputSchema: {
      test_file_base64: z.string().describe('.t.sol source, base64 encoded'),
      expected_result: z.enum(['pass', 'revert']).default('pass'),
      fork_block: z.number().int().optional(),
    },
  },
  async ({ test_file_base64, expected_result, fork_block }) => {
    try {
      const body: Record<string, unknown> = {
        test_file: test_file_base64,
        expected_result,
      };
      if (fork_block !== undefined) body.fork_block = fork_block;
      return textResponse(await callBearer('/verify-poc', 'POST', body));
    } catch (err) { return errorResponse(err); }
  },
);

// auth_ping — Bearer key, free
server.registerTool(
  'auth_ping',
  {
    description:
      'Verify the tollbooth API key is working. No side effects, no charge. '
      + 'Returns { ok, key: { id, name, prefix }, rate_limit: { per_minute } }. '
      + 'Use this to sanity-check TOLLBOOTH_API_KEY before invoking verify_poc.',
    inputSchema: {},
  },
  async () => {
    try { return textResponse(await callBearer('/auth-ping', 'GET')); }
    catch (err) { return errorResponse(err); }
  },
);

// list_endpoints — free, no network round-trip against tollbooth itself
// Useful because the client can ask "what do you support?" without paying.
server.registerTool(
  'list_endpoints',
  {
    description:
      'List all tollbooth endpoints, their auth model, and per-call cost '
      + 'by fetching /.well-known/agent.json. No payment, no bearer needed.',
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${TOLLBOOTH_URL}/.well-known/agent.json`);
      if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
      const manifest = await res.json();
      return textResponse(manifest);
    } catch (err) { return errorResponse(err); }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`starting; TOLLBOOTH_URL=${TOLLBOOTH_URL}`);
  try {
    const res = await fetch(`${TOLLBOOTH_URL}/.well-known/agent.json`);
    if (res.ok) {
      const m = await res.json() as { display_name?: string; version?: string; endpoints?: unknown[] };
      log(`connected to ${m.display_name} v${m.version} (${m.endpoints?.length ?? 0} endpoints)`);
    } else {
      log(`manifest fetch returned ${res.status} — tools will surface errors on first call`);
    }
  } catch (err) {
    log(`manifest warm failed: ${(err as Error).message}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP stdio transport connected; awaiting Cursor');
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

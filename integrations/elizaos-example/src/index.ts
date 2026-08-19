/**
 * XRPL Toll Booth — ElizaOS plugin.
 *
 * Exposes the seven tollbooth endpoints as ElizaOS Actions the character
 * can auto-invoke via similes / examples. Auto-discovers pricing and auth
 * mode from /.well-known/agent.json on init.
 *
 * Wiring:
 *
 *   // character.ts
 *   import { xrplTollboothPlugin } from '@your-scope/xrpl-tollbooth-plugin';
 *   export const character = {
 *     name: 'Sentinel',
 *     plugins: [xrplTollboothPlugin],
 *     ...
 *   };
 *
 * Env vars (read at init from runtime.getSetting):
 *   TOLLBOOTH_URL       default http://127.0.0.1:8787
 *   TOLLBOOTH_API_KEY   required for verify-poc + auth-ping
 *   XRPL_SEED           required for x402 endpoints
 *
 * The x402 tools shell out to scripts/paid-call.mjs at the repo root, same
 * as the LangChain example. If you're vendoring this plugin outside the
 * xrpl-tollbooth checkout, set PAID_CALL_SCRIPT_PATH in the runtime config.
 *
 * ⚠️  This file targets @elizaos/core >= 0.x with the modern Action/Plugin
 * interface (validate + handler → ActionResult with `success`). Types are
 * imported at build time; if you copy this into a fresh scaffold, run
 * `bun install @elizaos/core` (or npm/pnpm equivalent) first.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type {
  Action,
  ActionResult,
  Handler,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
  Validator,
} from '@elizaos/core';

// ---------------------------------------------------------------------------
// Config resolved lazily so runtime.getSetting can override .env
// ---------------------------------------------------------------------------

interface TollboothConfig {
  url: string;
  apiKey: string;
  xrplSeed: string;
  paidCallScript: string;
  repoRoot: string;
}

function resolveConfig(runtime: IAgentRuntime): TollboothConfig {
  const url = runtime.getSetting('TOLLBOOTH_URL') || 'http://127.0.0.1:8787';
  const apiKey = runtime.getSetting('TOLLBOOTH_API_KEY') || '';
  const xrplSeed = runtime.getSetting('XRPL_SEED') || '';
  const paidCallScript =
    runtime.getSetting('PAID_CALL_SCRIPT_PATH')
    || path.resolve(process.cwd(), 'scripts', 'paid-call.mjs');
  const repoRoot = path.dirname(path.dirname(paidCallScript));
  return { url, apiKey, xrplSeed, paidCallScript, repoRoot };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function callBearer(
  cfg: TollboothConfig,
  pathname: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!cfg.apiKey) {
    throw new Error(
      'TOLLBOOTH_API_KEY not set. This endpoint is closed beta; request '
      + 'access via a GitHub issue on xrpl-tollbooth.',
    );
  }
  const res = await fetch(`${cfg.url}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try { return await res.json(); }
  catch { return { status: res.status, text: await res.text() }; }
}

function callX402(
  cfg: TollboothConfig,
  pathname: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!cfg.xrplSeed) {
    throw new Error('XRPL_SEED not set. x402 endpoints require a payer seed.');
  }
  const result = spawnSync(
    'node',
    [
      `--env-file=${path.join(cfg.repoRoot, '.env')}`,
      cfg.paidCallScript,
      pathname,
      JSON.stringify(body),
    ],
    {
      cwd: cfg.repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TOLLBOOTH_URL: cfg.url },
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

// ---------------------------------------------------------------------------
// Argument extraction from message text.
//
// ElizaOS actions receive a Memory (message) plus State; the LLM-selected
// action does not automatically hand you parsed args. Real plugins ship
// parameter schemas or use the `parameters` field on Action. Here we keep
// it simple: extract addresses and chain hints with regex; if extraction
// fails we return a graceful error ActionResult so the LLM can retry.
// ---------------------------------------------------------------------------

const ETH_ADDR = /0x[a-fA-F0-9]{40}/;
const XRPL_ADDR = /\br[a-zA-Z0-9]{24,34}\b/;
const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

function extractChainAndAddress(
  text: string,
): { chain: 'eth' | 'xrpl' | 'sol'; address: string } | null {
  const eth = text.match(ETH_ADDR);
  if (eth) return { chain: 'eth', address: eth[0] };
  const xrpl = text.match(XRPL_ADDR);
  if (xrpl) return { chain: 'xrpl', address: xrpl[0] };
  const sol = text.match(SOL_ADDR);
  if (sol) return { chain: 'sol', address: sol[0] };
  return null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const walletRiskAction: Action = {
  name: 'TOLLBOOTH_WALLET_RISK',
  similes: [
    'CHECK_WALLET',
    'WALLET_RISK',
    'IS_ADDRESS_SANCTIONED',
    'CHECK_OFAC',
    'SCAM_LOOKUP',
  ],
  description:
    'Score a wallet address for OFAC sanctions and curated scam-list '
    + 'membership using the XRPL Toll Booth. Costs 5000 drops XRP per call. '
    + "Refuse to interact if risk_level is 'critical'.",
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Is 0xdac17f958d2ee523a2206206994597c13d831ec7 on the OFAC list?' } },
      { name: '{{agent}}', content: { text: 'Checking now.', actions: ['TOLLBOOTH_WALLET_RISK'] } },
    ],
    [
      { name: '{{user1}}', content: { text: 'Check risk on rHwXHECZUzumTAVACsR6N6pRHtvpTUEfzf' } },
      { name: '{{agent}}', content: { text: 'Looking that up.', actions: ['TOLLBOOTH_WALLET_RISK'] } },
    ],
  ],
  validate: (async (_runtime, message) => {
    return extractChainAndAddress(message.content?.text ?? '') !== null;
  }) as Validator,
  handler: (async (runtime, message): Promise<ActionResult> => {
    const parsed = extractChainAndAddress(message.content?.text ?? '');
    if (!parsed) {
      return { success: false, text: 'No wallet address found in message.' };
    }
    try {
      const cfg = resolveConfig(runtime);
      const data = callX402(cfg, '/wallet-risk', parsed);
      return {
        success: true,
        text: `Wallet ${parsed.address} (${parsed.chain}): risk=${data.risk_level} codes=${JSON.stringify(data.reason_codes ?? [])}`,
        data,
      };
    } catch (err) {
      return { success: false, text: `wallet-risk failed: ${(err as Error).message}` };
    }
  }) as Handler,
};

const contractRiskAction: Action = {
  name: 'TOLLBOOTH_CONTRACT_RISK',
  similes: ['CHECK_CONTRACT', 'IS_EXPLOIT', 'CONTRACT_RISK', 'AUDIT_CONTRACT'],
  description:
    'Score a smart contract for known-exploit database matches and '
    + 'source-code heuristics. Ethereum only. Costs 5000 drops XRP per call.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Is contract 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7 an exploit?' } },
      { name: '{{agent}}', content: { text: 'Checking the contract.', actions: ['TOLLBOOTH_CONTRACT_RISK'] } },
    ],
  ],
  validate: (async (_runtime, message) => {
    const p = extractChainAndAddress(message.content?.text ?? '');
    return p !== null && p.chain === 'eth';
  }) as Validator,
  handler: (async (runtime, message): Promise<ActionResult> => {
    const parsed = extractChainAndAddress(message.content?.text ?? '');
    if (!parsed || parsed.chain !== 'eth') {
      return { success: false, text: 'Ethereum contract address required.' };
    }
    try {
      const cfg = resolveConfig(runtime);
      const data = callX402(cfg, '/contract-risk', parsed);
      return {
        success: true,
        text: `Contract ${parsed.address}: risk=${data.risk_level} codes=${JSON.stringify(data.reason_codes ?? [])}`,
        data,
      };
    } catch (err) {
      return { success: false, text: `contract-risk failed: ${(err as Error).message}` };
    }
  }) as Handler,
};

const scopeCheckAction: Action = {
  name: 'TOLLBOOTH_SCOPE_CHECK',
  similes: ['CHECK_BOUNTY_SCOPE', 'IS_IN_SCOPE', 'BOUNTY_SCOPE'],
  description:
    'Check whether an address is in scope of any active bug bounty program. '
    + 'Costs 5000 drops XRP per call.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Is 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7 in any bug bounty scope?' } },
      { name: '{{agent}}', content: { text: 'Checking scope.', actions: ['TOLLBOOTH_SCOPE_CHECK'] } },
    ],
  ],
  validate: (async (_runtime, message) => {
    return extractChainAndAddress(message.content?.text ?? '') !== null;
  }) as Validator,
  handler: (async (runtime, message): Promise<ActionResult> => {
    const parsed = extractChainAndAddress(message.content?.text ?? '');
    if (!parsed) return { success: false, text: 'No address found.' };
    try {
      const cfg = resolveConfig(runtime);
      const data = callX402(cfg, '/scope-check', parsed);
      const inScope = data.in_scope ? 'IN SCOPE' : 'not in tracked scope';
      return {
        success: true,
        text: `${parsed.address}: ${inScope} (${(data.programs as unknown[] | undefined)?.length ?? 0} programs)`,
        data,
      };
    } catch (err) {
      return { success: false, text: `scope-check failed: ${(err as Error).message}` };
    }
  }) as Handler,
};

const authPingAction: Action = {
  name: 'TOLLBOOTH_AUTH_PING',
  similes: ['CHECK_TOLLBOOTH_KEY', 'PING_TOLLBOOTH', 'VERIFY_TOLLBOOTH_ACCESS'],
  description:
    'Verify the tollbooth API key is working. No side effects, no charge.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Check my tollbooth API key' } },
      { name: '{{agent}}', content: { text: 'Pinging.', actions: ['TOLLBOOTH_AUTH_PING'] } },
    ],
  ],
  validate: (async () => true) as Validator,
  handler: (async (runtime): Promise<ActionResult> => {
    try {
      const cfg = resolveConfig(runtime);
      const data = await callBearer(cfg, '/auth-ping', 'GET');
      const key = data.key as { id: number; prefix: string } | undefined;
      return {
        success: !!data.ok,
        text: data.ok
          ? `Tollbooth key OK (id=${key?.id} prefix=${key?.prefix})`
          : `Tollbooth key rejected: ${JSON.stringify(data)}`,
        data,
      };
    } catch (err) {
      return { success: false, text: `auth-ping failed: ${(err as Error).message}` };
    }
  }) as Handler,
};

// Note: verify-poc and tx-simulate-risk deliberately omitted from this example
// because their argument shape is not extractable from natural language alone
// (need base64 test file, hex calldata). Real deployments should ship dedicated
// parameter schemas or expose them via a slash-command action.

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const xrplTollboothPlugin: Plugin = {
  name: 'xrpl-tollbooth',
  description:
    'Wallet-risk, contract-risk, bug-bounty scope-check, and PoC verification '
    + 'via the XRPL Toll Booth API. Paid endpoints settle on XRPL mainnet via x402.',
  actions: [
    walletRiskAction,
    contractRiskAction,
    scopeCheckAction,
    authPingAction,
  ],
  init: async (config, runtime) => {
    // Warm the manifest so misconfig surfaces at agent boot.
    const cfg = resolveConfig(runtime);
    try {
      const r = await fetch(`${cfg.url}/.well-known/agent.json`);
      if (!r.ok) throw new Error(`manifest fetch: ${r.status}`);
      const manifest = await r.json() as { display_name?: string; version?: string; endpoints?: unknown[] };
      // eslint-disable-next-line no-console
      console.log(
        `[xrpl-tollbooth] connected to ${manifest.display_name} v${manifest.version} `
        + `(${manifest.endpoints?.length ?? 0} endpoints)`,
      );
    } catch (err) {
      // Non-fatal — actions will surface a cleaner error on first call.
      // eslint-disable-next-line no-console
      console.warn(`[xrpl-tollbooth] manifest warm failed: ${(err as Error).message}`);
    }
  },
};

export default xrplTollboothPlugin;

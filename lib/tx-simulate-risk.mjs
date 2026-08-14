// Phase 5 — /tx-simulate-risk
// Fork Ethereum mainnet with anvil, replay a proposed transaction, and return
// a risk analysis based on the resulting state changes, gas usage, and trace.
//
// v1 scope: Ethereum mainnet only. Per-request ephemeral anvil fork (spawned
// fresh, torn down at the end of each call).
//
// Inputs (POST body):
//   { chain: "eth", from: "0x...", to: "0x...", data: "0x...", value?: "0" }
//
// Outputs:
//   { chain, from, to, success, reverted, gas_used, risk_level, score,
//     reason_codes[], state_changes{}, traces_summary, fork_block,
//     metadata, checked_at, sources_checked[], notes[] }

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Public RPC fallback list. First responsive one wins.
// Env override: SIM_RPC_ETH_MAINNET (single URL, overrides list).
const DEFAULT_RPCS_ETH = [
  'https://ethereum.publicnode.com',
  'https://eth.merkle.io',
  'https://rpc.ankr.com/eth',
];

// Anvil binary. Env override: ANVIL_BIN.
const ANVIL_BIN = process.env.ANVIL_BIN || 'anvil';
const CAST_BIN = process.env.CAST_BIN || 'cast';

// Per-request anvil port range. We pick a random ephemeral port to avoid
// collisions when concurrent /tx-simulate-risk calls run.
const ANVIL_PORT_MIN = 18545;
const ANVIL_PORT_MAX = 19545;

// Anvil warmup polling.
const ANVIL_READY_TIMEOUT_MS = 30_000;
const ANVIL_READY_POLL_MS = 500;

// Total budget for a single simulation call (fork + replay + teardown).
const SIM_TOTAL_BUDGET_MS = 60_000;

// Known token transfer / approval event signatures.
// keccak256("Transfer(address,address,uint256)")
const SIG_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256("Approval(address,address,uint256)")
const SIG_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
// keccak256("OwnershipTransferred(address,address)")
const SIG_OWNERSHIP = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
// keccak256("Upgraded(address)")
const SIG_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAddr(addr) {
  if (typeof addr !== 'string') return null;
  const s = addr.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null;
  return s;
}

function normalizeHex(v) {
  if (v === undefined || v === null || v === '') return '0x';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^0x[a-f0-9]*$/i.test(s)) return null;
  return s.toLowerCase();
}

function normalizeValue(v) {
  // Accept decimal string, hex string, or number. Return decimal string (wei).
  if (v === undefined || v === null || v === '') return '0';
  if (typeof v === 'number') return String(BigInt(Math.trunc(v)));
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return String(BigInt(s));
    if (/^\d+$/.test(s)) return s;
  }
  return null;
}

function pickPort() {
  return ANVIL_PORT_MIN + Math.floor(Math.random() * (ANVIL_PORT_MAX - ANVIL_PORT_MIN));
}

async function rpcCall(url, method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('rpc_http_' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('rpc_error:' + (j.error.message || 'unknown'));
  return j.result;
}

// Try upstream RPCs in order, return the first that answers with a block number.
async function pickUpstreamRpc() {
  const override = process.env.SIM_RPC_ETH_MAINNET;
  const list = override ? [override] : DEFAULT_RPCS_ETH;
  for (const url of list) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      if (j && typeof j.result === 'string' && j.result.startsWith('0x')) {
        return url;
      }
    } catch {
      // try next
    }
  }
  return null;
}

// Extract right 20 bytes as 0x-prefixed lowercase address (or null).
function topicToAddress(topic) {
  if (!topic || typeof topic !== 'string') return null;
  const s = topic.toLowerCase().replace(/^0x/, '');
  if (s.length < 40) return null;
  const addr = '0x' + s.slice(-40);
  if (/^0x0+$/.test(addr)) return null;
  return addr;
}

// Parse hex uint256 amount to decimal string. Safe for values up to 2^256-1.
function hexToDecString(hex) {
  if (!hex || typeof hex !== 'string') return '0';
  try {
    return BigInt(hex).toString(10);
  } catch {
    return '0';
  }
}

function b64rand() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Anvil lifecycle
// ---------------------------------------------------------------------------

async function waitForAnvilReady(port, deadline) {
  const url = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    try {
      const bn = await rpcCall(url, 'eth_blockNumber', []);
      if (typeof bn === 'string' && bn.startsWith('0x')) return url;
    } catch {
      // not ready yet
    }
    await sleep(ANVIL_READY_POLL_MS);
  }
  throw new Error('anvil_not_ready_within_' + ANVIL_READY_TIMEOUT_MS + 'ms');
}

// Start an ephemeral anvil forking the given upstream RPC.
// Returns { url, proc, port } — caller must call stop() when done.
async function startEphemeralAnvil(upstreamRpcUrl, forkBlock) {
  const port = pickPort();
  const args = [
    '--fork-url', upstreamRpcUrl,
    '--port', String(port),
    '--host', '127.0.0.1',
    '--silent',
    '--no-mining', // we mine manually per tx
  ];
  if (forkBlock && Number.isInteger(forkBlock) && forkBlock > 0) {
    args.push('--fork-block-number', String(forkBlock));
  }

  const proc = spawn(ANVIL_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Buffer stderr for post-mortem if things go wrong.
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
  });

  // If anvil dies during startup, surface it.
  let procExited = false;
  let procExitCode = null;
  proc.on('exit', (code) => {
    procExited = true;
    procExitCode = code;
  });

  const deadline = Date.now() + ANVIL_READY_TIMEOUT_MS;
  try {
    const url = await waitForAnvilReady(port, deadline);
    return {
      url,
      proc,
      port,
      stop: () => stopAnvil(proc),
      getStderr: () => stderrBuf,
    };
  } catch (e) {
    stopAnvil(proc);
    if (procExited) {
      throw new Error('anvil_exited_early code=' + procExitCode + ' stderr=' + stderrBuf.slice(0, 400));
    }
    throw e;
  }
}

function stopAnvil(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

// Impersonate an arbitrary sender and send the tx via the fork.
// Returns { txHash, receipt, forkBlock, senderEthBefore, senderEthAfter, targetEthBefore, targetEthAfter }.
async function replayTransaction(forkUrl, from, to, data, value) {
  // Snapshot fork block for the response.
  const forkBlockHex = await rpcCall(forkUrl, 'eth_blockNumber', []);
  const forkBlock = parseInt(forkBlockHex, 16);

  // Fund the sender with a large ETH balance so gas + value are always covered.
  // 0x21e19e0c9bab2400000 = 10,000 ETH.
  await rpcCall(forkUrl, 'anvil_setBalance', [from, '0x21e19e0c9bab2400000']);

  // Impersonate the sender so we can send from an arbitrary address.
  await rpcCall(forkUrl, 'anvil_impersonateAccount', [from]);

  // Pre-tx balances.
  const senderEthBefore = await rpcCall(forkUrl, 'eth_getBalance', [from, 'latest']);
  const targetEthBefore = to ? await rpcCall(forkUrl, 'eth_getBalance', [to, 'latest']) : '0x0';

  // Convert value to hex (wei).
  const valueDec = value || '0';
  const valueHex = '0x' + BigInt(valueDec).toString(16);

  const txReq = {
    from,
    to: to || undefined,
    data: data || '0x',
    value: valueHex,
    // Let anvil auto-fill gas / gasPrice. If auto-gas fails we retry with an
    // explicit high gas budget below.
  };

  let txHash;
  try {
    txHash = await rpcCall(forkUrl, 'eth_sendTransaction', [txReq]);
  } catch (e) {
    // Retry with explicit high gas — some contracts trip gas estimation.
    txReq.gas = '0x1c9c380'; // 30M
    txHash = await rpcCall(forkUrl, 'eth_sendTransaction', [txReq]);
  }

  // Mine the tx.
  await rpcCall(forkUrl, 'evm_mine', []);

  // Fetch receipt.
  const receipt = await rpcCall(forkUrl, 'eth_getTransactionReceipt', [txHash]);

  // Post-tx balances.
  const senderEthAfter = await rpcCall(forkUrl, 'eth_getBalance', [from, 'latest']);
  const targetEthAfter = to ? await rpcCall(forkUrl, 'eth_getBalance', [to, 'latest']) : '0x0';

  // Stop impersonating (housekeeping — fork will be torn down anyway).
  try {
    await rpcCall(forkUrl, 'anvil_stopImpersonatingAccount', [from]);
  } catch {
    // ignore
  }

  return { txHash, receipt, forkBlock, senderEthBefore, senderEthAfter, targetEthBefore, targetEthAfter };
}

// Run `cast run` on the mined tx hash to get a decoded trace tree.
// Returns { traces_text, internal_calls_count, delegatecalls_count, has_selfdestruct }.
function summarizeTrace(traceText) {
  const out = {
    traces_text_head: (traceText || '').slice(0, 1500),
    internal_calls_count: 0,
    delegatecalls_count: 0,
    staticcalls_count: 0,
    has_selfdestruct: false,
    has_create: false,
  };
  if (!traceText) return out;
  // Count each pattern. cast run traces use "[CALL]" / "[DELEGATECALL]" etc. or the shorthand form.
  const lower = traceText.toLowerCase();
  out.internal_calls_count = (traceText.match(/\[\d+\]/g) || []).length; // gas-bracketed frames = calls
  out.delegatecalls_count = (lower.match(/\[delegatecall\]/g) || []).length;
  out.staticcalls_count = (lower.match(/\[staticcall\]/g) || []).length;
  out.has_selfdestruct = /selfdestruct|suicide/i.test(traceText);
  out.has_create = /\[create[12]?\]/i.test(traceText);
  return out;
}

function runCastRun(forkUrl, txHash) {
  return new Promise((resolve) => {
    const proc = spawn(CAST_BIN, ['run', '--rpc-url', forkUrl, '--quick', txHash], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, stdout, stderr, timeout: true });
    }, 15_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, stdout, stderr, timeout: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Log parsing (state changes)
// ---------------------------------------------------------------------------

function parseStateChanges(receipt, from, to, senderEthBefore, senderEthAfter, targetEthBefore, targetEthAfter) {
  const changes = {
    eth_balance_deltas: {},
    token_transfers: [],
    approvals_granted: [],
    ownership_changes: [],
    upgrades: [],
  };

  // ETH deltas (net; signed decimal strings in wei).
  const fromDelta = BigInt(senderEthAfter) - BigInt(senderEthBefore);
  if (fromDelta !== 0n) {
    changes.eth_balance_deltas[from] = fromDelta.toString(10);
  }
  if (to && to !== from) {
    const toDelta = BigInt(targetEthAfter) - BigInt(targetEthBefore);
    if (toDelta !== 0n) {
      changes.eth_balance_deltas[to] = toDelta.toString(10);
    }
  }

  const logs = Array.isArray(receipt && receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (!topics.length) continue;
    const sig = topics[0].toLowerCase();

    if (sig === SIG_TRANSFER && topics.length >= 3) {
      const fromA = topicToAddress(topics[1]);
      const toA = topicToAddress(topics[2]);
      const amount = topics.length >= 4
        ? hexToDecString(topics[3]) // ERC-721 tokenId in indexed slot
        : hexToDecString(log.data);
      changes.token_transfers.push({
        token: log.address.toLowerCase(),
        from: fromA,
        to: toA,
        amount_or_tokenid: amount,
        indexed_amount: topics.length >= 4, // true means ERC-721 style
      });
    } else if (sig === SIG_APPROVAL && topics.length >= 3) {
      const owner = topicToAddress(topics[1]);
      const spender = topicToAddress(topics[2]);
      const amount = hexToDecString(log.data);
      changes.approvals_granted.push({
        token: log.address.toLowerCase(),
        owner,
        spender,
        amount,
        is_unlimited: amount === '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      });
    } else if (sig === SIG_OWNERSHIP && topics.length >= 3) {
      changes.ownership_changes.push({
        contract: log.address.toLowerCase(),
        previous_owner: topicToAddress(topics[1]),
        new_owner: topicToAddress(topics[2]),
      });
    } else if (sig === SIG_UPGRADED && topics.length >= 2) {
      changes.upgrades.push({
        contract: log.address.toLowerCase(),
        new_implementation: topicToAddress(topics[1]),
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

function riskLevel(score) {
  if (score >= 80) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

function severityScore(sev) {
  if (sev === 'critical') return 100;
  if (sev === 'high') return 40;
  if (sev === 'medium') return 20;
  return 5;
}

function scoreRisk({ reverted, stateChanges, traceSummary, from }) {
  const reasons = [];

  if (reverted) {
    reasons.push({
      code: 'TX_REVERTED',
      severity: 'low',
      source: 'simulation',
      evidence: 'transaction_reverted_on_fork',
    });
    return reasons;
  }

  // Unlimited approvals granted BY the sender to some spender = high risk.
  for (const a of stateChanges.approvals_granted) {
    if (a.owner === from && a.is_unlimited) {
      reasons.push({
        code: 'UNLIMITED_APPROVAL_GRANTED',
        severity: 'high',
        source: 'simulation',
        evidence: 'token=' + a.token + ' spender=' + a.spender + ' amount=MAX',
      });
    } else if (a.owner === from && BigInt(a.amount || '0') > 0n) {
      reasons.push({
        code: 'TOKEN_APPROVAL_GRANTED',
        severity: 'medium',
        source: 'simulation',
        evidence: 'token=' + a.token + ' spender=' + a.spender + ' amount=' + a.amount,
      });
    }
  }

  // Ownership changes.
  for (const o of stateChanges.ownership_changes) {
    reasons.push({
      code: 'OWNERSHIP_TRANSFERRED',
      severity: 'high',
      source: 'simulation',
      evidence: 'contract=' + o.contract + ' new_owner=' + o.new_owner,
    });
  }

  // Proxy upgrade.
  for (const u of stateChanges.upgrades) {
    reasons.push({
      code: 'PROXY_UPGRADED',
      severity: 'critical',
      source: 'simulation',
      evidence: 'contract=' + u.contract + ' new_impl=' + u.new_implementation,
    });
  }

  // Selfdestruct during trace.
  if (traceSummary.has_selfdestruct) {
    reasons.push({
      code: 'SELFDESTRUCT_INVOKED',
      severity: 'critical',
      source: 'simulation',
      evidence: 'selfdestruct_opcode_in_trace',
    });
  }

  // ETH movement from sender that they may not have expected.
  // We already funded them with 10k ETH so the balance-delta minus msg.value should be near-zero
  // unless the callee siphoned ETH.
  // v0 heuristic: flag if sender sent tokens to a non-target address as a side effect.
  const suspiciousTokenSweeps = stateChanges.token_transfers.filter(t => t.from === from);
  if (suspiciousTokenSweeps.length > 3) {
    reasons.push({
      code: 'MULTIPLE_OUTBOUND_TOKEN_TRANSFERS',
      severity: 'medium',
      source: 'simulation',
      evidence: 'sender_sent_' + suspiciousTokenSweeps.length + '_token_transfers',
    });
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function simulateTransaction(input) {
  const start = Date.now();
  const chain = (input.chain || 'eth').toLowerCase();
  const notes = [];
  const sources = ['anvil_fork', 'cast_run'];

  if (chain !== 'eth' && chain !== 'ethereum' && chain !== 'mainnet') {
    return {
      error: 'unsupported_chain',
      message: 'v1 supports chain="eth" only (ethereum mainnet). More chains coming in v2.',
    };
  }

  const from = normalizeAddr(input.from);
  const to = input.to === null || input.to === undefined || input.to === ''
    ? null // contract creation
    : normalizeAddr(input.to);
  const data = normalizeHex(input.data);
  const value = normalizeValue(input.value);

  if (!from) return { error: 'invalid_from', message: 'from must be 0x-prefixed 40-hex address' };
  if (to === null && (!data || data === '0x')) {
    return { error: 'invalid_input', message: 'contract-creation tx (to=null) requires non-empty data' };
  }
  if (input.to !== undefined && input.to !== null && input.to !== '' && !to) {
    return { error: 'invalid_to', message: 'to must be 0x-prefixed 40-hex address or omitted for contract creation' };
  }
  if (data === null) return { error: 'invalid_data', message: 'data must be 0x-prefixed hex string' };
  if (value === null) return { error: 'invalid_value', message: 'value must be non-negative integer wei (decimal or hex string)' };

  const upstream = await pickUpstreamRpc();
  if (!upstream) {
    return { error: 'no_upstream_rpc', message: 'all upstream RPCs unreachable — try again shortly' };
  }
  notes.push('upstream_rpc=' + upstream);

  const forkBlockOverride = input.block === 'latest' || input.block === undefined || input.block === null
    ? null
    : (Number.isInteger(input.block) && input.block > 0 ? input.block : null);

  let anvil = null;
  try {
    anvil = await startEphemeralAnvil(upstream, forkBlockOverride);
  } catch (e) {
    return {
      error: 'anvil_start_failed',
      message: e.message,
      upstream_rpc: upstream,
    };
  }

  let result;
  try {
    // Enforce total-budget deadline.
    const budgetLeft = SIM_TOTAL_BUDGET_MS - (Date.now() - start);
    if (budgetLeft <= 5_000) {
      throw new Error('budget_exhausted_before_replay');
    }

    const replay = await replayTransaction(anvil.url, from, to, data, value);
    const success = replay.receipt && replay.receipt.status === '0x1';
    const reverted = !success;
    const gasUsed = replay.receipt ? parseInt(replay.receipt.gasUsed, 16) : null;

    // Trace via cast run (best-effort; if it fails we still return simulation result).
    let traceSummary = { traces_text_head: '', internal_calls_count: 0, delegatecalls_count: 0, staticcalls_count: 0, has_selfdestruct: false, has_create: false };
    try {
      const trace = await runCastRun(anvil.url, replay.txHash);
      if (trace.ok) {
        traceSummary = summarizeTrace(trace.stdout);
      } else {
        notes.push('cast_run_failed:' + (trace.timeout ? 'timeout' : ('code=' + trace.code)));
      }
    } catch (e) {
      notes.push('cast_run_exception:' + e.message);
    }

    const stateChanges = parseStateChanges(
      replay.receipt,
      from,
      to,
      replay.senderEthBefore,
      replay.senderEthAfter,
      replay.targetEthBefore,
      replay.targetEthAfter,
    );

    const reasonCodes = scoreRisk({ reverted, stateChanges, traceSummary, from });
    const score = Math.min(100, reasonCodes.reduce((s, r) => s + severityScore(r.severity), 0));
    const level = riskLevel(score);

    result = {
      chain: 'eth',
      from: input.from,
      to: input.to === null || input.to === undefined || input.to === '' ? null : input.to,
      normalized_from: from,
      normalized_to: to,
      value_wei: value,
      success,
      reverted,
      gas_used: gasUsed,
      risk_level: level,
      score,
      reason_codes: reasonCodes,
      state_changes: stateChanges,
      traces_summary: traceSummary,
      fork_block: replay.forkBlock,
      metadata: {
        tx_hash_on_fork: replay.txHash,
        upstream_rpc: upstream,
        simulation_duration_ms: Date.now() - start,
      },
      checked_at: new Date().toISOString(),
      sources_checked: sources,
      cache_ttl_seconds: 0, // simulations are per-call, never cache
    };
    if (notes.length) result.notes = notes;
  } catch (e) {
    result = {
      error: 'simulation_failed',
      message: e.message,
      chain: 'eth',
      from: input.from,
      to: input.to,
      upstream_rpc: upstream,
      duration_ms: Date.now() - start,
    };
    if (notes.length) result.notes = notes;
  } finally {
    if (anvil) anvil.stop();
  }

  return result;
}

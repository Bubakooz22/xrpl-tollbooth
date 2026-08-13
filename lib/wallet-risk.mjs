import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

function loadJsonSet(fname, extract = (x) => x) {
  const p = join(DATA_DIR, fname);
  if (!existsSync(p)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : [];
    const s = new Set();
    for (const item of arr) {
      const v = extract(item);
      if (v) s.add(v);
    }
    return s;
  } catch (e) {
    console.error('[wallet-risk] failed to load', fname, e.message);
    return new Set();
  }
}

const ofacEth = loadJsonSet('ofac-eth.json', (v) => typeof v === 'string' ? v.toLowerCase() : null);
const ofacXrpl = loadJsonSet('ofac-xrpl.json', (v) => typeof v === 'string' ? v : null);
const ofacSol = loadJsonSet('ofac-sol.json', (v) => typeof v === 'string' ? v : null);
const scamEth = loadJsonSet('eth-scam-addresses.json', (e) => e && e.address ? e.address.toLowerCase() : null);

const TORNADO_CASH_POOLS = new Set([
  '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291',
]);

console.log('[wallet-risk] loaded OFAC eth=' + ofacEth.size + ' xrpl=' + ofacXrpl.size + ' sol=' + ofacSol.size + ' scam_eth=' + scamEth.size);

export function detectChain(addr) {
  if (typeof addr !== 'string') return null;
  const s = addr.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return 'eth';
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return 'xrpl';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return 'sol';
  return null;
}

export function normalize(chain, addr) {
  if (chain === 'eth' || chain === 'base') return addr.toLowerCase();
  return addr.trim();
}

// EVM on-chain heuristics.
// chain='eth': Etherscan V2 (chainid=1), needs ETHERSCAN_API_KEY. Full coverage.
// chain='base': public Base RPC (https://mainnet.base.org), keyless. v0 = nonce-only.
// Base coverage is intentionally reduced: NEW_ACCOUNT and MIXER_INTERACTION
// require a tx-history indexer we don't yet have on free tier for Base.
async function fetchEvmOnchain(addr, chain) {
  const codes = [];
  try {
    if (chain === 'eth') {
      const key = process.env.ETHERSCAN_API_KEY || '';
      if (!key) return { codes, note: 'no_etherscan_key' };
      const nonceUrl = 'https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionCount&address=' + addr + '&tag=latest&apikey=' + key;
      const r1 = await fetch(nonceUrl);
      const j1 = await r1.json();
      const nonce = parseInt(j1.result || '0x0', 16);
      if (Number.isFinite(nonce) && nonce < 5) {
        codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'nonce=' + nonce });
      }

      const txUrl = 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=' + addr + '&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=' + key;
      const r2 = await fetch(txUrl);
      const j2 = await r2.json();
      const txs = Array.isArray(j2.result) ? j2.result : [];
      if (txs.length) {
        const oldest = txs[txs.length - 1];
        const firstTs = parseInt(oldest.timeStamp, 10);
        const now = Math.floor(Date.now() / 1000);
        if (firstTs && (now - firstTs) < 7 * 86400) {
          codes.push({ code: 'NEW_ACCOUNT', severity: 'low', source: 'onchain', evidence: 'first_tx ' + Math.floor((now - firstTs) / 3600) + 'h ago' });
        }
      }
      const mixerHit = txs.find(t => TORNADO_CASH_POOLS.has((t.to || '').toLowerCase()) || TORNADO_CASH_POOLS.has((t.from || '').toLowerCase()));
      if (mixerHit) codes.push({ code: 'MIXER_INTERACTION', severity: 'medium', source: 'onchain', evidence: 'tornado_cash tx ' + mixerHit.hash });

      return { codes, note: null };
    }

    if (chain === 'base') {
      const r = await fetch('https://mainnet.base.org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [addr, 'latest'] })
      });
      const j = await r.json();
      if (j.error) return { codes, note: 'base_rpc_' + j.error.message };
      const nonce = parseInt(j.result || '0x0', 16);
      if (Number.isFinite(nonce) && nonce < 5) {
        codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'nonce=' + nonce });
      }
      return { codes, note: 'base_v0_nonce_only' };
    }

    return { codes, note: 'evm_unknown_chain:' + chain };
  } catch (e) {
    return { codes, note: 'onchain_fetch_failed:' + e.message };
  }
}

async function fetchXrplOnchain(addr) {
  const codes = [];
  try {
    const r = await fetch('https://s.altnet.rippletest.net:51234/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'account_info', params: [{ account: addr, ledger_index: 'validated' }] })
    });
    const j = await r.json();
    if (j.result && j.result.error === 'actNotFound') {
      codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'account_not_activated' });
      return { codes, note: null };
    }
    if (!j.result || j.result.status !== 'success') return { codes, note: 'xrpl_' + (j.result && j.result.status) };
    const seq = (j.result.account_data && j.result.account_data.Sequence) || 0;
    if (seq < 3) codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'sequence=' + seq });

    const r2 = await fetch('https://s.altnet.rippletest.net:51234/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'account_tx', params: [{ account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 1, forward: true }] })
    });
    const j2 = await r2.json();
    const firstTxWrap = j2.result && j2.result.transactions && j2.result.transactions[0];
    const firstTx = firstTxWrap && (firstTxWrap.tx || firstTxWrap.tx_json);
    if (firstTx && firstTx.date) {
      const xrplEpoch = 946684800;
      const ts = firstTx.date + xrplEpoch;
      const now = Math.floor(Date.now() / 1000);
      if ((now - ts) < 7 * 86400) codes.push({ code: 'NEW_ACCOUNT', severity: 'low', source: 'onchain', evidence: 'first_tx ' + Math.floor((now - ts) / 3600) + 'h ago' });
    }
    return { codes, note: null };
  } catch (e) {
    return { codes, note: 'xrpl_fetch_failed:' + e.message };
  }
}

async function fetchSolOnchain(addr) {
  const SYS_PROGRAM = '11111111111111111111111111111111';
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 5;
  const codes = [];
  try {
    const infoR = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [addr, { encoding: 'base64' }] })
    });
    const infoJ = await infoR.json();
    if (infoJ.error) return { codes, note: 'sol_info_' + infoJ.error.message };
    const accInfo = infoJ.result && infoJ.result.value;
    if (!accInfo) {
      codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'account_not_found_on_mainnet' });
      return { codes, note: null };
    }
    if (accInfo.owner && accInfo.owner !== SYS_PROGRAM) {
      codes.push({ code: 'PROGRAM_ACCOUNT', severity: 'low', source: 'onchain', evidence: 'owner_program=' + accInfo.owner });
    }
    let allSigs = [];
   let before = null;
    let pagesFetched = 0;
    for (
let page = 0; page < MAX_PAGES; page++) {
      const params = [addr, { limit: PAGE_SIZE }];
      if (before) params[1].before = before;
      const r = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params })
      });
      const j = await r.json();
      if (j.error) return { codes, note: 'sol_sigs_' + j.error.message };
      const sigs = Array.isArray(j.result) ? j.result : [];
      pagesFetched++;
      allSigs = allSigs.concat(sigs);
      if (sigs.length < PAGE_SIZE) break;
      before = sigs[sigs.length - 1].signature;
    }
    const sawFullHistory = pagesFetched < MAX_PAGES || (allSigs.length > 0 && allSigs.length % PAGE_SIZE !== 0);
    if (sawFullHistory && allSigs.length < 3) {
      codes.push({ code: 'LOW_ACTIVITY', severity: 'low', source: 'onchain', evidence: 'total_signatures=' + allSigs.length });
    }
    if (sawFullHistory && allSigs.length > 0) {
      const oldest = allSigs[allSigs.length - 1];
      if (oldest.blockTime) {
        const now = Math.floor(Date.now() / 1000);
        const ageSecs = now - oldest.blockTime;
        if (ageSecs < 7 * 86400) {
          codes.push({ code: 'NEW_ACCOUNT', severity: 'low', source: 'onchain', evidence: 'first_tx ' + Math.floor(ageSecs / 3600) + 'h ago' });
        }
      }
    }
    return { codes, note: null };
  } catch (e) {
    return { codes, note: 'sol_fetch_failed:' + e.message };
  }
}

const SEV = { low: 5, medium: 20, high: 40, critical: 100 };

export async function scoreWallet(rawAddr, chainOverride) {
  let chain = detectChain(rawAddr);
  // Base addresses are format-identical to ETH; only route to base when caller explicitly asks.
  if (chainOverride === 'base' && chain === 'eth') chain = 'base';
  if (!chain) return { error: 'invalid_address', address: rawAddr, message: 'address does not match eth/xrpl/sol format' };
  const norm = normalize(chain, rawAddr);
  const codes = [];
  const sources = [];
  const notes = [];

  if (chain === 'eth' || chain === 'base') {
    // Reuse ETH OFAC list for base (same L1 address space).
    sources.push(chain === 'base' ? 'ofac_sdn_base_via_eth' : 'ofac_sdn_eth');
    if (ofacEth.has(norm)) codes.push({ code: 'OFAC_SANCTIONED', severity: 'critical', source: 'us-treasury-sdn', evidence: 'OFAC SDN ETH list hit' });
  } else if (chain === 'xrpl') {
    sources.push('ofac_sdn_xrpl');
    if (ofacXrpl.has(norm)) codes.push({ code: 'OFAC_SANCTIONED', severity: 'critical', source: 'us-treasury-sdn', evidence: 'OFAC SDN XRPL list hit' });
  } else if (chain === 'sol') {
    sources.push('ofac_sdn_sol');
    if (ofacSol.has(norm)) codes.push({ code: 'OFAC_SANCTIONED', severity: 'critical', source: 'us-treasury-sdn', evidence: 'OFAC SDN Solana list hit' });
  }

  if (codes.find(c => c.code === 'OFAC_SANCTIONED')) {
    return {
      chain, address: rawAddr, normalized_address: norm,
      score: 100, risk_level: 'critical',
      reason_codes: codes,
      checked_at: new Date().toISOString(),
      sources_checked: sources,
      cache_ttl_seconds: 86400,
    };
  }

  if (chain === 'eth' || chain === 'base') {
    // MEW darklist is ETH-mainnet scoped; base addresses may collide but treat conservatively.
    sources.push(chain === 'base' ? 'scam_lists_base_via_eth' : 'scam_lists_eth');
    if (scamEth.has(norm)) codes.push({ code: 'SCAM_REPORTED', severity: 'high', source: 'mew-darklist', evidence: 'address on MEW public scam list' });
  }

  let oc;
  if (chain === 'eth') { sources.push('onchain_eth'); oc = await fetchEvmOnchain(norm, 'eth'); }
  else if (chain === 'base') { sources.push('onchain_base'); oc = await fetchEvmOnchain(norm, 'base'); }
  else if (chain === 'xrpl') { sources.push('onchain_xrpl'); oc = await fetchXrplOnchain(norm); }
  else { sources.push('onchain_sol'); oc = await fetchSolOnchain(norm); }
  codes.push(...oc.codes);
  if (oc.note) notes.push(oc.note);

  const score = Math.min(100, codes.reduce((s, c) => s + (SEV[c.severity] || 0), 0));
  const risk_level = score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';

  const out = {
    chain, address: rawAddr, normalized_address: norm,
    score, risk_level,
    reason_codes: codes,
    checked_at: new Date().toISOString(),
    sources_checked: sources,
    cache_ttl_seconds: 3600,
  };
  if (notes.length) out.notes = notes;
  return out;
}

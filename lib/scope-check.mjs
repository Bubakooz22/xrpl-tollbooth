// Phase 4 — /scope-check
// Given a contract address (or batch), return active bug-bounty programs
// covering that contract across Immunefi, HackenProof, Cantina, Sherlock.
//
// v0 data source: hand-curated static seed at data/bounty-scope.json.
// Refreshed nightly by a droplet cron job (Phase 4e).

import { readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SCOPE_FILE = join(DATA_DIR, 'bounty-scope.json');

// -------- Data loading --------

let scopeData = null;      // { $schema_version, generated_at, programs, skipped }
let addressIndex = null;   // Map<`${chain}:${lower_addr}`, Array<program_ref>>
let addressIndexAny = null;// Map<lower_addr, Array<program_ref>>  (chain-agnostic fallback)
let loadedAt = 0;
let loadedFileMtimeMs = 0;

function normalizeChainName(chain) {
  if (!chain || typeof chain !== 'string') return null;
  const c = chain.toLowerCase().trim();
  // Aliases users/agents commonly send.
  const aliases = {
    'ethereum': 'ethereum',
    'eth': 'ethereum',
    'mainnet': 'ethereum',
    'base': 'base',
    'arbitrum': 'arbitrum',
    'arb': 'arbitrum',
    'arbitrum-one': 'arbitrum',
    'optimism': 'optimism',
    'op': 'optimism',
    'polygon': 'polygon',
    'matic': 'polygon',
    'avalanche': 'avalanche',
    'avax': 'avalanche',
    'bnb': 'bnb',
    'bsc': 'bnb',
    'gnosis': 'gnosis',
    'fantom': 'fantom',
    'ftm': 'fantom',
    'scroll': 'scroll',
    'linea': 'linea',
    'zksync': 'zksync',
    'sonic': 'sonic',
    'blast': 'blast',
    'metis': 'metis',
    'celo': 'celo',
    'mantle': 'mantle',
    'sui': 'sui',
    'near': 'near',
    'cronos': 'cronos',
  };
  return aliases[c] || c;
}

function loadScopeData(force = false) {
  if (!existsSync(SCOPE_FILE)) {
    scopeData = { programs: [], skipped: [], $schema_version: '0.1', generated_at: null };
    addressIndex = new Map();
    addressIndexAny = new Map();
    return scopeData;
  }
  const mtime = statSync(SCOPE_FILE).mtimeMs;
  if (!force && scopeData && mtime === loadedFileMtimeMs) return scopeData;

  try {
    const raw = JSON.parse(readFileSync(SCOPE_FILE, 'utf8'));
    scopeData = raw;
    loadedFileMtimeMs = mtime;
    loadedAt = Date.now();
    rebuildIndex();
    console.log(
      '[scope-check] loaded scope=' + (raw.programs?.length || 0) +
      ' contracts=' + (addressIndex ? sumIndex(addressIndex) : 0) +
      ' generated_at=' + (raw.generated_at || 'null')
    );
  } catch (e) {
    console.error('[scope-check] failed to load bounty-scope.json:', e.message);
    scopeData = { programs: [], skipped: [], $schema_version: '0.1', generated_at: null };
    addressIndex = new Map();
    addressIndexAny = new Map();
  }
  return scopeData;
}

function sumIndex(idx) {
  let n = 0;
  for (const v of idx.values()) n += v.length;
  return n;
}

function rebuildIndex() {
  addressIndex = new Map();
  addressIndexAny = new Map();
  if (!scopeData?.programs) return;
  for (const p of scopeData.programs) {
    if (!Array.isArray(p.contracts)) continue;
    const programRef = {
      platform: p.platform,
      project: p.project,
      display_name: p.display_name || p.project,
      url: p.url,
      max_payout_usd: typeof p.max_payout_usd === 'number' ? p.max_payout_usd : null,
      asset_type: p.asset_type || 'smart_contract',
      chains: Array.isArray(p.chains) ? p.chains : [],
      kyc_required: !!p.kyc_required,
      notes: p.notes || null,
    };
    for (const c of p.contracts) {
      if (!c?.address || typeof c.address !== 'string') continue;
      const addr = c.address.toLowerCase();
      const chain = normalizeChainName(c.chain) || 'unknown';
      const key = `${chain}:${addr}`;
      const entry = { ...programRef, matched_contract_name: c.name || null, matched_chain: chain };
      if (!addressIndex.has(key)) addressIndex.set(key, []);
      addressIndex.get(key).push(entry);
      if (!addressIndexAny.has(addr)) addressIndexAny.set(addr, []);
      addressIndexAny.get(addr).push(entry);
    }
  }
}

// -------- Lookup --------

function isEthAddressLike(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// Non-EVM addresses (Sui object IDs, NEAR account IDs, Solana pubkeys) are pass-through:
// we only *normalize* if it looks like an EVM address; otherwise use as-is (lowercase).
function normalizeAddress(addr) {
  if (typeof addr !== 'string') return null;
  const trimmed = addr.trim();
  if (!trimmed) return null;
  if (isEthAddressLike(trimmed)) return trimmed.toLowerCase();
  return trimmed.toLowerCase();
}

export function lookupScope(rawAddress, rawChain) {
  loadScopeData();
  const address = normalizeAddress(rawAddress);
  if (!address) return { error: 'invalid_address', message: 'address must be a non-empty string' };

  const chain = normalizeChainName(rawChain);
  let hits = [];

  if (chain) {
    const key = `${chain}:${address}`;
    hits = addressIndex.get(key) || [];
    // If nothing matched with chain constraint but the address exists on another chain,
    // still return those hits (with a note) — some agents send the wrong chain hint.
    if (hits.length === 0 && addressIndexAny.has(address)) {
      hits = addressIndexAny.get(address).map(h => ({ ...h, _chain_hint_mismatch: true }));
    }
  } else {
    hits = addressIndexAny.get(address) || [];
  }

  // Deduplicate by (platform, project) — same protocol can list a contract on multiple chains.
  const seen = new Set();
  const programs = [];
  for (const h of hits) {
    const k = `${h.platform}::${h.project}`;
    if (seen.has(k)) continue;
    seen.add(k);
    programs.push({
      platform: h.platform,
      project: h.project,
      display_name: h.display_name,
      url: h.url,
      max_payout_usd: h.max_payout_usd,
      asset_type: h.asset_type,
      chains: h.chains,
      kyc_required: h.kyc_required,
      matched_contract_name: h.matched_contract_name,
      matched_chain: h.matched_chain,
      chain_hint_mismatch: h._chain_hint_mismatch || undefined,
      notes: h.notes,
    });
  }

  const inScope = programs.length > 0;
  const topPayoutUsd = programs.reduce(
    (max, p) => (typeof p.max_payout_usd === 'number' && p.max_payout_usd > max ? p.max_payout_usd : max),
    0
  );

  const reasonCodes = [];
  if (inScope) {
    reasonCodes.push({
      code: 'IN_BOUNTY_SCOPE',
      severity: 'info',
      source: 'bounty_scope_seed_v0',
      evidence: `${programs.length}_program${programs.length === 1 ? '' : 's'}_max_payout_usd=${topPayoutUsd}`,
    });
  } else {
    reasonCodes.push({
      code: 'NOT_IN_SEEDED_SCOPE',
      severity: 'info',
      source: 'bounty_scope_seed_v0',
      evidence: 'address_not_in_curated_index',
    });
  }

  const notes = [];
  if (!chain) notes.push('no_chain_hint_provided_matched_any');
  if (hits.some(h => h._chain_hint_mismatch)) notes.push('chain_hint_did_not_match_any_program_returned_cross_chain_hits');

  return {
    chain: chain || null,
    address,
    in_scope: inScope,
    programs,
    top_payout_usd: inScope ? topPayoutUsd : 0,
    reason_codes: reasonCodes,
    sources_checked: ['bounty_scope_seed_v0'],
    data_freshness: {
      generated_at: scopeData?.generated_at || null,
      generated_by: scopeData?.generated_by || null,
      schema_version: scopeData?.$schema_version || null,
      programs_indexed: scopeData?.programs?.length || 0,
      contracts_indexed: addressIndex ? sumIndex(addressIndex) : 0,
    },
    cache_ttl_seconds: 3600,
    notes: notes.length ? notes : undefined,
  };
}

// Batch: up to N addresses in one call.
const MAX_BATCH = 25;
export function lookupScopeBatch(rawAddresses, rawChain) {
  if (!Array.isArray(rawAddresses)) {
    return { error: 'invalid_addresses', message: 'addresses must be an array' };
  }
  if (rawAddresses.length === 0) {
    return { error: 'empty_addresses', message: 'addresses array is empty' };
  }
  if (rawAddresses.length > MAX_BATCH) {
    return { error: 'batch_too_large', message: `max ${MAX_BATCH} addresses per request, got ${rawAddresses.length}` };
  }
  const results = rawAddresses.map(a => lookupScope(a, rawChain));
  const anyInScope = results.some(r => r?.in_scope);
  const totalPayout = results.reduce((s, r) => s + (r?.top_payout_usd || 0), 0);
  return {
    count: results.length,
    any_in_scope: anyInScope,
    total_top_payout_usd: totalPayout,
    results,
  };
}

// Called on module import so we don't pay the first-request cost.
loadScopeData(true);

export function _debug_reload() { return loadScopeData(true); }

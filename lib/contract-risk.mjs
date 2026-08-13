import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Known exploited contracts (bytecode-independent, matched by address).
// Extend by appending to data/known-exploits.json.
function loadKnownExploits() {
  const p = join(DATA_DIR, 'known-exploits.json');
  if (!existsSync(p)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const m = new Map();
    if (Array.isArray(raw)) {
      for (const e of raw) {
        if (e && typeof e.address === 'string') {
          m.set(e.address.toLowerCase(), {
            name: e.name || null,
            date: e.date || null,
            loss_usd: e.loss_usd || null,
            reference: e.reference || null,
          });
        }
      }
    }
    return m;
  } catch (e) {
    console.error('[contract-risk] failed to load known-exploits.json', e.message);
    return new Map();
  }
}

const knownExploits = loadKnownExploits();
console.log('[contract-risk] loaded known_exploits=' + knownExploits.size);

// EIP-1967 storage slots (canonical proxy pattern).
// keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// keccak256("eip1967.proxy.admin") - 1
const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// Chain configuration.
function rpcUrlFor(chain) {
  if (chain === 'eth') return 'https://ethereum-rpc.publicnode.com';
  if (chain === 'base') return 'https://mainnet.base.org';
  return null;
}

function etherscanChainIdFor(chain) {
  if (chain === 'eth') return 1;
  if (chain === 'base') return 8453;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Extract address (right 20 bytes) from a 32-byte storage slot value.
// Returns lowercase 0x-prefixed address, or null if slot is zero/empty.
function slotToAddress(slotHex) {
  if (!slotHex || typeof slotHex !== 'string') return null;
  const clean = slotHex.replace(/^0x/, '').toLowerCase();
  if (!clean || /^0+$/.test(clean)) return null;
  if (clean.length < 40) return null;
  const addr = '0x' + clean.slice(-40);
  if (/^0x0+$/.test(addr)) return null;
  return addr;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// Returns { isContract, codeSize, isEip7702Delegation }.
// EIP-7702: an EOA that has delegated to a contract. The bytecode is exactly
// 23 bytes and starts with 0xef0100 followed by a 20-byte target address.
// We treat these as EOAs (their code is a stub, not a real contract).
async function checkIsContract(rpcUrl, addr) {
  const code = await rpcCall(rpcUrl, 'eth_getCode', [addr, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    return { isContract: false, codeSize: 0, isEip7702Delegation: false };
  }
  const codeSize = (code.length - 2) / 2;
  const isEip7702 = codeSize === 23 && code.toLowerCase().startsWith('0xef0100');
  return {
    isContract: !isEip7702,
    codeSize,
    isEip7702Delegation: isEip7702,
  };
}

// Reads EIP-1967 impl + admin slots. If either is non-zero, contract is a proxy.
async function checkProxy(rpcUrl, addr) {
  const [implRaw, adminRaw] = await Promise.all([
    rpcCall(rpcUrl, 'eth_getStorageAt', [addr, EIP1967_IMPL_SLOT, 'latest']).catch(() => null),
    rpcCall(rpcUrl, 'eth_getStorageAt', [addr, EIP1967_ADMIN_SLOT, 'latest']).catch(() => null),
  ]);
  const impl = slotToAddress(implRaw);
  const admin = slotToAddress(adminRaw);
  return {
    isProxy: !!(impl || admin),
    implementation: impl,
    admin: admin,
  };
}

// Try common owner() / getOwner() views. Returns owner address or null.
// Non-Ownable contracts will revert; that's fine, we swallow.
async function checkOwner(rpcUrl, addr) {
  // Function selectors:
  //   owner()      -> 0x8da5cb5b
  //   getOwner()   -> 0x893d20e8
  const selectors = ['0x8da5cb5b', '0x893d20e8'];
  for (const sel of selectors) {
    try {
      const out = await rpcCall(rpcUrl, 'eth_call', [{ to: addr, data: sel }, 'latest']);
      const owner = slotToAddress(out);
      if (owner) return owner;
    } catch {
      // reverts are expected on non-Ownable contracts
    }
  }
  return null;
}

// Uses Etherscan V2 getsourcecode. Returns { verified, name, compiler } or null on error/skip.
// chain='base' currently skips (Etherscan free tier is ETH-only per Phase 2b findings).
async function checkVerifiedSource(chain, addr) {
  if (chain !== 'eth') return { skipped: true, reason: 'verification_check_eth_only_v0' };
  const key = process.env.ETHERSCAN_API_KEY || '';
  if (!key) return { skipped: true, reason: 'no_etherscan_key' };
  const url = 'https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=' + addr + '&apikey=' + key;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== '1' || !Array.isArray(j.result) || !j.result.length) {
      return { verified: false, name: null, compiler: null };
    }
    const entry = j.result[0];
    const src = entry.SourceCode || '';
    const verified = src.length > 0;
    return {
      verified,
      name: entry.ContractName || null,
      compiler: entry.CompilerVersion || null,
      proxy: entry.Proxy === '1' || entry.Proxy === 1,
      implementation: entry.Implementation && entry.Implementation !== '' ? entry.Implementation.toLowerCase() : null,
    };
  } catch (e) {
    return { skipped: true, reason: 'etherscan_fetch_failed:' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Score aggregator
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

function normalizeAddr(addr) {
  if (typeof addr !== 'string') return null;
  const s = addr.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null;
  return s;
}

export async function scoreContract(rawAddr, rawChain) {
  const addr = normalizeAddr(rawAddr);
  if (!addr) {
    return { error: 'invalid_address', message: 'address must be 0x-prefixed 40-hex EVM address' };
  }
  const chain = (rawChain || 'eth').toLowerCase();
  if (chain !== 'eth' && chain !== 'base') {
    return { error: 'unsupported_chain', message: 'chain must be "eth" or "base" (v0)' };
  }

  const rpcUrl = rpcUrlFor(chain);
  const reasonCodes = [];
  const sourcesChecked = [];
  const notes = [];
  const metadata = {};

  // Known-exploit short-circuit (cheap, deterministic).
  sourcesChecked.push('known_exploits');
  const hit = knownExploits.get(addr);
  if (hit) {
    reasonCodes.push({
      code: 'KNOWN_EXPLOIT_SIGNATURE',
      severity: 'high',
      source: 'known_exploits',
      evidence: 'name=' + (hit.name || 'unknown') + (hit.date ? ' date=' + hit.date : '') + (hit.loss_usd ? ' loss_usd=' + hit.loss_usd : ''),
    });
    if (hit.reference) metadata.exploit_reference = hit.reference;
  }

  // On-chain: is it a contract?
  sourcesChecked.push('onchain_' + chain);
  let contractInfo;
  try {
    contractInfo = await checkIsContract(rpcUrl, addr);
  } catch (e) {
    notes.push('onchain_getcode_failed:' + e.message);
    contractInfo = { isContract: false, codeSize: 0 };
  }

  let contractType = 'eoa';
  if (contractInfo.isContract) {
    contractType = 'verified'; // provisional; may downgrade below
    metadata.code_size_bytes = contractInfo.codeSize;
  } else {
    const evidence = contractInfo.isEip7702Delegation
      ? 'eip7702_delegated_eoa'
      : 'no_code_at_address';
    reasonCodes.push({
      code: 'EOA_NOT_CONTRACT',
      severity: 'low',
      source: 'onchain',
      evidence,
    });
    if (contractInfo.isEip7702Delegation) metadata.eip7702_delegation = true;
  }

  // Proxy check (only meaningful if code exists).
  if (contractInfo.isContract) {
    try {
      const proxy = await checkProxy(rpcUrl, addr);
      if (proxy.isProxy) {
        contractType = 'proxy';
        metadata.proxy_target = proxy.implementation;
        metadata.proxy_admin = proxy.admin;
        // PROXY_NO_TIMELOCK v0: any EIP-1967 proxy with EOA admin (no code) flags.
        // A timelock has code; a raw EOA admin does not.
        if (proxy.admin) {
          try {
            const adminInfo = await checkIsContract(rpcUrl, proxy.admin);
            if (!adminInfo.isContract) {
              reasonCodes.push({
                code: 'PROXY_NO_TIMELOCK',
                severity: 'medium',
                source: 'onchain',
                evidence: 'admin=' + proxy.admin + ' is_eoa',
              });
            }
          } catch {
            // ignore — proxy still recorded
          }
        }
      }
    } catch (e) {
      notes.push('proxy_check_failed:' + e.message);
    }

    // Owner check
    try {
      const owner = await checkOwner(rpcUrl, addr);
      if (owner) {
        metadata.owner = owner;
        // OWNER_PRIVILEGED v0: owner is an EOA (not a multisig / timelock contract).
        let ownerIsEoa = null;
        try {
          const ownerInfo = await checkIsContract(rpcUrl, owner);
          ownerIsEoa = !ownerInfo.isContract;
        } catch (e) {
          notes.push('owner_type_check_failed:' + e.message);
        }
        if (ownerIsEoa === true) {
          reasonCodes.push({
            code: 'OWNER_PRIVILEGED',
            severity: 'medium',
            source: 'onchain',
            evidence: 'owner=' + owner + ' is_eoa',
          });
        }
      }
    } catch (e) {
      notes.push('owner_check_failed:' + e.message);
    }
  }

  // Verified-source check (Etherscan V2, ETH only in v0)
  if (contractInfo.isContract) {
    sourcesChecked.push('etherscan_v2_' + chain);
    const src = await checkVerifiedSource(chain, addr);
    if (src.skipped) {
      notes.push('verified_source_skipped:' + src.reason);
    } else {
      metadata.verified = !!src.verified;
      if (src.name) metadata.name = src.name;
      if (src.compiler) metadata.compiler = src.compiler;
      // Only record proxy_target if it's a real distinct address, not the contract itself.
      if (src.implementation && !metadata.proxy_target && src.implementation !== addr) {
        metadata.proxy_target = src.implementation;
      }
      if (!src.verified) {
        contractType = 'unverified';
        reasonCodes.push({
          code: 'UNVERIFIED_SOURCE',
          severity: 'medium',
          source: 'etherscan_v2',
          evidence: 'no_public_source_on_etherscan',
        });
      }
    }
  }

  if (chain === 'base') notes.push('base_v0_no_verified_source_check');

  const score = Math.min(100, reasonCodes.reduce((s, r) => s + severityScore(r.severity), 0));
  const level = riskLevel(score);

  const result = {
    chain,
    address: rawAddr,
    normalized_address: addr,
    contract_type: contractType,
    score,
    risk_level: level,
    reason_codes: reasonCodes,
    metadata,
    checked_at: new Date().toISOString(),
    sources_checked: sourcesChecked,
    cache_ttl_seconds: 3600,
  };
  if (notes.length) result.notes = notes;
  return result;
}

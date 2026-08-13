#!/usr/bin/env node
// Local logic test — validates parseExtraction() and acceptChange() without
// hitting the Perplexity API. Runs on synthetic inputs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Copy-paste of the pure functions from refresh-scope.mjs so we can test
// without importing (import would trigger the PERPLEXITY_API_KEY check).

function parseExtraction(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const parsed = JSON.parse(s);
    return {
      max_payout_usd: typeof parsed.max_payout_usd === 'number' ? parsed.max_payout_usd : null,
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      kyc_required: typeof parsed.kyc_required === 'boolean' ? parsed.kyc_required : null,
    };
  } catch (e) {
    return null;
  }
}

function acceptChange(oldProg, newFacts) {
  const changes = {};
  const rejects = [];
  const oldP = oldProg.max_payout_usd;
  const newP = newFacts.max_payout_usd;
  if (typeof newP === 'number' && newP > 0 && typeof oldP === 'number') {
    const ratio = newP / oldP;
    if (ratio < 0.5) rejects.push(`payout_drop>50% (old=${oldP}, new=${newP})`);
    else if (ratio > 10) rejects.push(`payout_jump>10x (old=${oldP}, new=${newP})`);
    else if (newP !== oldP) changes.max_payout_usd = { old: oldP, new: newP };
  }
  if (typeof newFacts.kyc_required === 'boolean' && typeof oldProg.kyc_required === 'boolean' &&
      newFacts.kyc_required !== oldProg.kyc_required) {
    changes.kyc_required = { old: oldProg.kyc_required, new: newFacts.kyc_required };
  }
  const oldStatus = oldProg.status || 'live';
  const newStatus = newFacts.status;
  if (['live', 'paused', 'closed'].includes(newStatus) && newStatus !== oldStatus) {
    changes.status = { old: oldStatus, new: newStatus };
  }
  const anyChange = Object.keys(changes).length > 0;
  const hasReject = rejects.length > 0;
  return { accepted: anyChange && !hasReject, hasChange: anyChange, rejected: hasReject, reason: hasReject ? rejects.join('; ') : (anyChange ? 'ok' : 'no-change'), changes };
}

// -------- Tests --------
let pass = 0, fail = 0;
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => (acc[k] = canon(v[k]), acc), {});
  }
  return v;
}
function t(name, actual, expected) {
  const ok = JSON.stringify(canon(actual)) === JSON.stringify(canon(expected));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log(`  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// parseExtraction
t('parse plain JSON', parseExtraction('{"max_payout_usd":1000000,"status":"live","kyc_required":true}'),
  { max_payout_usd: 1000000, status: 'live', kyc_required: true });
t('parse fenced JSON', parseExtraction('```json\n{"max_payout_usd":500000,"status":"paused","kyc_required":false}\n```'),
  { max_payout_usd: 500000, status: 'paused', kyc_required: false });
t('parse prose+JSON', parseExtraction('Here you go: {"max_payout_usd":250000,"status":"live","kyc_required":null} — hope this helps'),
  { max_payout_usd: 250000, status: 'live', kyc_required: null });
t('parse invalid returns null', parseExtraction('sorry I cannot help'), null);
t('parse missing fields defaults', parseExtraction('{"status":"live"}'),
  { max_payout_usd: null, status: 'live', kyc_required: null });

// acceptChange
const base = { max_payout_usd: 1000000, kyc_required: true, status: 'live' };
t('no change', acceptChange(base, { max_payout_usd: 1000000, status: 'live', kyc_required: true }),
  { accepted: false, hasChange: false, rejected: false, reason: 'no-change', changes: {} });
t('payout raise 2x accepted', acceptChange(base, { max_payout_usd: 2000000, status: 'live', kyc_required: true }),
  { accepted: true, hasChange: true, rejected: false, reason: 'ok', changes: { max_payout_usd: { old: 1000000, new: 2000000 } } });
t('payout drop 90% rejected', acceptChange(base, { max_payout_usd: 100000, status: 'live', kyc_required: true }),
  { accepted: false, hasChange: false, rejected: true, reason: 'payout_drop>50% (old=1000000, new=100000)', changes: {} });
t('payout jump 20x rejected', acceptChange(base, { max_payout_usd: 20000000, status: 'live', kyc_required: true }),
  { accepted: false, hasChange: false, rejected: true, reason: 'payout_jump>10x (old=1000000, new=20000000)', changes: {} });
// Note: real code returns fuller reason strings like 'payout_drop>50% (old=1000000, new=100000)'
// which is what we assert above — tests use canonical key-order comparison so field order does not matter.
t('status live->paused accepted', acceptChange(base, { max_payout_usd: 1000000, status: 'paused', kyc_required: true }),
  { accepted: true, hasChange: true, rejected: false, reason: 'ok', changes: { status: { old: 'live', new: 'paused' } } });
t('kyc true->false accepted', acceptChange(base, { max_payout_usd: 1000000, status: 'live', kyc_required: false }),
  { accepted: true, hasChange: true, rejected: false, reason: 'ok', changes: { kyc_required: { old: true, new: false } } });
t('unknown status ignored', acceptChange(base, { max_payout_usd: 1000000, status: 'unknown', kyc_required: true }),
  { accepted: false, hasChange: false, rejected: false, reason: 'no-change', changes: {} });
t('null kyc ignored', acceptChange(base, { max_payout_usd: 1000000, status: 'live', kyc_required: null }),
  { accepted: false, hasChange: false, rejected: false, reason: 'no-change', changes: {} });
t('multiple changes at once', acceptChange(base, { max_payout_usd: 1500000, status: 'paused', kyc_required: false }),
  { accepted: true, hasChange: true, rejected: false, reason: 'ok',
    changes: { max_payout_usd: { old: 1000000, new: 1500000 }, status: { old: 'live', new: 'paused' }, kyc_required: { old: true, new: false } } });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

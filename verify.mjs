#!/usr/bin/env node
// verify.mjs — run the tollbooth v0.9 conformance test vectors.
//
// Usage:
//   node verify.mjs                # run all suites, exit nonzero on failure
//   node verify.mjs canonicalization
//   node verify.mjs --verbose
//
// This runner uses THIS repo's canonicalizer to verify its own fixtures.
// Implementers should adapt this file to point at their own implementation:
// replace the import of ./src/digest.mjs with their equivalent, and every
// fixture must still pass.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestDigest, preAuthRequestDigest } from './src/digest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, 'test-vectors', 'v0.9');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const SUITE_FILTER = args.find(a => !a.startsWith('--'));

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function color(s, c) { return process.stdout.isTTY ? c + s + RESET : s; }

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  return readFileSync(path, 'utf8').trim();
}

function nfcNormalize(value) {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(nfcNormalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k.normalize('NFC')] = nfcNormalize(value[k]);
    return out;
  }
  return value;
}

function listDirs(path) {
  return readdirSync(path)
    .filter(name => statSync(join(path, name)).isDirectory())
    .sort();
}

function listFiles(path, pattern) {
  return readdirSync(path)
    .filter(name => pattern.test(name))
    .sort();
}

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

// ---------- Canonicalization suite ----------

function runCanonicalizationSuite() {
  const suiteRoot = join(ROOT, 'canonicalization');
  const fixtures = listDirs(suiteRoot);
  console.log(color(`\n[canonicalization] ${fixtures.length} fixtures`, BOLD));

  for (const name of fixtures) {
    const dir = join(suiteRoot, name);
    const inputs = listFiles(dir, /^input-[a-z]\.json$/);
    const negativeMode = readdirSync(dir).some(f => f.startsWith('expected-digest-'));

    // NFC normalization is required for the unicode-nfc fixture; a compliant
    // implementation NFC-normalizes all strings before canonicalizing.
    const needsNfc = name.includes('unicode-nfc');

    try {
      if (negativeMode) {
        // Each input has its own expected digest and they MUST differ.
        const results = inputs.map(input => {
          const label = input.replace(/\.json$/, '').replace('input-', '');
          const expected = readText(join(dir, `expected-digest-${label}.txt`));
          const parsed = readJson(join(dir, input));
          const value = needsNfc ? nfcNormalize(parsed) : parsed;
          const actual = requestDigest(value);
          return { input, expected, actual, match: actual === expected };
        });
        const digests = new Set(results.map(r => r.actual));
        const allDistinct = digests.size === results.length;
        const allMatchExpected = results.every(r => r.match);

        if (allDistinct && allMatchExpected) {
          totalPassed++;
          console.log(`  ${color('ok  ', GREEN)} ${name} ${color('(negative)', DIM)}`);
          if (VERBOSE) results.forEach(r => console.log(`      ${r.input} → ${r.actual.slice(0, 16)}…`));
        } else {
          totalFailed++;
          const reason = !allDistinct
            ? 'inputs produced IDENTICAL digests (should differ)'
            : 'digest(s) did not match expected';
          failures.push({ suite: 'canonicalization', fixture: name, reason, results });
          console.log(`  ${color('FAIL', RED)} ${name}: ${reason}`);
        }
      } else {
        const expected = readText(join(dir, 'expected-digest.txt'));
        const results = inputs.map(input => {
          const parsed = readJson(join(dir, input));
          const value = needsNfc ? nfcNormalize(parsed) : parsed;
          const actual = requestDigest(value);
          return { input, actual, match: actual === expected };
        });
        const allMatch = results.every(r => r.match);
        if (allMatch) {
          totalPassed++;
          console.log(`  ${color('ok  ', GREEN)} ${name} ${color(`(${results.length} inputs → ${expected.slice(0, 16)}…)`, DIM)}`);
          if (VERBOSE) results.forEach(r => console.log(`      ${r.input} → ${r.actual.slice(0, 16)}…`));
        } else {
          totalFailed++;
          failures.push({ suite: 'canonicalization', fixture: name, reason: 'digest divergence', results, expected });
          console.log(`  ${color('FAIL', RED)} ${name}: expected ${expected}`);
          results.forEach(r => console.log(`      ${r.input} → ${r.actual}${r.match ? '' : color(' ← MISMATCH', RED)}`));
        }
      }
    } catch (err) {
      totalFailed++;
      failures.push({ suite: 'canonicalization', fixture: name, reason: err.message });
      console.log(`  ${color('FAIL', RED)} ${name}: ${err.message}`);
    }
  }
}

// ---------- Excluded-fields suite ----------
//
// This suite verifies the v0.9 volatile-field allowlist. Positive fixtures
// contain two envelopes that differ ONLY in one or more volatile fields;
// their `preAuthRequestDigest` (which strips volatile fields before hashing)
// MUST be identical. Negative fixtures differ in a non-volatile field; the
// digests MUST differ.
//
// Implementations replacing this runner should call THEIR own equivalent of
// preAuthRequestDigest — a function that strips the V09_VOLATILE_FIELDS set
// (see digest.mjs) before canonicalizing and hashing.

function runExcludedFieldsSuite() {
  const suiteRoot = join(ROOT, 'excluded-fields');
  let fixtures;
  try {
    fixtures = listDirs(suiteRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(color(`\n[excluded-fields] suite not present, skipping`, DIM));
      return;
    }
    throw err;
  }
  console.log(color(`\n[excluded-fields] ${fixtures.length} fixtures`, BOLD));

  for (const name of fixtures) {
    const dir = join(suiteRoot, name);
    const inputs = listFiles(dir, /^input-[a-z]\.json$/);
    const negativeMode = readdirSync(dir).some(f => f.startsWith('expected-digest-'));

    try {
      if (negativeMode) {
        // Each input has its own expected digest; they MUST differ.
        const results = inputs.map(input => {
          const label = input.replace(/\.json$/, '').replace('input-', '');
          const expected = readText(join(dir, `expected-digest-${label}.txt`));
          const parsed = readJson(join(dir, input));
          const actual = preAuthRequestDigest(parsed);
          return { input, expected, actual, match: actual === expected };
        });
        const digests = new Set(results.map(r => r.actual));
        const allDistinct = digests.size === results.length;
        const allMatchExpected = results.every(r => r.match);

        if (allDistinct && allMatchExpected) {
          totalPassed++;
          console.log(`  ${color('ok  ', GREEN)} ${name} ${color('(negative — digests differ as required)', DIM)}`);
          if (VERBOSE) results.forEach(r => console.log(`      ${r.input} → ${r.actual.slice(0, 16)}…`));
        } else {
          totalFailed++;
          const reason = !allDistinct
            ? 'inputs produced IDENTICAL digests (volatile-field allowlist stripped a semantic field)'
            : 'digest(s) did not match expected';
          failures.push({ suite: 'excluded-fields', fixture: name, reason, results });
          console.log(`  ${color('FAIL', RED)} ${name}: ${reason}`);
          results.forEach(r => console.log(`      ${r.input} → ${r.actual}${r.match ? '' : color(' ← MISMATCH', RED)}`));
        }
      } else {
        // All inputs share a single expected digest after volatile stripping.
        const expected = readText(join(dir, 'expected-digest.txt'));
        const results = inputs.map(input => {
          const parsed = readJson(join(dir, input));
          const actual = preAuthRequestDigest(parsed);
          return { input, actual, match: actual === expected };
        });
        const allMatch = results.every(r => r.match);
        if (allMatch) {
          totalPassed++;
          console.log(`  ${color('ok  ', GREEN)} ${name} ${color(`(${results.length} inputs → ${expected.slice(0, 16)}…)`, DIM)}`);
          if (VERBOSE) results.forEach(r => console.log(`      ${r.input} → ${r.actual.slice(0, 16)}…`));
        } else {
          totalFailed++;
          failures.push({ suite: 'excluded-fields', fixture: name, reason: 'digest divergence after volatile stripping', results, expected });
          console.log(`  ${color('FAIL', RED)} ${name}: expected ${expected}`);
          results.forEach(r => console.log(`      ${r.input} → ${r.actual}${r.match ? '' : color(' ← MISMATCH', RED)}`));
        }
      }
    } catch (err) {
      totalFailed++;
      failures.push({ suite: 'excluded-fields', fixture: name, reason: err.message });
      console.log(`  ${color('FAIL', RED)} ${name}: ${err.message}`);
    }
  }
}

// ---------- Replay-boundaries suite ----------
//
// This suite validates fixture files that specify state-transition contracts
// for envelope consumption attempts. Each scenario.json declares an
// initial_state, an envelope, an attempt, an expected_outcome (accept or
// reject), and an expected_terminal_state.
//
// The runner in this repo is a SHAPE VALIDATOR, not a state-machine executor:
// it proves the fixture files are internally consistent and satisfy the
// terminal-state invariants defined in the v0.9 spec:
//
//   - Every rejection MUST have budget_consumed_delta === "0" and
//     settlement_ref === null. No partial charge, no partial settlement.
//   - Every rejection MUST have ledger_updated === false.
//   - Every acceptance MUST record a state transition: nonce consumed,
//     settlement_ref set, ledger_updated === true.
//   - Every rejection MUST carry an expected_reason_code.
//
// An implementation of the v0.9 state machine plugs into this runner by
// providing an executor that consumes (initial_state, envelope, attempt) and
// produces an actual (outcome, terminal_state). Compliance = actual matches
// scenario.expected_* on every fixture.
//
// See specs/pre-authorization-v0.9.md § "State transitions" (pending).

const REQUIRED_SCENARIO_KEYS = [
  'initial_state',
  'envelope',
  'attempt',
  'expected_outcome',
  'expected_terminal_state',
];

const REQUIRED_INITIAL_STATE_KEYS = [
  'consumed_nonces',
  'budget_period_start',
  'budget_consumed_xrp',
  'settlements',
];

const REQUIRED_ATTEMPT_KEYS = ['endpoint', 'charge_xrp', 'submitted_at'];

const REQUIRED_TERMINAL_KEYS = [
  'nonce_status',
  'budget_consumed_delta',
  'settlement_ref',
  'ledger_updated',
];

function assertShape(obj, keys, path) {
  for (const k of keys) {
    if (!(k in obj)) throw new Error(`${path}: missing required key "${k}"`);
  }
}

function validateScenario(scenario) {
  assertShape(scenario, REQUIRED_SCENARIO_KEYS, 'scenario');
  assertShape(scenario.initial_state, REQUIRED_INITIAL_STATE_KEYS, 'scenario.initial_state');
  assertShape(scenario.attempt, REQUIRED_ATTEMPT_KEYS, 'scenario.attempt');
  assertShape(scenario.expected_terminal_state, REQUIRED_TERMINAL_KEYS, 'scenario.expected_terminal_state');

  const outcome = scenario.expected_outcome;
  if (outcome !== 'accept' && outcome !== 'reject') {
    throw new Error(`scenario.expected_outcome must be "accept" or "reject", got "${outcome}"`);
  }

  const t = scenario.expected_terminal_state;

  if (outcome === 'reject') {
    if (!('expected_reason_code' in scenario)) {
      throw new Error('scenario.expected_reason_code is required for rejections');
    }
    if (t.budget_consumed_delta !== '0') {
      throw new Error(
        `rejection invariant violated: budget_consumed_delta="${t.budget_consumed_delta}" (must be "0")`
      );
    }
    if (t.settlement_ref !== null) {
      throw new Error(
        `rejection invariant violated: settlement_ref=${JSON.stringify(t.settlement_ref)} (must be null)`
      );
    }
    if (t.ledger_updated !== false) {
      throw new Error(
        `rejection invariant violated: ledger_updated=${t.ledger_updated} (must be false)`
      );
    }
    if (t.nonce_status !== 'fresh' && t.nonce_status !== 'consumed') {
      throw new Error(
        `nonce_status must be "fresh" or "consumed" on rejection, got "${t.nonce_status}"`
      );
    }
  } else {
    // accept
    if (t.nonce_status !== 'consumed') {
      throw new Error(
        `acceptance invariant violated: nonce_status="${t.nonce_status}" (must be "consumed")`
      );
    }
    if (typeof t.settlement_ref !== 'string' || t.settlement_ref.length === 0) {
      throw new Error(
        `acceptance invariant violated: settlement_ref must be a non-empty string, got ${JSON.stringify(t.settlement_ref)}`
      );
    }
    if (t.ledger_updated !== true) {
      throw new Error(
        `acceptance invariant violated: ledger_updated=${t.ledger_updated} (must be true)`
      );
    }
    if (t.budget_consumed_delta === '0') {
      throw new Error(
        `acceptance invariant violated: budget_consumed_delta="0" (must record positive charge)`
      );
    }
  }
}

function runReplayBoundariesSuite() {
  const suiteRoot = join(ROOT, 'replay-boundaries');
  let fixtures;
  try {
    fixtures = listDirs(suiteRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(color(`\n[replay-boundaries] suite not present, skipping`, DIM));
      return;
    }
    throw err;
  }
  console.log(color(`\n[replay-boundaries] ${fixtures.length} fixtures`, BOLD));

  for (const name of fixtures) {
    const dir = join(suiteRoot, name);
    try {
      const scenario = readJson(join(dir, 'scenario.json'));
      validateScenario(scenario);
      totalPassed++;
      const outcome = scenario.expected_outcome === 'accept'
        ? 'accept'
        : `reject/${scenario.expected_reason_code}`;
      const terminal = scenario.expected_terminal_state;
      const summary = `${outcome}, nonce=${terminal.nonce_status}, Δbudget=${terminal.budget_consumed_delta}`;
      console.log(`  ${color('ok  ', GREEN)} ${name} ${color(`(${summary})`, DIM)}`);
    } catch (err) {
      totalFailed++;
      failures.push({ suite: 'replay-boundaries', fixture: name, reason: err.message });
      console.log(`  ${color('FAIL', RED)} ${name}: ${err.message}`);
    }
  }
}

// ---------- Suite registry ----------

const SUITES = {
  canonicalization: runCanonicalizationSuite,
  'excluded-fields': runExcludedFieldsSuite,
  'replay-boundaries': runReplayBoundariesSuite,
};

// ---------- Main ----------

const toRun = SUITE_FILTER ? [SUITE_FILTER] : Object.keys(SUITES);

for (const suite of toRun) {
  if (!SUITES[suite]) {
    console.error(color(`Unknown suite: ${suite}`, RED));
    console.error(`Available: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }
  SUITES[suite]();
}

console.log('');
console.log(color(`${totalPassed} passed, ${totalFailed} failed`, totalFailed === 0 ? GREEN : RED));

process.exit(totalFailed === 0 ? 0 : 1);

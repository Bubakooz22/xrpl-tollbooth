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
import { requestDigest } from './src/digest.mjs';

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

// ---------- Suite registry ----------

const SUITES = {
  canonicalization: runCanonicalizationSuite,
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

#!/usr/bin/env node
// Phase 4e — Nightly bounty-scope refresher.
//
// Design contract (safe by default):
//   - Reads existing data/bounty-scope.json.
//   - Fetches each program's canonical URL via Perplexity content.fetch with a
//     strict extraction prompt.
//   - Only mutates: program.max_payout_usd, program.kyc_required, program.status.
//   - NEVER adds/removes programs, NEVER touches contracts[], platform, project, url.
//   - Applies sanity gates before writing:
//       * Refuse payout drop >50% (likely misparse)
//       * Refuse payout increase >10x (likely misparse)
//       * Refuse if extractor returns null/error for a required field
//   - Writes new file only if diff has at least one accepted change.
//   - Prints a human-readable diff summary to stdout.
//
// Usage:
//   node scripts/refresh-scope.mjs              # dry run (prints diff, no write)
//   node scripts/refresh-scope.mjs --write      # apply changes to data/bounty-scope.json
//   node scripts/refresh-scope.mjs --write --commit  # also git add/commit/push on changes
//
// Requires PERPLEXITY_API_KEY in env for extraction calls.
// Rate-limit friendly: 1 URL per second, 3 concurrent max.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCOPE_FILE = join(REPO_ROOT, 'data', 'bounty-scope.json');
// Perplexity Sonar chat completions endpoint.
// Sonar has built-in web-search grounding, so it reads JS-rendered pages
// (Immunefi/Cantina Next.js SPAs) reliably without a headless browser.
// Constrained to strict JSON via response_format.json_schema.
const PPLX_CHAT_URL = 'https://api.perplexity.ai/v1/sonar';
const PPLX_MODEL = process.env.PPLX_MODEL || 'sonar';

const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    max_payout_usd: { type: ['integer', 'null'] },
    status: { type: 'string', enum: ['live', 'paused', 'closed', 'unknown'] },
    kyc_required: { type: ['boolean', 'null'] },
  },
  required: ['max_payout_usd', 'status', 'kyc_required'],
};

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const COMMIT = args.includes('--commit');
const DEBUG = args.includes('--debug');

const PPLX_KEY = process.env.PERPLEXITY_API_KEY;
if (!PPLX_KEY) {
  console.error('[refresh-scope] FATAL: PERPLEXITY_API_KEY env var not set');
  process.exit(2);
}

// ---------- Fetch + extract one program ----------

const EXTRACT_PROMPT = `From this bug bounty program page, extract ONLY these three facts and return them as a strict JSON object with NO markdown, NO prose, NO code fences:

{
  "max_payout_usd": <integer USD or null if not stated>,
  "status": "live" | "paused" | "closed" | "unknown",
  "kyc_required": true | false | null
}

Rules:
- max_payout_usd: the highest bounty payout at the highest severity tier (usually Critical). If stated in a token (e.g. "up to 500,000 SDEX"), use the USD equivalent if the page states it, otherwise null. Do not fabricate a conversion.
- status: "live" if the page indicates the program is actively accepting reports. "paused" if temporarily suspended. "closed" if terminated. "unknown" if unclear.
- kyc_required: true if KYC is required for payouts. false if explicitly not required. null if not stated.

Return ONLY the JSON object.`;

async function pplxFetch(url) {
  const userMsg = `Read this exact URL and extract the requested facts:\n${url}\n\n${EXTRACT_PROMPT}`;
  const res = await fetch(PPLX_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PPLX_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: PPLX_MODEL,
      messages: [
        { role: 'system', content: 'You extract facts from web pages. Return only strict JSON matching the schema.' },
        { role: 'user', content: userMsg },
      ],
      temperature: 0,
      max_tokens: 200,
      // Constrain search to the exact hostname so Sonar reads it, not adjacent pages.
      search_domain_filter: [new URL(url).hostname],
      // JSON schema constraint = guaranteed valid JSON output.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'bounty_facts', schema: EXTRACT_JSON_SCHEMA, strict: true },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pplx sonar ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`pplx: no content in response`);
  }
  if (DEBUG) console.error(`[debug] usage=${JSON.stringify(data?.usage?.cost)}`);
  return content;
}

function parseExtraction(raw, url) {
  // The API may return a stringified JSON or a markdown-wrapped JSON.
  let s = String(raw).trim();
  // Strip common fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Grab first {...} block if there is prose around it.
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
    if (DEBUG) console.error(`[extract-parse-fail] ${url}: ${e.message}\nraw=${s.slice(0, 300)}`);
    return null;
  }
}

// ---------- Sanity gates ----------

function acceptChange(oldProg, newFacts) {
  // Returns { accepted: bool, reason: string, changes: {field:{old,new,accepted}} }
  const changes = {};
  const rejects = [];

  // max_payout_usd
  const oldP = oldProg.max_payout_usd;
  const newP = newFacts.max_payout_usd;
  if (typeof newP === 'number' && newP > 0 && typeof oldP === 'number') {
    const ratio = newP / oldP;
    if (ratio < 0.5) {
      rejects.push(`payout_drop>50% (old=${oldP}, new=${newP})`);
    } else if (ratio > 10) {
      rejects.push(`payout_jump>10x (old=${oldP}, new=${newP})`);
    } else if (newP !== oldP) {
      changes.max_payout_usd = { old: oldP, new: newP };
    }
  }

  // kyc_required (only mutate if we got a definite bool AND old was set)
  if (typeof newFacts.kyc_required === 'boolean' && typeof oldProg.kyc_required === 'boolean' &&
      newFacts.kyc_required !== oldProg.kyc_required) {
    changes.kyc_required = { old: oldProg.kyc_required, new: newFacts.kyc_required };
  }

  // status
  const oldStatus = oldProg.status || 'live';  // default assume live if unset
  const newStatus = newFacts.status;
  if (['live', 'paused', 'closed'].includes(newStatus) && newStatus !== oldStatus) {
    changes.status = { old: oldStatus, new: newStatus };
  }

  const anyChange = Object.keys(changes).length > 0;
  const hasReject = rejects.length > 0;
  return {
    accepted: anyChange && !hasReject,
    hasChange: anyChange,
    rejected: hasReject,
    reason: hasReject ? rejects.join('; ') : (anyChange ? 'ok' : 'no-change'),
    changes,
  };
}

// ---------- Main ----------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const scope = JSON.parse(readFileSync(SCOPE_FILE, 'utf8'));
  const programs = scope.programs || [];
  console.log(`[refresh-scope] loaded ${programs.length} programs from ${SCOPE_FILE}`);
  console.log(`[refresh-scope] mode: ${WRITE ? (COMMIT ? 'WRITE+COMMIT' : 'WRITE') : 'DRY-RUN'}`);

  const summary = {
    total: programs.length,
    fetched: 0,
    fetch_errors: 0,
    parse_errors: 0,
    accepted: 0,
    rejected_sanity: 0,
    no_change: 0,
    changes_by_program: {},
  };

  const updated = JSON.parse(JSON.stringify(scope)); // deep clone

  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    const key = `${p.platform}:${p.project}`;
    process.stdout.write(`[${i + 1}/${programs.length}] ${key.padEnd(32)} ... `);

    let raw;
    try {
      raw = await pplxFetch(p.url);
      summary.fetched++;
    } catch (e) {
      summary.fetch_errors++;
      process.stdout.write(`FETCH-FAIL (${e.message.slice(0, 60)})\n`);
      await sleep(1000);
      continue;
    }

    const facts = parseExtraction(raw, p.url);
    if (!facts) {
      summary.parse_errors++;
      process.stdout.write(`PARSE-FAIL\n`);
      await sleep(1000);
      continue;
    }

    const decision = acceptChange(p, facts);
    if (decision.rejected) {
      summary.rejected_sanity++;
      process.stdout.write(`SANITY-REJECT: ${decision.reason}\n`);
    } else if (!decision.hasChange) {
      summary.no_change++;
      process.stdout.write(`unchanged (payout=${facts.max_payout_usd}, status=${facts.status})\n`);
    } else {
      summary.accepted++;
      summary.changes_by_program[key] = decision.changes;
      // apply
      const target = updated.programs[i];
      for (const [field, ch] of Object.entries(decision.changes)) {
        target[field] = ch.new;
      }
      process.stdout.write(`CHANGE: ${Object.entries(decision.changes).map(([k, v]) => `${k} ${JSON.stringify(v.old)}→${JSON.stringify(v.new)}`).join(', ')}\n`);
    }

    await sleep(1000); // 1 req/sec, gentle
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total programs:       ${summary.total}`);
  console.log(`Fetched OK:           ${summary.fetched}`);
  console.log(`Fetch errors:         ${summary.fetch_errors}`);
  console.log(`Parse errors:         ${summary.parse_errors}`);
  console.log(`Sanity rejected:      ${summary.rejected_sanity}`);
  console.log(`Unchanged:            ${summary.no_change}`);
  console.log(`Accepted changes:     ${summary.accepted}`);

  if (summary.accepted === 0) {
    console.log('\n[refresh-scope] no changes to apply. Exit 0.');
    process.exit(0);
  }

  console.log('\nAccepted changes:');
  for (const [k, ch] of Object.entries(summary.changes_by_program)) {
    console.log(`  ${k}:`);
    for (const [field, v] of Object.entries(ch)) {
      console.log(`    ${field}: ${JSON.stringify(v.old)} → ${JSON.stringify(v.new)}`);
    }
  }

  if (!WRITE) {
    console.log('\n[refresh-scope] DRY RUN — pass --write to apply.');
    process.exit(0);
  }

  // Update metadata timestamp
  updated.last_refreshed_at = new Date().toISOString();
  updated.last_refreshed_by = 'scripts/refresh-scope.mjs';

  writeFileSync(SCOPE_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`\n[refresh-scope] wrote updates to ${SCOPE_FILE}`);

  if (!COMMIT) {
    console.log('[refresh-scope] --commit not set; leaving unstaged changes for review.');
    process.exit(0);
  }

  // Commit + push
  try {
    const changeSummary = Object.entries(summary.changes_by_program)
      .map(([k, ch]) => `${k}(${Object.keys(ch).join(',')})`)
      .join(', ');
    execSync('git add data/bounty-scope.json', { cwd: REPO_ROOT, stdio: 'inherit' });
    execSync(
      `git commit -m "chore(scope): nightly refresh - ${summary.accepted} program(s) updated" -m "Changes: ${changeSummary}"`,
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
    execSync('git push origin master', { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log('[refresh-scope] committed and pushed.');
  } catch (e) {
    console.error('[refresh-scope] git operation failed:', e.message);
    process.exit(3);
  }
}

main().catch(e => {
  console.error('[refresh-scope] FATAL:', e.stack || e.message);
  process.exit(1);
});

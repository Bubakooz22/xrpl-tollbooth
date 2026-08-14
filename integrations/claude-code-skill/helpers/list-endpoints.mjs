#!/usr/bin/env node
// integrations/claude-code-skill/helpers/list-endpoints.mjs
//
// Human-readable dump of the current /.well-known/agent.json.
// Run this before making a paid call if you're unsure the endpoint exists
// or unsure what auth model and cost apply.
//
// Usage:
//   node integrations/claude-code-skill/helpers/list-endpoints.mjs

const TOLLBOOTH_URL = process.env.TOLLBOOTH_URL ?? "http://127.0.0.1:8787";

function fmtPricing(pricing) {
  if (!pricing || pricing.length === 0) return "(no pricing \u2014 API-key gated)";
  return pricing
    .map((p) => {
      if (p.asset === "XRP") return `${p.amount_drops} drops XRP`;
      if (p.asset === "RLUSD") return `${p.amount} RLUSD`;
      return `${p.amount ?? p.amount_drops} ${p.asset}`;
    })
    .join(" | ");
}

function fmtRateLimit(rl) {
  if (!rl) return "";
  return ` [${rl.per_minute}/min${rl.bucket ? ` bucket=${rl.bucket}` : ""}]`;
}

async function main() {
  const url = `${TOLLBOOTH_URL}/.well-known/agent.json`;
  console.log(`[list-endpoints] fetching ${url}\n`);
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`fetch failed: ${r.status}`);
    process.exit(1);
  }
  const m = await r.json();

  console.log(`${m.display_name}  v${m.version}`);
  console.log(m.description);
  console.log("");
  console.log(`Contact:  ${m.contact.name}  <${m.contact.url}>`);
  console.log(`Homepage: ${m.homepage}`);
  console.log(`OpenAPI:  ${TOLLBOOTH_URL}${m.openapi}`);
  console.log("");
  console.log("Networks:");
  for (const [k, v] of Object.entries(m.networks)) {
    console.log(`  ${k}: ${v.kind}  merchant=${v.merchant_address}  facilitator=${v.facilitator_url}`);
  }
  console.log("");
  console.log("Endpoints:");
  console.log("");
  for (const e of m.endpoints) {
    const beta = e.beta ? "  [BETA]" : "";
    console.log(`  ${e.method.padEnd(4)} ${e.path}${beta}`);
    console.log(`    id:      ${e.id}`);
    console.log(`    auth:    ${e.auth}${fmtRateLimit(e.rate_limit)}`);
    console.log(`    price:   ${fmtPricing(e.pricing)}`);
    console.log(`    summary: ${e.summary}`);
    if (e.reason_codes) {
      console.log(`    codes:   ${e.reason_codes.slice(0, 6).join(", ")}${e.reason_codes.length > 6 ? ` \u2026 (+${e.reason_codes.length - 6} more)` : ""}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(`[list-endpoints] FATAL: ${err.message}`);
  process.exit(1);
});

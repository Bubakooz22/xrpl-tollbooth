#!/usr/bin/env node
// Phase 7.1 smoke — validates /.well-known/openapi.json and /.well-known/agent.json
// served by a running tollbooth on $HOST (default http://127.0.0.1:8787).
//
// Verifies:
//   - HTTP 200
//   - Content-Type application/json
//   - Cache-Control present
//   - ETag present + conditional GET (If-None-Match) returns 304
//   - Body parses as JSON
//   - Shape: OpenAPI has openapi/info/paths, agent has schema_version/endpoints/networks
//   - Every endpoint listed in agent.json has a matching path in openapi.json
//
// Exits 0 on full pass, 1 on any failure. Prints a one-line result per check.

const HOST = process.env.HOST || "http://127.0.0.1:8787";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  const line = detail ? `${tag}  ${name}  \u2014 ${detail}` : `${tag}  ${name}`;
  console.log(line);
}

async function fetchJson(path, extraHeaders = {}) {
  const url = HOST + path;
  const r = await fetch(url, { headers: extraHeaders });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function runDoc(path, requiredKeys, label) {
  // 1) 200 + content-type
  const r1 = await fetchJson(path);
  record(`${label} \u2192 200 OK`, r1.status === 200, `status=${r1.status}`);
  const ct = r1.headers.get("content-type") || "";
  record(`${label} \u2192 Content-Type json`, ct.includes("application/json"), `ct=${ct}`);
  record(`${label} \u2192 Cache-Control present`,
    !!r1.headers.get("cache-control"),
    `cache-control=${r1.headers.get("cache-control") || "(missing)"}`);
  const etag = r1.headers.get("etag");
  record(`${label} \u2192 ETag present`, !!etag, `etag=${etag || "(missing)"}`);

  // 2) JSON parses + shape
  record(`${label} \u2192 body parses JSON`, r1.json !== null, r1.json === null ? "parse failed" : "");
  if (r1.json !== null) {
    for (const k of requiredKeys) {
      record(`${label} \u2192 key \`${k}\` present`, r1.json[k] !== undefined, "");
    }
  }

  // 3) Conditional GET
  if (etag) {
    const r2 = await fetchJson(path, { "If-None-Match": etag });
    record(`${label} \u2192 conditional GET returns 304`, r2.status === 304, `status=${r2.status}`);
  }

  return r1.json;
}

async function main() {
  console.log(`[smoke-discovery] target=${HOST}`);
  console.log("");

  const openapi = await runDoc(
    "/.well-known/openapi.json",
    ["openapi", "info", "paths", "components"],
    "openapi"
  );

  console.log("");

  const agent = await runDoc(
    "/.well-known/agent.json",
    ["schema_version", "name", "endpoints", "networks"],
    "agent"
  );

  console.log("");

  // Cross-doc consistency: every agent.endpoints[].path should exist in openapi.paths.
  if (openapi && agent && Array.isArray(agent.endpoints)) {
    const openapiPaths = new Set(Object.keys(openapi.paths || {}));
    const missing = agent.endpoints
      .map((e) => e.path)
      .filter((p) => !openapiPaths.has(p));
    record(
      "cross-doc \u2192 every agent.endpoint.path exists in openapi.paths",
      missing.length === 0,
      missing.length === 0 ? "" : `missing: ${missing.join(", ")}`
    );
  }

  // Version match
  if (openapi && agent) {
    record(
      "cross-doc \u2192 openapi.info.version === agent.version",
      openapi.info?.version === agent.version,
      `openapi=${openapi.info?.version} agent=${agent.version}`
    );
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log("");
  console.log(`[smoke-discovery] ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke-discovery] FATAL:", err);
  process.exit(2);
});

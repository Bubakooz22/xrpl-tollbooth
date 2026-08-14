#!/usr/bin/env node
// scripts/admin-key.mjs
//
// Local admin CLI for issuing / listing / revoking API keys against the
// same sqlite store used by the tollbooth server. Runs directly against
// the DB \u2014 does NOT go through HTTP \u2014 so no ADMIN_MASTER_KEY needed.
//
// Usage:
//   node scripts/admin-key.mjs create <name>
//   node scripts/admin-key.mjs list [--active]
//   node scripts/admin-key.mjs revoke <id>
//
// Env:
//   API_KEY_DB_PATH   Path to sqlite file. Default ./data/api-keys.sqlite

import {
  initApiKeyStore,
  createApiKey,
  revokeApiKey,
  listApiKeys,
} from "../lib/api-keys.mjs";

const DB_PATH = process.env.API_KEY_DB_PATH || "./data/api-keys.sqlite";
initApiKeyStore(DB_PATH);

const [, , cmd, ...rest] = process.argv;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function fmtTs(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function cmdCreate() {
  const name = rest.join(" ").trim();
  if (!name) die("usage: admin-key.mjs create <name>");
  const created = createApiKey(name);
  console.log(JSON.stringify(
    {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      key: created.plaintext,
      created_at: created.createdAt,
    },
    null,
    2
  ));
  console.error("\n\u26A0  Store this key immediately \u2014 it will never be shown again.");
}

function cmdList() {
  const includeRevoked = !rest.includes("--active");
  const keys = listApiKeys({ includeRevoked });
  if (keys.length === 0) {
    console.log("(no keys)");
    return;
  }
  const rows = keys.map((k) => ({
    id: k.id,
    prefix: k.prefix,
    name: k.name,
    active: k.active ? "yes" : "no",
    created: fmtTs(k.createdAt),
    last_used: fmtTs(k.lastUsedAt),
    revoked: fmtTs(k.revokedAt),
  }));
  console.table(rows);
}

function cmdRevoke() {
  const id = Number(rest[0]);
  if (!Number.isFinite(id) || id <= 0) die("usage: admin-key.mjs revoke <id>");
  const result = revokeApiKey(id);
  console.log(JSON.stringify(result, null, 2));
  if (!result.revoked) process.exit(2);
}

switch (cmd) {
  case "create":
    cmdCreate();
    break;
  case "list":
    cmdList();
    break;
  case "revoke":
    cmdRevoke();
    break;
  default:
    die(
      "usage:\n" +
        "  admin-key.mjs create <name>\n" +
        "  admin-key.mjs list [--active]\n" +
        "  admin-key.mjs revoke <id>"
    );
}

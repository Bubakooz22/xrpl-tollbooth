// Tests for keys.mjs — loading, validating, and the /.well-known manifest shape.

import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSigningKey } from "../lib/envelope-signer.mjs";
import { loadKeys, makePublicKeyResolver } from "../lib/keys.mjs";
import { signEnvelope, verifyEnvelope } from "../lib/envelope-signer.mjs";

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${label}`); }
}

// --- Build a temp keys dir -----------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "toll-keys-"));

const activeKp = generateSigningKey();
const retiredKp = generateSigningKey();

writeFileSync(join(dir, "tollbooth-2026-q3-01.private.pem"), activeKp.privateKeyPem, {
  mode: 0o600,
});
writeFileSync(
  join(dir, "tollbooth-2026-q3-01.meta.json"),
  JSON.stringify({
    key_id: "tollbooth-2026-q3-01",
    status: "active",
    valid_from: "2026-07-01T00:00:00Z",
    valid_until: "2026-10-01T00:00:00Z",
  }),
);
writeFileSync(join(dir, "tollbooth-2026-q2-01.private.pem"), retiredKp.privateKeyPem, {
  mode: 0o600,
});
writeFileSync(
  join(dir, "tollbooth-2026-q2-01.meta.json"),
  JSON.stringify({
    key_id: "tollbooth-2026-q2-01",
    status: "retired",
    valid_from: "2026-04-01T00:00:00Z",
    valid_until: "2026-07-01T00:00:00Z",
  }),
);

// --- Load ----------------------------------------------------------------
const loaded = loadKeys({ keysDir: dir });
ok("loaded 2 keys", loaded.all.length === 2);
ok("active key correct", loaded.active?.key_id === "tollbooth-2026-q3-01");
ok("private keys map populated", loaded.privateKeys.size === 2);
ok("public keys map populated", loaded.publicKeys.size === 2);

// --- Manifest shape ------------------------------------------------------
ok("manifest has 2 keys", loaded.manifest.keys.length === 2);
ok(
  "manifest sorted by valid_from",
  loaded.manifest.keys[0].valid_from === "2026-04-01T00:00:00Z" &&
    loaded.manifest.keys[1].valid_from === "2026-07-01T00:00:00Z",
);
for (const k of loaded.manifest.keys) {
  ok(`manifest entry ${k.key_id} has base64 public_key`,
     typeof k.public_key === "string" && Buffer.from(k.public_key, "base64").length === 32);
  ok(`manifest entry ${k.key_id} advertises Ed25519`, k.alg === "Ed25519");
}

// --- Sign+verify using the resolver-from-loaded-keys ---------------------
const resolver = makePublicKeyResolver(loaded.publicKeys);
const env = {
  version: "0.8", endpoint: "/wallet-risk", request_hash: "x",
  risk_level: "safe", reason_codes: [],
  fulfillment_status: "complete", retry_permitted: false, retry_after_seconds: null,
  issued_at: "2026-08-26T13:30:00.000Z", expires_at: "2026-08-27T13:30:00.000Z",
};
const signed = signEnvelope(env, loaded.active);
const v = verifyEnvelope(signed, resolver);
ok("sign+verify via loaded active key", v.valid === true);

// --- Failure: no active key ---------------------------------------------
{
  const bad = mkdtempSync(join(tmpdir(), "toll-keys-bad-"));
  writeFileSync(join(bad, "k.private.pem"), retiredKp.privateKeyPem);
  writeFileSync(
    join(bad, "k.meta.json"),
    JSON.stringify({ key_id: "k", status: "retired", valid_from: "2020-01-01T00:00:00Z", valid_until: "2020-04-01T00:00:00Z" }),
  );
  try {
    loadKeys({ keysDir: bad });
    fail++; console.error("FAIL: should throw when no active key");
  } catch (e) { ok("throws when no active key", e.message.includes("no active key")); }
  rmSync(bad, { recursive: true, force: true });
}

// --- Failure: two active keys -------------------------------------------
{
  const bad = mkdtempSync(join(tmpdir(), "toll-keys-2active-"));
  writeFileSync(join(bad, "a.private.pem"), activeKp.privateKeyPem);
  writeFileSync(
    join(bad, "a.meta.json"),
    JSON.stringify({ key_id: "a", status: "active", valid_from: "2026-07-01T00:00:00Z", valid_until: "2026-10-01T00:00:00Z" }),
  );
  writeFileSync(join(bad, "b.private.pem"), retiredKp.privateKeyPem);
  writeFileSync(
    join(bad, "b.meta.json"),
    JSON.stringify({ key_id: "b", status: "active", valid_from: "2026-04-01T00:00:00Z", valid_until: "2026-07-01T00:00:00Z" }),
  );
  try {
    loadKeys({ keysDir: bad });
    fail++; console.error("FAIL: should throw with two active keys");
  } catch (e) { ok("throws with two active keys", e.message.includes("more than one key marked active")); }
  rmSync(bad, { recursive: true, force: true });
}

// Cleanup.
rmSync(dir, { recursive: true, force: true });

console.log(`keys: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

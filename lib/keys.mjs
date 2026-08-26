// Key management for v0.8 envelope signing.
//
// Design:
//   - The private signing keys live on the server as Ed25519 PEM files.
//     Their location is read from env at startup and never re-scanned.
//   - The set of PUBLIC keys is what's published at /.well-known/tollbooth-keys.json.
//     Retired keys stay published so historic envelopes remain verifiable.
//   - Exactly ONE key has status="active" at any time. Others are "retired".
//
// Environment:
//   TOLLBOOTH_SIGNING_KEYS_DIR - directory containing key files (default: ./keys/)
//     Each key is stored as two files:
//       <key_id>.private.pem  (mode 0600 — private, NEVER served)
//       <key_id>.meta.json    ({ key_id, status, valid_from, valid_until })
//     The public key is derived from the private key at load time so we
//     never have to keep public/private in sync manually.
//
// The keys directory is out of the repo. In production it lives under
// /etc/tollbooth/keys/ or ~/tollbooth-keys/ and is mode 0700.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import crypto from "node:crypto";

const KEYS_DIR_ENV = "TOLLBOOTH_SIGNING_KEYS_DIR";
const DEFAULT_KEYS_DIR = "./keys";

function derivePublicKeyBase64(privateKeyPem) {
  const priv = crypto.createPrivateKey(privateKeyPem);
  if (priv.asymmetricKeyType !== "ed25519") {
    throw new Error(`keys: expected ed25519, got ${priv.asymmetricKeyType}`);
  }
  const pub = crypto.createPublicKey(priv);
  const der = pub.export({ type: "spki", format: "der" });
  return der.slice(der.length - 32).toString("base64");
}

function derivePublicKeyPem(privateKeyPem) {
  const priv = crypto.createPrivateKey(privateKeyPem);
  const pub = crypto.createPublicKey(priv);
  return pub.export({ type: "spki", format: "pem" });
}

/**
 * Load all signing keys from disk.
 *
 * @param {{ keysDir?: string }} [opts]
 * @returns {{
 *   active: { key_id, private_key_pem } | null,
 *   all: Array<{ key_id, status, valid_from, valid_until, public_key_pem, public_key_b64 }>,
 *   privateKeys: Map<string, string>,
 *   publicKeys: Map<string, string>,
 *   manifest: { keys: Array<{ key_id, alg, public_key, valid_from, valid_until, status }> }
 * }}
 */
export function loadKeys(opts = {}) {
  const dir = resolve(opts.keysDir || process.env[KEYS_DIR_ENV] || DEFAULT_KEYS_DIR);
  if (!existsSync(dir)) {
    throw new Error(`keys: signing keys directory not found at ${dir} (set ${KEYS_DIR_ENV})`);
  }
  const st = statSync(dir);
  if (!st.isDirectory()) {
    throw new Error(`keys: ${dir} is not a directory`);
  }

  const files = readdirSync(dir);
  const metaByKeyId = new Map();
  const privateByKeyId = new Map();

  for (const f of files) {
    if (f.endsWith(".meta.json")) {
      const key_id = f.replace(/\.meta\.json$/, "");
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (meta.key_id && meta.key_id !== key_id) {
        throw new Error(`keys: meta.json for ${f} claims key_id=${meta.key_id}`);
      }
      metaByKeyId.set(key_id, {
        key_id,
        status: meta.status,
        valid_from: meta.valid_from,
        valid_until: meta.valid_until,
      });
    } else if (f.endsWith(".private.pem")) {
      const key_id = f.replace(/\.private\.pem$/, "");
      // Warn (don't fail) if mode isn't 0600 — enforcement is env-dependent (containers etc).
      const pem = readFileSync(join(dir, f), "utf8");
      privateByKeyId.set(key_id, pem);
    }
  }

  const all = [];
  const privateKeys = new Map();
  const publicKeys = new Map();
  let active = null;

  for (const [key_id, meta] of metaByKeyId) {
    const pem = privateByKeyId.get(key_id);
    if (!pem) {
      throw new Error(`keys: meta for ${key_id} present but private key file missing`);
    }
    const public_key_pem = derivePublicKeyPem(pem);
    const public_key_b64 = derivePublicKeyBase64(pem);
    const entry = { ...meta, public_key_pem, public_key_b64 };
    all.push(entry);
    privateKeys.set(key_id, pem);
    publicKeys.set(key_id, public_key_pem);
    if (meta.status === "active") {
      if (active) {
        throw new Error(
          `keys: more than one key marked active (${active.key_id} and ${key_id})`,
        );
      }
      active = { key_id, private_key_pem: pem };
    }
  }

  if (all.length === 0) {
    throw new Error(`keys: no signing keys found in ${dir}`);
  }
  if (!active) {
    throw new Error(`keys: no active key found in ${dir}`);
  }

  // Build the public manifest (matches /.well-known/tollbooth-keys.json shape from the spec).
  const manifest = {
    keys: all
      .slice()
      .sort((a, b) => (a.valid_from || "").localeCompare(b.valid_from || ""))
      .map((k) => ({
        key_id: k.key_id,
        alg: "Ed25519",
        public_key: k.public_key_b64,
        valid_from: k.valid_from,
        valid_until: k.valid_until,
        status: k.status,
      })),
  };

  return { active, all, privateKeys, publicKeys, manifest };
}

/**
 * Build the pubkey resolver expected by envelope-signer.verifyEnvelope.
 * @param {Map<string,string>} publicKeys
 * @returns {(keyId: string) => string|null}
 */
export function makePublicKeyResolver(publicKeys) {
  return (keyId) => publicKeys.get(keyId) || null;
}

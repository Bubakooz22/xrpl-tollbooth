// lib/api-keys.mjs
//
// API key issuance, storage, and verification.
//
// Design:
//   - Keys are of the form `tb_live_<32 hex chars>` (128 bits of entropy).
//   - We store sha256(key) in sqlite, never the plaintext. On lookup we
//     hash the presented key and query by hash.
//   - Keys can be revoked; a revoked key returns 401 forever.
//   - No key rotation endpoint in v1; issue a new key and revoke the old.
//
// Schema (single table):
//   api_keys(
//     id            INTEGER PRIMARY KEY AUTOINCREMENT,
//     key_hash      TEXT UNIQUE NOT NULL,   -- sha256(plaintext) hex
//     key_prefix    TEXT NOT NULL,          -- first 12 chars for display
//     name          TEXT NOT NULL,          -- human label
//     created_at    INTEGER NOT NULL,       -- unix seconds
//     last_used_at  INTEGER,                -- unix seconds, nullable
//     revoked_at    INTEGER                 -- unix seconds, nullable
//   )
//
// Not covered here (deferred to later Phase 6.x):
//   - Per-key monthly caps (column exists but not enforced)
//   - IP allowlisting
//   - Key rotation with grace window
//   - Audit log of admin actions

import { randomBytes, createHash } from "node:crypto";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const KEY_PREFIX = "tb_live_";
const KEY_HEX_LEN = 32; // 128 bits of entropy

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

let db = null;

/**
 * Initialize the sqlite database at the given path. Idempotent.
 * Creates the parent directory and runs migrations if needed.
 */
export function initApiKeyStore(dbPath) {
  if (db) return db;
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash      TEXT UNIQUE NOT NULL,
      key_prefix    TEXT NOT NULL,
      name          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
  return db;
}

function requireDb() {
  if (!db) {
    throw new Error("api-keys: initApiKeyStore(dbPath) must be called first");
  }
  return db;
}

// ---------------------------------------------------------------------------
// Key generation and hashing
// ---------------------------------------------------------------------------

function generateKeyPlaintext() {
  return KEY_PREFIX + randomBytes(KEY_HEX_LEN / 2).toString("hex");
}

function hashKey(plaintext) {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function keyPrefix(plaintext) {
  return plaintext.slice(0, 12); // e.g. "tb_live_a1b2"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new API key. Returns { id, plaintext, prefix, name, createdAt }.
 * The plaintext is returned exactly once — the caller must show it to the
 * end user immediately; we don't store it.
 */
export function createApiKey(name) {
  const d = requireDb();
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("api_key_name_required");
  if (trimmed.length > 128) throw new Error("api_key_name_too_long");

  const plaintext = generateKeyPlaintext();
  const hash = hashKey(plaintext);
  const prefix = keyPrefix(plaintext);
  const createdAt = Math.floor(Date.now() / 1000);

  const result = d
    .prepare(
      "INSERT INTO api_keys (key_hash, key_prefix, name, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(hash, prefix, trimmed, createdAt);

  return {
    id: result.lastInsertRowid,
    plaintext,
    prefix,
    name: trimmed,
    createdAt,
  };
}

/**
 * Look up a key by plaintext. Returns the row if valid+active, else null.
 * Updates last_used_at on hit. Never returns the key_hash or plaintext.
 */
export function verifyApiKey(plaintext) {
  if (typeof plaintext !== "string" || !plaintext.startsWith(KEY_PREFIX)) {
    return null;
  }
  const d = requireDb();
  const hash = hashKey(plaintext);
  const row = d
    .prepare(
      "SELECT id, key_prefix, name, created_at, last_used_at, revoked_at FROM api_keys WHERE key_hash = ?"
    )
    .get(hash);
  if (!row) return null;
  if (row.revoked_at != null) return null;

  const now = Math.floor(Date.now() / 1000);
  d.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);

  return {
    id: row.id,
    prefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: now,
  };
}

/**
 * Revoke a key by id. Idempotent. Returns { revoked: boolean, id }.
 */
export function revokeApiKey(id) {
  const d = requireDb();
  const now = Math.floor(Date.now() / 1000);
  const result = d
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    )
    .run(now, id);
  return { revoked: result.changes > 0, id };
}

/**
 * List all keys (metadata only, never the hash). Sorted newest first.
 * Filter with { includeRevoked: false } to hide revoked keys.
 */
export function listApiKeys({ includeRevoked = true } = {}) {
  const d = requireDb();
  const where = includeRevoked ? "" : "WHERE revoked_at IS NULL";
  const rows = d
    .prepare(
      `SELECT id, key_prefix, name, created_at, last_used_at, revoked_at
       FROM api_keys ${where}
       ORDER BY id DESC`
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    prefix: r.key_prefix,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    active: r.revoked_at == null,
  }));
}

/**
 * For tests: wipe the store. NEVER call from a route handler.
 */
export function _resetForTests() {
  const d = requireDb();
  d.exec("DELETE FROM api_keys");
}

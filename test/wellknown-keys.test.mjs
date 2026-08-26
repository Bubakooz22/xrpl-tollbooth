// v0.8 /.well-known/tollbooth-keys.json endpoint tests.
//
// These tests spin up the tollbooth process in a child process, hit the
// endpoint over real HTTP, and assert the manifest shape, ETag caching,
// and 503-when-disabled behavior.
//
// We do NOT import tollbooth.mjs directly — that module reads env at load
// time and initializes the facilitator, which needs network. Child-process
// isolation lets us mock TOLL_* env cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TOLLBOOTH_ENTRY = path.join(REPO_ROOT, "tollbooth.mjs");

// Minimum port range picked to not collide with the dev server on 8787.
const TEST_PORT_BASE = 19100;
let portCounter = 0;
function nextPort() {
  return TEST_PORT_BASE + portCounter++;
}

// Spin up a throwaway facilitator that answers /supported with an XRPL scheme.
// Without this the real server exits on startup because facilitator discovery
// fails. This is the smallest thing that lets tollbooth boot in isolation.
function startFakeFacilitator(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/supported") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            x402Version: 2,
            kinds: [{ scheme: "xrpl-native", network: "xrpl-mainnet" }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function makeKey({ key_id, status }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).slice(-32);
  return {
    key_id,
    status,
    algorithm: "Ed25519",
    public_key_b64: rawPub.toString("base64"),
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
}

function makeKeysDir({ withActive = true, extraStatuses = [] } = {}) {
  const dir = path.join(REPO_ROOT, `.tmp-keys-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const nowIso = new Date().toISOString();
  const keys = [];
  if (withActive) {
    keys.push(makeKey({ key_id: "tb-2026-08a", status: "active" }));
  }
  let idx = 0;
  for (const status of extraStatuses) {
    keys.push(
      makeKey({
        key_id: `tb-${status}-${(idx++).toString().padStart(3, "0")}`,
        status,
      }),
    );
  }
  for (const k of keys) {
    const pemPath = path.join(dir, `${k.key_id}.private.pem`);
    writeFileSync(pemPath, k.privatePem, { mode: 0o600 });
    chmodSync(pemPath, 0o600);
    writeFileSync(
      path.join(dir, `${k.key_id}.meta.json`),
      JSON.stringify(
        {
          key_id: k.key_id,
          status: k.status,
          valid_from: nowIso,
          valid_until: null,
        },
        null,
        2,
      ),
    );
  }
  return { dir, keys };
}

// Spawn the tollbooth server as a child process. Returns {url, cleanup}.
async function startTollbooth({ v08Enabled, keysDir }) {
  const port = nextPort();
  const facilitatorPort = nextPort();
  const facilitator = await startFakeFacilitator(facilitatorPort);

  const env = {
    ...process.env,
    TOLL_DESTINATION: "rDummyTestDestinationAddressXXXXXXXX",
    TOLL_PRICE_DROPS: "1000",
    FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
    PORT: String(port),
    API_KEY_DB_PATH: `:memory:`,
  };
  if (v08Enabled) env.TOLLBOOTH_V08_ENABLED = "1";
  if (keysDir) env.TOLLBOOTH_SIGNING_KEYS_DIR = keysDir;

  const child = spawn("node", [TOLLBOOTH_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });

  // Wait for the "listening on" line.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tollbooth boot timeout")), 8000);
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("tollbooth listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      // Fatal boot failure — surface it.
      if (stderrBuf.includes("FATAL")) {
        clearTimeout(timer);
        reject(new Error(`tollbooth boot failed: ${stderrBuf}`));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`tollbooth exited early: code=${code} stderr=${stderrBuf}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async cleanup() {
      child.kill();
      await new Promise((r) => child.on("exit", r));
      facilitator.close();
    },
  };
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), body: text };
}

test("v0.8 disabled by default: /.well-known/tollbooth-keys.json returns 503", async () => {
  const { url, cleanup } = await startTollbooth({ v08Enabled: false });
  try {
    const res = await httpGet(`${url}/.well-known/tollbooth-keys.json`);
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "v08_not_enabled");
  } finally {
    await cleanup();
  }
});

test("v0.8 enabled with active key: manifest served, correct headers", async () => {
  const { dir, keys } = makeKeysDir();
  const activeKey = keys.find((k) => k.status === "active");
  const { url, cleanup } = await startTollbooth({ v08Enabled: true, keysDir: dir });
  try {
    const res = await httpGet(`${url}/.well-known/tollbooth-keys.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.match(res.headers["cache-control"], /max-age=300/);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.match(res.headers["etag"], /^W\/"[a-f0-9]{16}"$/);

    const manifest = JSON.parse(res.body);
    assert.ok(Array.isArray(manifest.keys), "keys array present");
    assert.equal(manifest.keys.length, 1);
    assert.equal(manifest.keys[0].key_id, activeKey.key_id);
    assert.equal(manifest.keys[0].status, "active");
    assert.equal(manifest.keys[0].alg, "Ed25519");
    assert.equal(manifest.keys[0].public_key, activeKey.public_key_b64);
  } finally {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ETag If-None-Match returns 304 on match", async () => {
  const { dir } = makeKeysDir();
  const { url, cleanup } = await startTollbooth({ v08Enabled: true, keysDir: dir });
  try {
    const first = await httpGet(`${url}/.well-known/tollbooth-keys.json`);
    assert.equal(first.status, 200);
    const etag = first.headers["etag"];
    assert.ok(etag);

    const cached = await httpGet(`${url}/.well-known/tollbooth-keys.json`, {
      "If-None-Match": etag,
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body, "");
    assert.equal(cached.headers["etag"], etag);
  } finally {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Retired keys are included in manifest so historic envelopes verify", async () => {
  const { dir, keys } = makeKeysDir({ withActive: true, extraStatuses: ["retired", "retired"] });
  const { url, cleanup } = await startTollbooth({ v08Enabled: true, keysDir: dir });
  try {
    const res = await httpGet(`${url}/.well-known/tollbooth-keys.json`);
    assert.equal(res.status, 200);
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.keys.length, 3, "1 active + 2 retired");

    const statuses = manifest.keys.map((k) => k.status).sort();
    assert.deepEqual(statuses, ["active", "retired", "retired"]);
  } finally {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest is deterministic across two boots with the same keys dir", async () => {
  const { dir } = makeKeysDir();

  const boot1 = await startTollbooth({ v08Enabled: true, keysDir: dir });
  const res1 = await httpGet(`${boot1.url}/.well-known/tollbooth-keys.json`);
  await boot1.cleanup();

  const boot2 = await startTollbooth({ v08Enabled: true, keysDir: dir });
  const res2 = await httpGet(`${boot2.url}/.well-known/tollbooth-keys.json`);
  await boot2.cleanup();

  assert.equal(res1.body, res2.body, "manifest bytes identical across boots");
  assert.equal(res1.headers["etag"], res2.headers["etag"], "ETag stable across boots");

  rmSync(dir, { recursive: true, force: true });
});

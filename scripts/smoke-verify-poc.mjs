#!/usr/bin/env node
// scripts/smoke-verify-poc.mjs
//
// End-to-end smoke test for POST /verify-poc. Runs on the droplet (needs
// forge on PATH). Sends 3 base64-encoded fixture files, asserts:
//
//   1. simple-pass.t.sol       + expected="pass"   \u2192 verified=true
//   2. fork-transfer.t.sol     + expected="pass"   \u2192 verified=true
//   3. expect-revert.t.sol     + expected="revert" \u2192 verified=true
//
// Then two adversarial cases:
//   4. simple-pass.t.sol       + expected="revert" \u2192 verified=false
//   5. malformed \u2014 ffi()       \u2192 400 FFI_DISALLOWED
//
// Env:
//   TOLLBOOTH_URL   default http://127.0.0.1:8787
//   API_KEY         required \u2014 raw `tb_live_...` key issued via admin API
//
// Usage:
//   API_KEY=tb_live_... node scripts/smoke-verify-poc.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "verify-poc");

const BASE = process.env.TOLLBOOTH_URL || "http://127.0.0.1:8787";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY env is required (raw tb_live_... key)");
  process.exit(2);
}

let passed = 0;
let failed = 0;

async function loadFixtureBase64(name) {
  const raw = await readFile(path.join(FIXTURES, name), "utf8");
  return Buffer.from(raw, "utf8").toString("base64");
}

async function postVerify(payload) {
  const res = await fetch(`${BASE}/verify-poc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _rawText: text };
  }
  return { status: res.status, body };
}

function assertCase(name, cond, detail) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } else {
    console.log(`  \u2717 ${name}`);
    if (detail) console.log(`    ${JSON.stringify(detail).slice(0, 400)}`);
    failed += 1;
  }
}

async function main() {
  console.log(`[smoke-verify-poc] target=${BASE}`);

  // Case 1: simple pass grades as pass
  {
    console.log("\n[1] simple-pass.t.sol + expected=pass");
    const test_file = await loadFixtureBase64("simple-pass.t.sol");
    const { status, body } = await postVerify({
      test_file,
      chain: "eth",
      expected_result: "pass",
    });
    assertCase("HTTP 200", status === 200, { status, body });
    assertCase("verified=true", body.verified === true, body);
    assertCase("actual=pass", body.actual === "pass", body);
    assertCase(
      "reason_codes has POC_VERIFIED",
      Array.isArray(body.reason_codes) && body.reason_codes.includes("POC_VERIFIED"),
      body,
    );
  }

  // Case 2: forked deal + transfer grades as pass
  {
    console.log("\n[2] fork-transfer.t.sol + expected=pass");
    const test_file = await loadFixtureBase64("fork-transfer.t.sol");
    const { status, body } = await postVerify({
      test_file,
      chain: "eth",
      expected_result: "pass",
    });
    assertCase("HTTP 200", status === 200, { status, body });
    assertCase("verified=true", body.verified === true, body);
    assertCase("actual=pass", body.actual === "pass", body);
    assertCase("fork_block set", Number.isFinite(body.fork_block), body);
  }

  // Case 3: assert(1==2) grades as revert when expected=revert
  {
    console.log("\n[3] expect-revert.t.sol + expected=revert");
    const test_file = await loadFixtureBase64("expect-revert.t.sol");
    const { status, body } = await postVerify({
      test_file,
      chain: "eth",
      expected_result: "revert",
    });
    assertCase("HTTP 200", status === 200, { status, body });
    assertCase("verified=true", body.verified === true, body);
    assertCase("actual=revert", body.actual === "revert", body);
  }

  // Case 4: passing test with expected=revert must grade as unverified
  {
    console.log("\n[4] simple-pass.t.sol + expected=revert (mismatch)");
    const test_file = await loadFixtureBase64("simple-pass.t.sol");
    const { status, body } = await postVerify({
      test_file,
      chain: "eth",
      expected_result: "revert",
    });
    assertCase("HTTP 200", status === 200, { status, body });
    assertCase("verified=false", body.verified === false, body);
    assertCase("actual=pass", body.actual === "pass", body);
    assertCase(
      "reason_codes has POC_UNVERIFIED",
      Array.isArray(body.reason_codes) && body.reason_codes.includes("POC_UNVERIFIED"),
      body,
    );
  }

  // Case 5: ffi() disallowed by policy
  {
    console.log("\n[5] ffi() adversarial \u2192 400 FFI_DISALLOWED");
    const badSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
contract Bad is Test {
  function testFfi() public {
    string[] memory cmd = new string[](1);
    cmd[0] = "echo";
    vm.ffi(cmd);
  }
}`;
    const test_file = Buffer.from(badSource, "utf8").toString("base64");
    const { status, body } = await postVerify({
      test_file,
      chain: "eth",
      expected_result: "pass",
    });
    assertCase("HTTP 400", status === 400, { status, body });
    assertCase(
      "reason_codes has FFI_DISALLOWED",
      Array.isArray(body.reason_codes) && body.reason_codes.includes("FFI_DISALLOWED"),
      body,
    );
  }

  // Case 6: missing test_file
  {
    console.log("\n[6] missing test_file \u2192 400 MISSING_TEST_FILE");
    const { status, body } = await postVerify({
      chain: "eth",
      expected_result: "pass",
    });
    assertCase("HTTP 400", status === 400, { status, body });
    assertCase(
      "reason_codes has MISSING_TEST_FILE",
      Array.isArray(body.reason_codes) && body.reason_codes.includes("MISSING_TEST_FILE"),
      body,
    );
  }

  console.log(`\n[smoke-verify-poc] passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke-verify-poc] fatal:", err);
  process.exit(2);
});

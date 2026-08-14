// lib/verify-poc.mjs
//
// PoC verification via ephemeral Foundry sandbox.
//
// Flow:
//   1. mkdtemp('/tmp/verify-poc-<uuid>')
//   2. Write foundry.toml (ffi disabled, fs read/write disabled)
//   3. Write test/PoC.t.sol from the base64-decoded input
//   4. Spawn `forge test --fork-url <rpc> --fork-block-number <n> --json`
//      with a hard 120s AbortController timeout
//   5. Parse JSON from stdout (skipping compiler warnings that precede it)
//   6. Grade: verified = (actual outcome == expected_result)
//   7. rm -rf sandbox in finally
//
// Design constraints locked at 6.1:
//   - Single-file only. Multi-file / OZ imports = Phase 6.2.
//   - Only forge-std is available (installed once at server-boot into a shared cache).
//   - ffi: false in foundry.toml. User cannot override.
//   - Ethereum mainnet only. Chain toggle exists but only "eth" is accepted.
//   - No Docker. Sandbox is a temp dir + subprocess. Phase 6.3 hardens.
//
// forge test --json output (Foundry 1.7.x):
//   {
//     "<file>:<Contract>": {
//       "test_results": {
//         "testX()": {
//           "success": bool,
//           "reason": string|null,
//           "logs": [...],
//           "kind": { "Standard": gasUsed } | { "Fuzz": {...} },
//           "traces": [...]
//         }
//       }
//     }
//   }

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HARD_TIMEOUT_MS = 120_000;
const MAX_TEST_FILE_BYTES = 128 * 1024; // 128 KB \u2014 auditors' PoCs are far smaller
const FOUNDRY_BIN = process.env.FOUNDRY_BIN || "forge";
const DEFAULT_RPC = "https://ethereum.publicnode.com";
const FORGE_STD_CACHE = process.env.FORGE_STD_CACHE || "/tmp/verify-poc-cache/forge-std";

// ---------------------------------------------------------------------------
// forge-std bootstrapping (once per process)
// ---------------------------------------------------------------------------

let forgeStdReady = null;

/**
 * Ensure forge-std is cloned into FORGE_STD_CACHE. Idempotent, no-op after
 * first successful call. Uses `git clone --depth 1` so the shared cache
 * stays tiny (~2MB).
 */
async function ensureForgeStd() {
  if (forgeStdReady) return forgeStdReady;
  forgeStdReady = (async () => {
    if (existsSync(path.join(FORGE_STD_CACHE, "src", "Test.sol"))) return;
    await mkdir(path.dirname(FORGE_STD_CACHE), { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn(
        "git",
        ["clone", "--depth", "1", "https://github.com/foundry-rs/forge-std", FORGE_STD_CACHE],
        { stdio: "pipe" }
      );
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`git clone forge-std failed: ${stderr}`))
      );
      p.on("error", reject);
    });
  })();
  return forgeStdReady;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a Foundry PoC. Never throws \u2014 always returns a shaped result
 * with `verified` + `reason_codes[]`. Callers write status codes based
 * on the reason codes (400 for compile errors, 200 for verified/unverified).
 *
 * @param {object} input
 * @param {string} input.test_file_b64  Base64 of the .t.sol content
 * @param {string} [input.chain]        Only "eth" supported in 6.1
 * @param {number} [input.fork_block]   Block number; latest if omitted
 * @param {string} [input.expected_result]  "pass" | "revert" (default "pass")
 * @param {string} [input.solidity_version] Ignored in 6.1 (forge picks from source)
 * @param {string} [input.rpc_url]      Override upstream RPC
 */
export async function verifyPoc(input = {}) {
  const startedAt = Date.now();
  const result = {
    verified: false,
    expected: null,
    actual: null,
    test_name: null,
    gas_used: null,
    logs: [],
    traces_head: null,
    fork_block: null,
    duration_ms: 0,
    reason_codes: [],
    notes: [],
  };

  // ----- validate inputs -----
  const chain = input.chain || "eth";
  if (chain !== "eth") {
    result.reason_codes.push("UNSUPPORTED_CHAIN");
    result.notes.push(`chain=${chain} not supported in 6.1 (eth only)`);
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  const expected = input.expected_result || "pass";
  if (expected !== "pass" && expected !== "revert") {
    result.reason_codes.push("INVALID_EXPECTED_RESULT");
    result.notes.push(`expected_result must be "pass" or "revert", got ${expected}`);
    result.duration_ms = Date.now() - startedAt;
    return result;
  }
  result.expected = expected;

  if (typeof input.test_file_b64 !== "string" || input.test_file_b64.length === 0) {
    result.reason_codes.push("MISSING_TEST_FILE");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  let testSource;
  try {
    const buf = Buffer.from(input.test_file_b64, "base64");
    if (buf.length > MAX_TEST_FILE_BYTES) {
      result.reason_codes.push("TEST_FILE_TOO_LARGE");
      result.notes.push(`test file is ${buf.length} bytes, limit ${MAX_TEST_FILE_BYTES}`);
      result.duration_ms = Date.now() - startedAt;
      return result;
    }
    testSource = buf.toString("utf8");
  } catch (err) {
    result.reason_codes.push("INVALID_BASE64");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  // Cheap safety filter: block obvious dangerous cheatcodes.
  // Deep sandboxing comes in Phase 6.3 (Docker). This is defense-in-depth.
  const banned = [
    { re: /\bffi\s*\(/, code: "FFI_DISALLOWED", msg: "vm.ffi() disabled by policy" },
    { re: /\bwriteFile\s*\(/, code: "FS_WRITE_DISALLOWED", msg: "vm.writeFile disabled by policy" },
    { re: /\bsetEnv\s*\(/, code: "ENV_WRITE_DISALLOWED", msg: "vm.setEnv disabled by policy" },
    { re: /\bcloseFile\s*\(/, code: "FS_WRITE_DISALLOWED", msg: "vm.closeFile disabled by policy" },
    { re: /\bremoveFile\s*\(/, code: "FS_WRITE_DISALLOWED", msg: "vm.removeFile disabled by policy" },
  ];
  for (const { re, code, msg } of banned) {
    if (re.test(testSource)) {
      result.reason_codes.push(code);
      result.notes.push(msg);
      result.duration_ms = Date.now() - startedAt;
      return result;
    }
  }

  // ----- ensure forge-std is cached -----
  try {
    await ensureForgeStd();
  } catch (err) {
    result.reason_codes.push("FORGE_STD_BOOTSTRAP_FAILED");
    result.notes.push(err.message);
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  // ----- sandbox setup -----
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "verify-poc-"));
  try {
    await mkdir(path.join(sandbox, "test"), { recursive: true });
    await mkdir(path.join(sandbox, "src"), { recursive: true });
    await mkdir(path.join(sandbox, "lib"), { recursive: true });

    // symlink forge-std into lib/ so the standard `forge-std/Test.sol` import works
    await new Promise((resolve, reject) => {
      const p = spawn("ln", ["-s", FORGE_STD_CACHE, path.join(sandbox, "lib", "forge-std")]);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ln forge-std failed"))));
      p.on("error", reject);
    });

    // foundry.toml \u2014 ffi disabled, no fs_permissions
    const foundryToml = [
      "[profile.default]",
      'src = "src"',
      'test = "test"',
      'out = "out"',
      'libs = ["lib"]',
      "ffi = false",
      'solc_version = "0.8.28"',
      "auto_detect_solc = true",
      "optimizer = false",
      "",
    ].join("\n");
    await writeFile(path.join(sandbox, "foundry.toml"), foundryToml);
    await writeFile(path.join(sandbox, "remappings.txt"), "forge-std/=lib/forge-std/src/\n");
    await writeFile(path.join(sandbox, "test", "PoC.t.sol"), testSource);

    // ----- resolve fork block if unspecified -----
    const rpc = input.rpc_url || process.env.SIM_RPC_ETH_MAINNET || DEFAULT_RPC;
    let forkBlock = Number.isFinite(input.fork_block) ? Math.floor(input.fork_block) : null;
    if (!forkBlock) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          signal: AbortSignal.timeout(10_000),
        });
        const j = await res.json();
        forkBlock = parseInt(j.result, 16);
      } catch (err) {
        result.reason_codes.push("RPC_UNREACHABLE");
        result.notes.push(`could not resolve latest block from ${rpc}: ${err.message}`);
        result.duration_ms = Date.now() - startedAt;
        return result;
      }
    }
    result.fork_block = forkBlock;

    // ----- forge test --json --fork-url ... --fork-block-number ... -----
    const args = [
      "test",
      "--fork-url", rpc,
      "--fork-block-number", String(forkBlock),
      "-vvv",
      "--json",
      "--no-cache",
    ];

    const forgeOut = await runWithTimeout(FOUNDRY_BIN, args, sandbox, HARD_TIMEOUT_MS);

    if (forgeOut.timedOut) {
      result.reason_codes.push("TIMEOUT");
      result.notes.push(`forge test exceeded ${HARD_TIMEOUT_MS}ms`);
      result.duration_ms = Date.now() - startedAt;
      return result;
    }

    // Foundry writes compiler noise before the JSON blob. Find the first { at
    // start of a line that starts a valid JSON object.
    const parsed = parseForgeJson(forgeOut.stdout);
    if (!parsed.ok) {
      // Check stderr for compile errors first \u2014 those are actionable
      const stderrHead = (forgeOut.stderr || "").slice(0, 2000);
      const looksLikeCompileError =
        /error\[/i.test(forgeOut.stderr) ||
        /error\[/i.test(forgeOut.stdout) ||
        /ParserError/i.test(forgeOut.stdout);
      if (looksLikeCompileError) {
        result.reason_codes.push("COMPILE_ERROR");
        result.notes.push(extractCompilerErrors(forgeOut.stdout, forgeOut.stderr));
      } else {
        result.reason_codes.push("PARSE_FAILURE");
        result.notes.push(`could not parse forge --json output: ${parsed.error}`);
        result.notes.push(`stderr head: ${stderrHead.slice(0, 500)}`);
      }
      result.duration_ms = Date.now() - startedAt;
      return result;
    }

    // ----- extract a single test result -----
    const grade = gradeResults(parsed.data, expected);
    result.test_name = grade.test_name;
    result.actual = grade.actual;
    result.verified = grade.verified;
    result.gas_used = grade.gas_used;
    result.logs = grade.logs;
    result.traces_head = grade.traces_head;

    if (grade.reason_code) {
      result.reason_codes.push(grade.reason_code);
    }
    if (grade.notes) result.notes.push(...grade.notes);

    // Primary success/fail reason code
    if (result.reason_codes.length === 0) {
      result.reason_codes.push(result.verified ? "POC_VERIFIED" : "POC_UNVERIFIED");
    }

    result.duration_ms = Date.now() - startedAt;
    return result;
  } catch (err) {
    result.reason_codes.push("INTERNAL_ERROR");
    result.notes.push(err.message);
    result.duration_ms = Date.now() - startedAt;
    return result;
  } finally {
    // best-effort cleanup
    try {
      await rm(sandbox, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Subprocess with hard timeout
// ---------------------------------------------------------------------------

function runWithTimeout(bin, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const p = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        // Force non-interactive
        FOUNDRY_DISABLE_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
      signal: controller.signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));

    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, signal, timedOut });
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: -1, signal: null, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Forge JSON parser \u2014 strips compiler warnings preceding the JSON blob
// ---------------------------------------------------------------------------

function parseForgeJson(stdout) {
  if (!stdout) return { ok: false, error: "empty stdout" };
  // The JSON blob starts with `{"` at the start of a line and is on ONE line.
  // Walk lines and try each candidate.
  const lines = stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return { ok: true, data: parsed };
      }
    } catch {}
  }
  return { ok: false, error: "no valid JSON object found on any line" };
}

// ---------------------------------------------------------------------------
// Grade the single test result against expected outcome
// ---------------------------------------------------------------------------

function gradeResults(data, expected) {
  const out = {
    verified: false,
    actual: null,
    test_name: null,
    gas_used: null,
    logs: [],
    traces_head: null,
    reason_code: null,
    notes: [],
  };

  // Data shape: { "test/PoC.t.sol:PoCTest": { test_results: { "testX()": {...} } } }
  const suites = Object.entries(data);
  if (suites.length === 0) {
    out.reason_code = "NO_TESTS_FOUND";
    return out;
  }

  // Pick the first (and typically only) suite
  const [suiteName, suite] = suites[0];
  const testResults = suite?.test_results || suite?.tests || {};
  const testNames = Object.keys(testResults);
  if (testNames.length === 0) {
    out.reason_code = "NO_TESTS_FOUND";
    out.notes.push(`suite ${suiteName} has no test_results`);
    return out;
  }

  // Grade against the first test function found. Multi-test files not supported in 6.1.
  const testName = testNames[0];
  const t = testResults[testName];
  out.test_name = testName;

  if (testNames.length > 1) {
    out.notes.push(
      `found ${testNames.length} test functions; grading first (${testName}). Multi-test grading in 6.2.`
    );
  }

  // Extract gas. Foundry 1.7.x shape:
  //   "kind": { "Unit": { "gas": 2513 } }              — regular unit test
  //   "kind": { "Fuzz": { "median_gas": N, ... } }     — fuzz test
  //   "kind": { "Invariant": { ... } }                 — invariant test
  // Older Foundry used "Standard" instead of "Unit"; keep both for safety.
  if (t.kind && typeof t.kind === "object") {
    if (t.kind.Unit && typeof t.kind.Unit.gas === "number") out.gas_used = t.kind.Unit.gas;
    else if (typeof t.kind.Standard === "number") out.gas_used = t.kind.Standard;
    else if (t.kind.Fuzz?.median_gas != null) out.gas_used = t.kind.Fuzz.median_gas;
  } else if (typeof t.gas_used === "number") {
    out.gas_used = t.gas_used;
  }

  // Logs (forge captures console.log via decoded_logs)
  if (Array.isArray(t.decoded_logs)) {
    out.logs = t.decoded_logs.slice(0, 100);
  } else if (Array.isArray(t.logs)) {
    out.logs = t.logs.slice(0, 100).map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  }

  // Traces head \u2014 first 2000 chars of the traces array joined
  if (Array.isArray(t.traces) && t.traces.length > 0) {
    out.traces_head = JSON.stringify(t.traces).slice(0, 2000);
  }

  // Success grading. Foundry 1.7.x emits `status` as a string enum:
  //   "Success" | "Failure" | "Skipped"
  // Older Foundry emitted `success: true|false`. Support both.
  let testPassed;
  if (typeof t.status === "string") {
    testPassed = t.status === "Success";
    if (t.status === "Skipped") {
      out.notes.push("test was skipped by forge (vm.skip or fork mismatch)");
    }
  } else if (typeof t.success === "boolean") {
    testPassed = t.success;
  } else {
    out.notes.push(`could not read pass/fail from test result (status=${t.status} success=${t.success})`);
    testPassed = false;
  }

  out.actual = testPassed ? "pass" : "revert";
  if (!testPassed && t.reason) {
    out.notes.push(`revert reason: ${String(t.reason).slice(0, 500)}`);
  }

  out.verified = out.actual === expected;
  return out;
}

function extractCompilerErrors(stdout, stderr) {
  const combined = (stderr || "") + "\n" + (stdout || "");
  const lines = combined.split("\n");
  const errLines = lines.filter((l) => /error\[|ParserError|CompilerError/i.test(l));
  return errLines.slice(0, 20).join("\n").slice(0, 2000) || "compile error (details not captured)";
}

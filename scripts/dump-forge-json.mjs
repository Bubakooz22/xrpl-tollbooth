#!/usr/bin/env node
// One-shot: run forge test --json on the simple-pass fixture and dump
// the raw JSON so we can see what field actually carries "success".
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE = "/tmp/verify-poc-cache/forge-std";
if (!existsSync(path.join(CACHE, "src", "Test.sol"))) {
  console.error("forge-std not cached yet \u2014 hit /verify-poc once first to prime it");
  process.exit(2);
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), "forge-dump-"));
try {
  await mkdir(path.join(sandbox, "test"), { recursive: true });
  await mkdir(path.join(sandbox, "src"), { recursive: true });
  await mkdir(path.join(sandbox, "lib"), { recursive: true });

  await new Promise((r, j) => {
    const p = spawn("ln", ["-s", CACHE, path.join(sandbox, "lib", "forge-std")]);
    p.on("exit", (c) => (c === 0 ? r() : j(new Error("ln failed"))));
  });

  await writeFile(
    path.join(sandbox, "foundry.toml"),
    '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib"]\nffi = false\nauto_detect_solc = true\noptimizer = false\n'
  );
  await writeFile(path.join(sandbox, "remappings.txt"), "forge-std/=lib/forge-std/src/\n");

  const src = await readFile(
    path.join(process.cwd(), "fixtures", "verify-poc", "simple-pass.t.sol"),
    "utf8"
  );
  await writeFile(path.join(sandbox, "test", "PoC.t.sol"), src);

  await new Promise((resolve) => {
    const p = spawn("forge", ["test", "-vvv", "--json", "--no-cache"], {
      cwd: sandbox,
      env: { ...process.env, NO_COLOR: "1", FOUNDRY_DISABLE_UPDATE_CHECK: "1" },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      console.log("=== EXIT CODE:", code);
      console.log("=== STDERR (first 500):");
      console.log(err.slice(0, 500));
      console.log("=== STDOUT (raw, all lines):");
      console.log(out);
      console.log("=== PARSED PER-LINE JSON ATTEMPT:");
      for (const line of out.split("\n")) {
        const t = line.trimStart();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t);
          console.log("PARSED OK:", JSON.stringify(j, null, 2));
          break;
        } catch (e) {
          console.log("failed:", e.message.slice(0, 100));
        }
      }
      resolve();
    });
  });
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

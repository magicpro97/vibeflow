#!/usr/bin/env bun
/**
 * Branch coverage harness for bun test.
 *
 * Uses @babel/parser (with typescript plugin) to parse TS source,
 * then istanbul-lib-instrument to inject branch coverage tracking.
 *
 * 1. Instruments all src TS files
 * 2. Replaces originals with instrumented versions
 * 3. Runs `bun test`
 * 4. Restores originals
 * 5. Runs `istanbul report` to produce lcov + json-summary
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "@babel/parser";
import babel from "@babel/core";
// istanbul-lib-instrument is used directly inside the babel-plugin-istanbul
// which we register as a babel plugin below. No top-level import needed.
// (istanbul-lib-instrument has no type declarations, and we only need the
// babel plugin entry point.)

const INSTRUMENTED = "/tmp/vf-instrumented";
const SRC = "src";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(p) && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

// Parse with TS plugin so we can hand off to istanbul via babel.transformSync
function transform(code: string, filename: string): string {
  // First parse to validate TS
  parse(code, {
    sourceType: "unambiguous",
    allowImportExportEverywhere: true,
    plugins: ["typescript"],
  });
  // Then babel-transform + instrument. Use babel's own transform which
  // strips types, then feed through istanbul.
  const out = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      ["@babel/preset-typescript", { allowDeclareFields: true }],
    ],
    plugins: [
      "istanbul",
    ],
    sourceMaps: true,
  });
  if (!out || !out.code) throw new Error(`babel transform failed for ${filename}`);
  return out.code;
}

const files = walk(SRC);
console.log(`Instrumenting ${files.length} files...`);

mkdirSync(INSTRUMENTED, { recursive: true });
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const out = join(INSTRUMENTED, relative(SRC, f));
  mkdirSync(join(out, ".."), { recursive: true });
  const code = transform(src, f);
  writeFileSync(out, code);
}

console.log("\nRunning bun test against instrumented code...");
const backups: Array<[string, string]> = [];
for (const f of files) {
  const origContent = readFileSync(f, "utf8");
  backups.push([f, origContent]);
  const instContent = readFileSync(
    join(INSTRUMENTED, relative(SRC, f)),
    "utf8",
  );
  writeFileSync(f, instContent);
}

let testsFailed = false;
try {
  const r = spawnSync("bun", ["test"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      // Tell babel-plugin-istanbul where to write coverage JSON.
      BABEL_PLUGIN_ISTANBUL_OUTPUT: "/tmp/vf-coverage",
    },
  });
  testsFailed = r.status !== 0;
  if (testsFailed) {
    console.warn("\n⚠️  Some tests failed but coverage data was still collected — continuing.");
  }
} finally {
  console.log("\nRestoring originals...");
  for (const [f, orig] of backups) {
    writeFileSync(f, orig);
  }
}

// Don't exit on test failure — coverage data is still valid.

console.log("\nGenerating branch coverage report via istanbul...");
const cwd = process.cwd();
const covListing = spawnSync(
  "find",
  ["/tmp/vf-coverage", "-maxdepth", "4", "-name", "coverage-*.json"],
  { encoding: "utf8" },
).stdout;
const covFile = covListing
  .split("\n")
  .find((l) => l.includes("coverage") && l.endsWith(".json"));
if (!covFile) {
  console.error("No coverage JSON file emitted");
  process.exit(1);
}

const report = spawnSync(
  "node_modules/.bin/istanbul",
  [
    "report",
    "--root",
    cwd,
    "--dir",
    "coverage-branch",
    "--format",
    "text",
    "--format",
    "lcov",
    "--format",
    "json-summary",
    covFile,
  ],
  { stdio: "inherit" },
);

if (report.status !== 0) process.exit(report.status ?? 1);

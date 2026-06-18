#!/usr/bin/env node
// File-size gate: fail CI when any `src/commands/*.ts` exceeds the
// 400-line cap. The facade `src/commands.ts` is allowed up to 1200
// lines (it's the public re-export surface and is intentionally thin).
//
// This is the safety-net for the per-PR follow-up issues that waive
// oversized files (issue #80 phase 8/14 tools.ts waiver; future
// waivers). Each waiver MUST reference a tracked issue; if the
// issue slips, CI fails.
//
// Why a separate script (not a test)? Because the check is repo-
// structural, not behavioral: a passing test suite does NOT prove
// the file is small enough. A repo-size lint is a different kind of
// invariant and deserves its own gate.
//
// GitHub Actions annotation format used (so the workflow UI renders
// file-scoped annotations, not a top-level error):
//   ::error file=<path>,line=<n>,col=<n>::<msg>
//
// Exits 0 on pass, 1 on fail (CI-friendly).

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

// Per-file cap, in lines. The default is 400. The facade
// (src/commands.ts) is a special case and is checked at 1200.
//
// The cap is intentionally a hard ceiling, not a soft warning.
const CAP = 400;
const FACADE_FILE = "src/commands.ts";
const FACADE_CAP = 1200;

// The directories that are subject to the cap. Only files under
// `src/commands/` are checked.
const SCAN_DIRS = ["src/commands"];

// Individual files (not under SCAN_DIRS) that are also subject to the
// cap. The facade `src/commands.ts` is a SIBLING of `src/commands/`,
// so it is never reached by walking SCAN_DIRS — it must be listed
// explicitly or it would silently escape the gate (the very file most
// likely to bloat back up during the split).
const SCAN_FILES = [FACADE_FILE];

// Waivers: a list of { file, cap, issue } triples. The `cap` is the
// raised limit (e.g. 600 lines for tools.ts) and `issue` is the
// tracked issue that owns the follow-up split. If the issue is
// closed, remove the waiver — the next CI run will fail until the
// file is actually split.
//
// To add a waiver:
//   1. File an issue (e.g. "split tools.ts into tools-detect + tools-mcp-config")
//   2. Add { file: "src/commands/tools.ts", cap: 600, issue: "#N" } below
//   3. Cite the issue in the PR that adds the waiver
const WAIVERS = [
  // PR8 waiver (issue #80 phase 8/14, Plan Option B): tools.ts is
  // 676 lines vs the 400-line cap. The body is the byte-equivalent
  // extraction (515 lines) PLUS additional #80-rebase follow-up
  // cleanup: a `probeFn` test seam on `toolsStatus`, the exported
  // `probeIndexHealth` helper, an `engines` parameter on
  // `writeToolConfigs`, and the exported `provisionTool` (PR129 fix
  // that auto-provisions codegraph in `vf init`). Follow-up issue
  // tracks the split into tools-detect.ts + tools-mcp-config.ts.
  // Waived cap: 700. The Plan Option A (3-file split in PR8) was
  // rejected as cycle-risky; Option B (oversize + waiver + CI lint)
  // is in effect.
  { file: "src/commands/tools.ts", cap: 700, issue: "#136" },
  // PR7 waiver (issue #80 phase 7/14, Plan Option B): protection.ts
  // is 514 lines vs the 400-line cap. Follow-up issue tracks the
  // split into protection-hooks.ts + protection-emit.ts. Waived
  // cap: 600.
  { file: "src/commands/protection.ts", cap: 600, issue: "#131" },
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function capFor(relFile) {
  if (relFile === FACADE_FILE) return { cap: FACADE_CAP, waiver: null };
  const w = WAIVERS.find((w) => w.file === relFile);
  if (w) return { cap: w.cap, waiver: w };
  return { cap: CAP, waiver: null };
}

function main() {
  const violations = [];
  const scanned = [];
  for (const rel of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const relFile = path.relative(REPO_ROOT, file);
      const { cap, waiver } = capFor(relFile);
      const lines = lineCount(file);
      scanned.push({ file: relFile, lines, cap, waiver });
      if (lines > cap) {
        violations.push({ file: relFile, lines, cap, waiver });
      }
    }
  }
  // Individual sibling files (e.g. the facade) that the dir walk misses.
  for (const relFile of SCAN_FILES) {
    const abs = path.join(REPO_ROOT, relFile);
    if (!fs.existsSync(abs)) continue;
    const { cap, waiver } = capFor(relFile);
    const lines = lineCount(abs);
    scanned.push({ file: relFile, lines, cap, waiver });
    if (lines > cap) {
      violations.push({ file: relFile, lines, cap, waiver });
    }
  }

  if (violations.length === 0) {
    let largest = scanned[0];
    for (const s of scanned) {
      if (s.lines > largest.lines) largest = s;
    }
    const wnote = largest.waiver ? ` (waiver: ${largest.waiver.issue})` : "";
    console.log(
      `::notice::file-size gate: OK (largest is ${largest.file} at ${largest.lines} lines, cap ${largest.cap})${wnote}`,
    );
    process.exit(0);
  }

  console.error("::error::file-size gate: violations found");
  for (const v of violations) {
    const wnote = v.waiver
      ? ` WAIVER EXPIRED (was ${v.waiver.issue}, current cap ${v.cap}) — remove the waiver entry after the follow-up split lands.`
      : "";
    console.error(
      `::error file=${v.file},line=${v.cap + 1},col=1::${v.file} is ${v.lines} lines (cap ${v.cap}). Split per the issue #80 plan.${wnote}`,
    );
  }
  console.error(
    `\n${violations.length} file(s) exceed the ${CAP}-line cap (or the raised waiver cap).`,
  );
  process.exit(1);
}

main();

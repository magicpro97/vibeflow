#!/usr/bin/env node
// File-size gate: fail CI when any `src/**/*.ts` exceeds the 400-line cap.
// The facade `src/commands.ts` is allowed up to 1200 lines (re-export surface).
//
// Two waiver mechanisms co-exist (intentionally):
//  - Central `WAIVERS` array below: the legacy list for tools.ts #136 and
//    protection.ts #131, predates the in-line convention.
//  - In-line `// size-waiver: #<issue> — <reason>` on the leading comment
//    block of any `.ts` file under `src/`. The issue reference (`#\d+`) is
//    REQUIRED; the reason text is REQUIRED (>= 10 chars after the issue
//    number). Both are validated by `findWaiver()` below.
//
// On a malformed in-line waiver (missing issue ref, too-short reason, or
// waiver not in the leading comment block), the gate does NOT silently
// fall through to "waived." It logs a `::warning` and treats the file
// as un-waived, so the contributor fixes the waiver rather than the
// file getting a permanent free pass.

"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

const CAP = 400;
const FACADE_FILE = "src/commands.ts";
const FACADE_CAP = 1200;

// Scan every .ts under src/ recursively (was: only src/commands/).
// EXCLUDE_PATTERNS protects against future codegen: `*.generated.ts`,
// `*.gen.ts`, and `dist/`/`build/` outputs that aren't hand-written.
const SCAN_DIRS = ["src"];
const SCAN_FILES = [FACADE_FILE];
const EXCLUDE_PATTERNS = [/\.generated\.ts$/, /\.gen\.ts$/, /\/dist\//, /\/build\//];

// Regex for the in-line waiver. Requires:
//   - first chars: optional whitespace, then "//"
//   - the literal "size-waiver:"
//   - one or more spaces
//   - a "#" followed by one or more digits  ← the issue reference (REQUIRED)
//   - optional: " — " followed by the reason (>= 10 chars, otherwise
//     the gate treats the waiver as malformed and falls through to the
//     cap)
const INLINE_WAIVER_REGEX = /^\s*\/\/\s*size-waiver:\s*#\d+(?:\s*[—\-]\s*\S.{8,})\s*$/;

// The first non-comment, non-blank line is where the executable code
// starts. The waiver scan stops at that line — anything after is code,
// not a comment, and the waiver is no longer in scope.
const EXECUTABLE_FIRST_LINE =
  /^(?:import|export|function|class|const|let|var|type|interface|declare|namespace|module)\b/;

// Legacy central WAIVERS array. Don't migrate in this PR — that's a
// follow-up. The in-line mechanism is for NEW exemptions; these two
// predate it.
const WAIVERS = [
  { file: "src/commands/tools.ts", cap: 700, issue: "#136" },
  { file: "src/commands/protection.ts", cap: 600, issue: "#131" },
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (EXCLUDE_PATTERNS.some((re) => re.test(full))) continue;
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
  if (text.trim() === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

// Walk every .ts file the gate should see: SCAN_DIRS (recursively) plus
// SCAN_FILES (the facade, with no parent directory to recurse into).
// Deduped by absolute path so a facade file that lives under a scanned
// dir is only visited once.
function walkSrcFiles() {
  const seen = new Set();
  const out = [];
  for (const rel of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  for (const relFile of SCAN_FILES) {
    const abs = path.join(REPO_ROOT, relFile);
    if (!fs.existsSync(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

// Scan the LEADING COMMENT BLOCK of a file (not just line 0) for the
// `// size-waiver: ...` marker. Skips past `/* … */` block comments
// (JSDoc, `/* @ts-check */`, license headers) so a file that opens
// with a block comment is still scanned. Stops at the first
// executable statement, a blank-line-then-statement, or any line that
// isn't a `//` comment / `/* */` block / blank / shebang. Returns
// `{ line, reason } | null`. The `line` is 0-based; the `reason` is
// the full comment text after `// size-waiver:`.
function findWaiver(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return null;
  const lines = text.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    // Skip shebangs (must be on the very first line).
    if (i === 0 && line.startsWith("#!")) continue;
    // Skip pure blank lines.
    if (t === "") continue;
    // Track `/* … */` blocks (single-line or multi-line).
    if (!inBlock && t.startsWith("/*")) {
      if (t.includes("*/")) continue;          // single-line block
      inBlock = true; continue;                 // enter multi-line block
    }
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    // Stop at the first executable statement.
    if (EXECUTABLE_FIRST_LINE.test(t)) return null;
    // Look for the waiver comment in this line.
    const m = INLINE_WAIVER_REGEX.exec(line);
    if (m) {
      const reasonMatch = line.match(/size-waiver:\s*(.+?)\s*$/);
      return { line: i, reason: reasonMatch ? reasonMatch[1] : "" };
    }
    // Any other non-`//` line is past the leading comment block.
    if (!line.trimStart().startsWith("//")) return null;
  }
  return null;
}

function capFor(relFile) {
  if (relFile === FACADE_FILE) return { cap: FACADE_CAP, waiver: null };
  const w = WAIVERS.find((w) => w.file === relFile);
  if (w) return { cap: w.cap, waiver: w };
  return { cap: CAP, waiver: null };
}

function main() {
  const violations = [];
  const waiverMismatches = [];
  const scanned = [];
  const srcFiles = walkSrcFiles();
  // First pass: count lines, find valid inline waiver, flag violations.
  // We re-read the file in the second pass (malformed-walk) — that
  // second pass is needed only to catch the rare "comment present but
  // regex-rejected" case, so the duplicate read is bounded to files
  // that matter (not a hot path).
  for (const file of srcFiles) {
    const relFile = path.relative(REPO_ROOT, file);
    const { cap, waiver } = capFor(relFile);
    const lines = lineCount(file);
    const w = findWaiver(file);
    scanned.push({ file: relFile, lines, cap, waiver, inline: w });
    if (w === null && lines > cap) {
      violations.push({ file: relFile, lines, cap, waiver, inline: w });
    }
  }

  // Second pass: walk every .ts file the gate sees (SCAN_DIRS + the
  // SCAN_FILES facade) and flag any "// size-waiver:" comment in the
  // leading comment block that fails the strict regex. The first pass
  // is "is there a valid waiver?"; this one is "is the comment
  // present but malformed?". Both passes use the same `inBlock`
  // state machine so a JSDoc / `/* @ts-check */` header doesn't hide
  // a malformed waiver on a later leading line.
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (i === 0 && line.startsWith("#!")) continue;
      if (t === "") continue;
      if (!inBlock && t.startsWith("/*")) {
        if (t.includes("*/")) continue;
        inBlock = true; continue;
      }
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        continue;
      }
      if (EXECUTABLE_FIRST_LINE.test(t)) break;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("//")) break;
      if (trimmed.startsWith("// size-waiver:") && !INLINE_WAIVER_REGEX.test(line)) {
        waiverMismatches.push({ file: path.relative(REPO_ROOT, file), line: i, text: trimmed });
      }
    }
  }

  // Report waiver-mismatch warnings (do NOT fail the build — the
  // contributor's PR is their fix, not ours).
  for (const m of waiverMismatches) {
    console.error(
      `::warning file=${m.file},line=${m.line + 1},col=1::waiver comment malformed: ${m.text} — expected "// size-waiver: #<issue> — <reason>"`,
    );
  }

  if (violations.length === 0) {
    if (scanned.length === 0) {
      console.log("::notice::file-size gate: OK (no .ts files scanned)");
      process.exit(0);
    }
    let largest = scanned[0];
    for (const s of scanned) {
      if (s.lines > largest.lines) largest = s;
    }
    let wnote = "";
    if (largest.waiver) wnote = ` (waiver: ${largest.waiver.issue})`;
    else if (largest.inline) wnote = ` (inline waiver: ${largest.inline.reason})`;
    console.log(
      `::notice::file-size gate: OK (largest is ${largest.file} at ${largest.lines} lines, cap ${largest.cap})${wnote}`,
    );
    // File-scoped ::warning for every file that carries a valid inline
    // waiver and is OVER its cap — the waiver is doing work, so the PR
    // reviewer should see it in the diff annotations. Under-cap files
    // are silent (the waiver is dormant).
    for (const s of scanned) {
      if (!s.inline) continue;
      if (s.lines <= s.cap) continue;
      const m = s.inline.reason.match(/#(\d+)\b/);
      const issueNum = m ? m[1] : "?";
      console.error(
        `::warning file=${s.file},line=${s.inline.line + 1},col=1::inline waiver #${issueNum} active (${s.inline.reason}); file is ${s.lines} lines, cap ${s.cap}`,
      );
    }
    process.exit(0);
  }

  console.error("::error::file-size gate: violations found");
  for (const v of violations) {
    let wnote;
    if (v.waiver) {
      wnote = ` WAIVER EXPIRED (was ${v.waiver.issue}, current cap ${v.cap}) — remove the waiver entry after the follow-up split lands.`;
    } else {
      wnote = "";
    }
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

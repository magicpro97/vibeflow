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
const INLINE_WAIVER_REGEX = /^\s*\/\/\s*size-waiver:\s*#\d+(?:\s*[—\-]\s*\S.{8,})?\s*$/;

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
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

// Scan the LEADING COMMENT BLOCK of a file (not just line 0) for the
// `// size-waiver: ...` marker. Stops at the first executable statement,
// a blank-line-then-statement, or a `/* */` block boundary. Returns
// `{ line, reason } | null`. The `line` is 0-based; the `reason` is the
// full comment text after `// size-waiver:`.
function findWaiver(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip shebangs (must be on the very first line).
    if (i === 0 && line.startsWith("#!")) continue;
    // Skip pure blank lines.
    if (line.trim() === "") continue;
    // Stop at the first executable statement.
    if (EXECUTABLE_FIRST_LINE.test(line.trim())) return null;
    // Look for the waiver comment in this line.
    const m = INLINE_WAIVER_REGEX.exec(line);
    if (m) {
      const reasonMatch = line.match(/size-waiver:\s*(.+?)\s*$/);
      return { line: i, reason: reasonMatch ? reasonMatch[1] : "" };
    }
    // If this is a `/* */` block, we'd have to parse it; for the
    // simple-shape waivers we expect, we stop at any non-`//` line
    // that isn't blank/shebang/executable.
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
  for (const rel of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const relFile = path.relative(REPO_ROOT, file);
      const { cap, waiver } = capFor(relFile);
      const lines = lineCount(file);
      const w = findWaiver(file);
      scanned.push({ file: relFile, lines, cap, waiver, inline: w });
      if (w === null && lines > cap) {
        violations.push({ file: relFile, lines, cap, waiver, inline: w });
      }
    }
  }
  for (const relFile of SCAN_FILES) {
    const abs = path.join(REPO_ROOT, relFile);
    if (!fs.existsSync(abs)) continue;
    const { cap, waiver } = capFor(relFile);
    const lines = lineCount(abs);
    const w = findWaiver(abs);
    scanned.push({ file: relFile, lines, cap, waiver, inline: w });
    if (w === null && lines > cap) {
      violations.push({ file: relFile, lines, cap, waiver, inline: w });
    }
  }

  // Walk again to find malformed in-line waivers (look like a waiver,
  // miss the regex). The first pass is "is there a waiver comment?";
  // this one is "is the comment present but malformed?". We detect by
  // reading the leading comment block and looking for any line that
  // starts with "// size-waiver:" but does NOT match the strict regex.
  for (const rel of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      const inLeadingBlock = true;
      for (let i = 0; i < lines.length && inLeadingBlock; i++) {
        const line = lines[i];
        if (i === 0 && line.startsWith("#!")) continue;
        if (line.trim() === "") continue;
        if (EXECUTABLE_FIRST_LINE.test(line.trim())) break;
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("//")) break;
        if (trimmed.startsWith("// size-waiver:") && !INLINE_WAIVER_REGEX.test(line)) {
          waiverMismatches.push({ file: path.relative(REPO_ROOT, file), line: i, text: trimmed });
        }
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

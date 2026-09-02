#!/usr/bin/env node
// Merge lcov files, unioning DA hit counts per source file.
//
// bun 1.4.0's built-in lcov merge keeps only ONE record per source file
// (last-writer-wins by test-worker completion order, which differs by
// platform), so shared modules nondeterministically lose lines on CI.
// This unions per-line hit counts so a module covered by several files
// keeps every line hit from any run.
//
// IMPORTANT subtlety: a source file's instrumented DA line SET can differ
// between runs (bun only records DA entries for lines a test file actually
// exercised -> zeros are "real" misses). Unioning every record inflates the
// entry set with another run's data and can manufacture false misses, so
// only SFs listed in --union-sf are merged from later inputs; every other
// SF keeps the FIRST input's record block verbatim (SF/FN/DA/BRDA/LH
// untouched).
//
// Safety: every --union-sf path must appear in at least one input
// record set, else the union silently no-ops and the gate would read a
// stale record. Missing targets exit 1.
//
// Usage: node scripts/merge-lcov.cjs <out.lcov> <base.lcov> [<extra.lcov>...]
//   --union-sf=<path> may be repeated to select SFs that get unioned.
const fs = require("node:fs");

const [, , outPath, basePath, ...rest] = process.argv;
if (!outPath || !basePath) {
  console.error("usage: merge-lcov.cjs <out.lcov> <base.lcov> [--union-sf=<p>] [<extra.lcov>...]");
  process.exit(2);
}

const unionSfs = rest.filter((a) => a.startsWith("--union-sf=")).map((a) => a.slice("--union-sf=".length));
const extraPaths = rest.filter((a) => !a.startsWith("--union-sf="));

// Returns Map<sf, { block: string, da: Map<line, hits> }>.
function fileRecords(text) {
  const records = new Map();
  for (const block of text.split("end_of_record")) {
    let sf = "";
    const da = new Map();
    for (const line of block.split("\n")) {
      if (line.startsWith("SF:")) sf = line.slice(3).trim();
      else if (line.startsWith("DA:")) {
        const parts = line.slice(3).split(",");
        if (parts.length >= 2) {
          const no = Number(parts[0]);
          const hits = Number(parts[1]);
          if (Number.isFinite(no) && Number.isFinite(hits)) da.set(no, hits);
        }
      }
    }
    if (sf) records.set(sf, { block: `${block}end_of_record`, da });
  }
  return records;
}

const allInputs = [basePath, ...extraPaths].map((p) => fileRecords(fs.readFileSync(p, "utf8")));
const base = allInputs[0];

// Verify every union target exists in some input, so a typo'd or
// shape-changed SF path fails loudly instead of silently no-oping.
const seenSfs = new Set();
for (const records of allInputs) for (const sf of records.keys()) seenSfs.add(sf);
const missing = unionSfs.filter((sf) => !seenSfs.has(sf));
if (missing.length > 0) {
  console.error(`merge-lcov: --union-sf target(s) not found in any input: ${missing.join(", ")}`);
  process.exit(1);
}

// Union DA hits (max per line) for targeted SFs only.
const unionTarget = new Set(unionSfs);
for (const extra of allInputs.slice(1)) {
  for (const [sf, rec] of extra) {
    if (!unionTarget.has(sf)) continue;
    const cur = base.get(sf);
    if (!cur) {
      base.set(sf, rec);
      continue;
    }
    // Rewrite the base block's DA lines with unioned counts.
    const kept = [];
    let replaced = false;
    for (const line of cur.block.split("\n")) {
      if (line.startsWith("DA:")) {
        if (!replaced) {
          replaced = true;
          const sorted = [...cur.da.entries()].sort((x, y) => x[0] - y[0]);
          for (const [no, hits] of sorted) {
            const unionHits = Math.max(hits, rec.da.get(no) ?? 0);
            kept.push(`DA:${no},${unionHits}`);
          }
        }
      } else {
        kept.push(line);
      }
    }
    for (const [no, hits] of rec.da) {
      // Only add lines absent from base when they were actually hit —
      // a zero-hit line unique to the extra run is a false miss (bun's
      // DA line set differs per run).
      if (!cur.da.has(no) && hits > 0) kept.push(`DA:${no},${hits}`);
    }
    cur.block = kept.join("\n");
  }
}

const out = [];
for (const { block } of base.values()) out.push(block.trim());
fs.writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`merged ${base.size} records from ${allInputs.length} files -> ${outPath}`);
console.log(`union SFs (${unionTarget.size}): ${[...unionTarget].join(", ")}`);
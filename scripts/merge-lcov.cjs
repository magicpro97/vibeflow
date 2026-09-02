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
// exercised → zeros are "real" misses). Unioning every record inflates the
// entry set with another run's data and can manufacture false misses, so
// only SFs listed in --union-sf are merged from later inputs; every other
// SF takes the FIRST input's record verbatim.
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

function fileRecords(text) {
  const records = new Map(); // sf -> { da: Map<line, hits> }
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
    if (sf) records.set(sf, { da });
  }
  return records;
}

const base = fileRecords(fs.readFileSync(basePath, "utf8"));

// For each union SF, overlay DA hits (max) from every extra file.
const unionTarget = new Set(unionSfs);
for (const p of extraPaths) {
  const extra = fileRecords(fs.readFileSync(p, "utf8"));
  for (const [sf, rec] of extra) {
    if (!unionTarget.has(sf)) continue;
    const cur = base.get(sf);
    if (!cur) {
      base.set(sf, rec);
      continue;
    }
    for (const [no, hits] of rec.da) {
      cur.da.set(no, Math.max(cur.da.get(no) ?? 0, hits));
    }
  }
}

const out = [];
for (const [sf, rec] of base) {
  const lines = [`SF:${sf}`];
  const sorted = [...rec.da.entries()].sort((x, y) => x[0] - y[0]);
  for (const [no, hits] of sorted) lines.push(`DA:${no},${hits}`);
  const hit = sorted.filter(([, h]) => h > 0).length;
  lines.push(`LF:${sorted.length}`, `LH:${hit}`, "end_of_record");
  out.push(lines.join("\n"));
}

fs.writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`merged ${base.size} records from ${extraPaths.length + 1} files -> ${outPath}`);
console.log(`union SFs (${unionTarget.size}): ${[...unionTarget].join(", ")}`);
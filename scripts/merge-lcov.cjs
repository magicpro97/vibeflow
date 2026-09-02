#!/usr/bin/env node
// Merge two lcov.info files into one, unioning DA hit counts per source
// file. bun 1.4.0's built-in lcov merge keeps only ONE record per source
// file (first-writer-wins by test-file discovery order, which differs by
// platform), so a shared module's coverage nondeterministically drops.
// This script unions records so a module covered by several test files
// keeps every line hit from either run.
//
// Usage: node scripts/merge-lcov.cjs <primary.lcov> <supplement.lcov> <out.lcov>
const fs = require("node:fs");

const [, , aPath, bPath, outPath] = process.argv;
if (!aPath || !bPath || !outPath) {
  console.error("usage: merge-lcov.cjs <primary.lcov> <supplement.lcov> <out.lcov>");
  process.exit(2);
}

function fileRecords(text) {
  const records = new Map(); // sf -> { da: Map<line, hits> }
  for (const block of text.split("end_of_record")) {
    let sf = "";
    const da = new Map();
    const fns = [];
    let fnf = "0";
    let fnh = "0";
    for (const line of block.split("\n")) {
      if (line.startsWith("SF:")) sf = line.slice(3).trim();
      else if (line.startsWith("DA:")) {
        const parts = line.slice(3).split(",");
        if (parts.length >= 2) {
          const no = Number(parts[0]);
          const hits = Number(parts[1]);
          if (Number.isFinite(no) && Number.isFinite(hits)) {
            da.set(no, Math.max(da.get(no) ?? 0, hits));
          }
        }
      } else if (line.startsWith("FN:")) fns.push(line.slice(3));
      else if (line.startsWith("FNF:")) fnf = line.slice(4);
      else if (line.startsWith("FNH:")) fnh = line.slice(4);
    }
    if (sf) records.set(sf, { da, fns, fnf, fnh });
  }
  return records;
}

const a = fileRecords(fs.readFileSync(aPath, "utf8"));
const b = fileRecords(fs.readFileSync(bPath, "utf8"));

for (const [sf, recB] of b) {
  const recA = a.get(sf);
  if (!recA) {
    a.set(sf, recB);
    continue;
  }
  for (const [no, hits] of recB.da) {
    recA.da.set(no, Math.max(recA.da.get(no) ?? 0, hits));
  }
  const known = new Set(recA.fns);
  for (const fn of recB.fns) if (!known.has(fn)) recA.fns.push(fn);
}

const out = [];
for (const [sf, rec] of a) {
  const lines = [`SF:${sf}`];
  for (const fn of rec.fns) lines.push(`FN:${fn}`);
  lines.push(`FNF:${rec.fnf}`, `FNH:${rec.fnh}`);
  const sorted = [...rec.da.entries()].sort((x, y) => x[0] - y[0]);
  for (const [no, hits] of sorted) lines.push(`DA:${no},${hits}`);
  const hit = sorted.filter(([, h]) => h > 0).length;
  lines.push(`LF:${sorted.length}`, `LH:${hit}`);
  lines.push("end_of_record");
  out.push(lines.join("\n"));
}

fs.writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`merged ${a.size} records -> ${outPath}`);
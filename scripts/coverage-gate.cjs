#!/usr/bin/env node
// Coverage gate: parse lcov.info and fail if any source file is
// below 100% line OR branch coverage, OR if the aggregate drops
// below 100%. This is the source of truth for the "100% coverage"
// invariant in this repo. Used by `bun run check` and by CI.
const fs = require("node:fs");
const path = require("node:path");

const lcovPath = path.join(
  process.cwd(),
  "coverage",
  "lcov.info",
);
if (!fs.existsSync(lcovPath)) {
  console.error(`::error::lcov.info not found at ${lcovPath}`);
  console.error("Run `bun test --coverage --coverage-reporter=lcov` first.");
  process.exit(1);
}

const records = fs.readFileSync(lcovPath, "utf8").split("end_of_record");

let totalLines = 0;
let hitLines = 0;
let totalBranches = 0;
let hitBranches = 0;
const perFile = [];

for (const r of records) {
  const sf = /^SF:(.+)$/m.exec(r)?.[1]?.trim();
  if (!sf) continue;
  // Only enforce per-file for src/ — test/ and scripts/ can be partial.
  if (!sf.includes("/src/") && !sf.startsWith("src/")) continue;
  const lf = (r.match(/^LF:(\d+)$/gm) ?? []).reduce(
    (a, m) => a + Number(m.split(":")[1]),
    0,
  );
  const lh = (r.match(/^LH:(\d+)$/gm) ?? []).reduce(
    (a, m) => a + Number(m.split(":")[1]),
    0,
  );
  const brf = (r.match(/^BRF:(\d+)$/gm) ?? []).reduce(
    (a, m) => a + Number(m.split(":")[1]),
    0,
  );
  const brh = (r.match(/^BRH:(\d+)$/gm) ?? []).reduce(
    (a, m) => a + Number(m.split(":")[1]),
    0,
  );
  totalLines += lf;
  hitLines += lh;
  totalBranches += brf;
  hitBranches += brh;
  if (lf === 0 && brf === 0) continue;
  const lpct = lf > 0 ? (100 * lh) / lf : 100;
  const bpct = brf > 0 ? (100 * brh) / brf : 100;
  perFile.push({ sf, lf, lh, brf, brh, lpct, bpct });
}

const overallLine = totalLines > 0 ? (100 * hitLines) / totalLines : 100;
const overallBranch = totalBranches > 0 ? (100 * hitBranches) / totalBranches : 100;

console.log(
  `lcov line coverage: ${overallLine.toFixed(2)}% (${hitLines}/${totalLines})`,
);
console.log(
  `lcov branch coverage: ${overallBranch.toFixed(2)}% (${hitBranches}/${totalBranches})`,
);

let failed = false;

// Aggregate gate
if (overallLine < 100 || overallBranch < 100) {
  console.error(
    `::error::aggregate lcov is line ${overallLine.toFixed(2)}% / branch ${overallBranch.toFixed(2)}%, must be 100%`,
  );
  failed = true;
}

// Per-file gate (only for src/)
for (const f of perFile) {
  if (f.lpct < 100 || f.bpct < 100) {
    console.error(
      `::error::${f.sf}: line ${f.lpct.toFixed(2)}% (${f.lh}/${f.lf}) / branch ${f.bpct.toFixed(2)}% (${f.brh}/${f.brf}) — must be 100%`,
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

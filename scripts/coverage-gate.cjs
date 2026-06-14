#!/usr/bin/env node
// Coverage gate: parse lcov.info and fail if line coverage < 100%.
// Used by `bun run coverage:check` and by CI.
const fs = require("node:fs");
const path = require("node:path");

const lcovPath = path.join(process.cwd(), "coverage", "lcov.info");
if (!fs.existsSync(lcovPath)) {
  console.error(`::error::lcov report not found at ${lcovPath}. Run \`bun test --coverage --coverage-reporter=lcov\` first.`);
  process.exit(1);
}

const lines = fs.readFileSync(lcovPath, "utf8").split("\n");
let totalLines = 0;
let hitLines = 0;
let totalBranches = 0;
let hitBranches = 0;
for (const line of lines) {
  // LF:N = total executable lines
  let m = line.match(/^LF:(\d+)$/);
  if (m) totalLines += Number.parseInt(m[1], 10);
  m = line.match(/^LH:(\d+)$/);
  if (m) hitLines += Number.parseInt(m[1], 10);
  // BRF:N = total branches (lcov from bun:coverage doesn't emit these)
  m = line.match(/^BRF:(\d+)$/);
  if (m) totalBranches += Number.parseInt(m[1], 10);
  m = line.match(/^BRH:(\d+)$/);
  if (m) hitBranches += Number.parseInt(m[1], 10);
}

const linePct = totalLines > 0 ? (100 * hitLines) / totalLines : 100;
const branchPct = totalBranches > 0 ? (100 * hitBranches) / totalBranches : 100;

console.log(
  `lcov line coverage: ${linePct.toFixed(2)}% (${hitLines}/${totalLines})`,
);
console.log(
  `lcov branch coverage: ${branchPct.toFixed(2)}% (${hitBranches}/${totalBranches})`,
);

let failed = false;
if (linePct < 100) {
  console.error(
    `::error::lcov line coverage is ${linePct.toFixed(2)}%, must be 100%`,
  );
  failed = true;
}
if (branchPct < 100) {
  console.error(
    `::error::lcov branch coverage is ${branchPct.toFixed(2)}%, must be 100%`,
  );
  failed = true;
}
if (failed) process.exit(1);

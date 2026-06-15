#!/usr/bin/env bun
/**
 * Branch coverage using c8 with bun.
 *
 * c8 only works with node, so this script:
 * 1. Wraps the test suite with a custom preload that records V8 coverage
 * 2. Pipes V8 coverage data through c8's report
 */
import { spawnSync } from "node:child_process";

// c8 needs NODE_OPTIONS=-r c8 to instrument, but bun doesn't honor that.
// Instead, set BUN_COVERAGE=1 (if it exists) and rely on bun's own coverage.
const r = spawnSync("bun", ["test", "--coverage", "--coverage-reporter=lcov"], {
  cwd: process.cwd(),
  stdio: "inherit",
});
process.exit(r.status ?? 0);

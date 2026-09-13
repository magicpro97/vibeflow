#!/usr/bin/env node

import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

rmSync("coverage", { recursive: true, force: true });

const uiBuild = run("bun", ["run", "--cwd", "src/ui", "build"]);
if (uiBuild !== 0) process.exit(uiBuild);

const full = run("bun", [
  "test",
  "--timeout",
  "30000",
  "--coverage",
  "--coverage-reporter=lcov",
  "--coverage-dir",
  "coverage/full",
  "--parallel=1",
  "--no-isolate",
]);

const conversation = run("bun", [
  "test",
  "--timeout",
  "30000",
  "--coverage",
  "--coverage-reporter=lcov",
  "--coverage-dir",
  "coverage/conversation",
  "--parallel=1",
  "--no-isolate",
  "src/ui/src/test/ui-conversation-api-coverage.test.ts",
]);

const merge = run("node", [
  "scripts/merge-lcov.cjs",
  "coverage/lcov.info",
  "coverage/full/lcov.info",
  "--union-sf=src/ui/src/conversation-api.ts",
  "coverage/conversation/lcov.info",
]);
const gate = merge === 0 ? run("node", ["scripts/coverage-gate.cjs"]) : 1;

if (full !== 0 || conversation !== 0 || merge !== 0 || gate !== 0) {
  console.error(`coverage:check failed (full=${full} conv=${conversation} merge=${merge} gate=${gate})`);
  process.exit(1);
}

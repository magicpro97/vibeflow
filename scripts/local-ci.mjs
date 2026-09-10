// scripts/local-ci.mjs
//
// Local simulation of CI's `check` job (.github/workflows/ci.yml) — run the
// exact gate sequence the remote runs so a push stops failing CI after the
// fact. Fail-fast like the remote job: stop at the first failing gate.
//
// Usage:
//   bun scripts/local-ci.mjs            # full sequence (test + coverage)
//   bun scripts/local-ci.mjs --quick    # skip the slow gates (test, coverage)
//   bun scripts/local-ci.mjs --e2e      # also run the Playwright e2e suite
//
// Exit code 0 = every gate green; non-zero + first failing gate labelled.

import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const WITH_E2E = args.has("--e2e");

// Mirrors ci.yml `check` job order. Each entry: [label, command, args].
const GATES = [
  ["typecheck", "bun", ["run", "typecheck"]],
  ["lint", "bun", ["run", "lint"]],
  ["file-size", "bun", ["run", "file-size:check"]],
  ["waiver", "bun", ["run", "waiver:check"]],
  ["build", "bun", ["run", "build"]],
  ...(QUICK
    ? []
    : [
        ["test", "bun", ["run", "test"]],
        ["coverage", "bun", ["run", "coverage:check"]],
      ]),
  ["smoke", "bun", ["run", "smoke"]],
  ...(WITH_E2E ? [["e2e", "bunx", ["playwright", "test", "e2e/conversation-home.spec.ts"]]] : []),
];

let failed = null;
const startedAt = Date.now();
for (const [label, cmd, argv] of GATES) {
  process.stdout.write(`\n=== local-ci: ${label} ===\n`);
  const result = spawnSync(cmd, argv, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    failed = label;
    break;
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failed) {
  console.error(
    `\n✗ local-ci FAILED at gate "${failed}" after ${seconds}s — fix it before pushing (CI will fail the same way).`,
  );
  process.exit(1);
}
console.log(
  `\n✔ local-ci passed all ${GATES.length} gates in ${seconds}s${QUICK ? " (quick mode)" : ""}.`,
);

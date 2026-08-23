import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "../src/commands/verify.js";
import { type WorkflowState, readState, writeState } from "../src/core.js";
import { recordPath } from "../src/hooks/review-evidence.js";
import { snapshotImpl } from "../src/spec-freshness.js";
import { asSpawnSync, makeFakeSpawner } from "./helpers/fake-spawner.js";

test("sync verify checkpoints reviewed drift on the first failure and passes only on rerun", () => {
  const base = mkdtempSync(join(tmpdir(), "vf-verify-drift-cli-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: base, encoding: "utf8" }).trim();
  try {
    git(["init", "--quiet"]);
    git(["config", "user.name", "VibeFlow Test"]);
    git(["config", "user.email", "vf-test@example.invalid"]);
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, "test"), { recursive: true });
    mkdirSync(join(base, "scripts"), { recursive: true });
    mkdirSync(join(base, "coverage"), { recursive: true });
    writeFileSync(join(base, ".gitignore"), ".vibeflow/\n");
    writeFileSync(join(base, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(join(base, "src", "routes.ts"), "export const route = 1;\n");
    writeFileSync(join(base, "test", "routes.test.ts"), "// initial negative test\n");
    writeFileSync(join(base, "scripts", "coverage-gate.cjs"), "process.exit(0);\n");
    writeFileSync(join(base, "scripts", "waiver-policy.cjs"), "process.exit(0);\n");
    writeFileSync(
      join(base, "coverage", "lcov.info"),
      "TN:\nSF:src/routes.ts\nDA:1,0\nend_of_record\n",
    );
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "test: seed verify checkpoint"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    const state: WorkflowState = {
      task_id: "verify-drift-cli",
      goal: "checkpoint reviewed implementation drift",
      success_criteria: [],
      work_units: [
        {
          name: "routes",
          status: "done",
          confidence: 1,
          riskClass: "docs",
          scope: ["src/routes.ts"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          evidence: ["src/routes.ts:1 — reviewed route"],
          impl_fingerprint: snapshotImpl(base, ["src/routes.ts"]),
          verified_sha: baseSha,
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };

    writeFileSync(join(base, "src", "routes.ts"), "export const route = 2;\n");
    writeFileSync(join(base, "test", "routes.test.ts"), "// reviewed negative test\n");
    git(["add", "src/routes.ts", "test/routes.test.ts"]);
    git(["commit", "--quiet", "-m", "test: create reviewed drift"]);
    const headSha = git(["rev-parse", "HEAD"]);
    writeState(base, state);

    mkdirSync(join(base, ".vibeflow", "review-evidence", "v1"), { recursive: true });
    writeFileSync(
      recordPath(base, headSha),
      JSON.stringify({
        schemaVersion: 1,
        classifierVersion: 1,
        baseSha,
        headSha,
        changed: [
          { status: "M", path: "src/routes.ts" },
          { status: "M", path: "test/routes.test.ts" },
        ],
        required: [
          {
            id: "api-mutation-owned-fields",
            paths: ["src/routes.ts"],
            anchors: [
              { kind: "source", path: "src/routes.ts", line: 1 },
              { kind: "negative-test", path: "test/routes.test.ts", line: 1 },
            ],
          },
        ],
        reviewer: { status: "passed", exitCode: 0, timedOut: false },
        findings: [],
      }),
    );
    expect(git(["status", "--porcelain"])).toBe("");

    const run = () =>
      verify({
        projectDir: base,
        coverage: true,
        reviewBase: baseSha,
        spawner: asSpawnSync(makeFakeSpawner()),
      });
    expect(run()).toBe(1);
    const checkpoint = readState(base);
    expect(checkpoint?.work_units[0]?.verified_sha).toBe(headSha);
    expect(checkpoint?.work_units[0]?.impl_fingerprint).toEqual(
      snapshotImpl(base, ["src/routes.ts"]),
    );
    expect(git(["status", "--porcelain"])).toBe("");
    expect(run()).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

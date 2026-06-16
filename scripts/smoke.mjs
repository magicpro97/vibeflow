#!/usr/bin/env node
/**
 * Ship-gate "nothing works" smoke test. Drives the BUILT CLI (dist/cli.js) through a real
 * orchestrate dispatch in bridge mode against a deterministic fake engine, then asserts the
 * work unit actually moved forward and evidence was persisted. This fails the build when the
 * end-to-end dispatch path is broken — not just when `--version` can't print.
 *
 * No LLM, no network: VIBEFLOW_AI points at scripts/fake-engine.mjs. Runs in a throwaway temp
 * repo so it never touches the project tree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const FAKE = resolve("scripts/fake-engine.mjs");
const repo = mkdtempSync(join(tmpdir(), "vf-smoke-"));

function run(args, env = {}) {
  return execFileSync("node", [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function fail(msg, extra = "") {
  console.error(`✗ ship-gate smoke FAILED: ${msg}`);
  if (extra) console.error(extra);
  rmSync(repo, { recursive: true, force: true });
  process.exit(1);
}

try {
  // A minimal node project so detection/toolchain logic has something real to read.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "smoke", scripts: { build: "echo ok" } }, null, 2),
  );
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.js"), "export const x = 1;\n");

  // Initialize vf context + a single work unit, then run a REAL bridge dispatch.
  // VIBEFLOW_AI is set for every call so init/orchestrate take the offline bridge path
  // (the named engine CLI is never spawned, so no real claude/codex is required).
  // --no-ai skips the AI enrichment phase of `vf init` (the 7-unit agent-team workflow
  // introduced in PR#43 + made default in PR#48). On CI the real `claude` binary either
  // doesn't exist (preflight no-binary → ok:false, init returns in ms) or does exist but
  // hangs on the API call (times out at 600s). The deterministic context files are
  // sufficient for the ship-gate — orchestrate is the path the smoke actually exercises.
  const bridge = { VIBEFLOW_AI: `node ${FAKE}` };
  run(["init", "--engine", "claude", "--no-ai"], bridge);
  run(["units", "add", "smoke-unit"], bridge);
  const out = run(["orchestrate", "--engine", "claude"], bridge);

  // The dispatch must have run through the bridge (not dry) and produced a goal verdict.
  if (!/goal:/.test(out)) fail("orchestrate produced no goal verdict", out);

  // Evidence must be persisted for the unit — the real spawn→parse→persist path worked.
  const state = JSON.parse(readFileSync(join(repo, ".vibeflow", "WORKFLOW_STATE.json"), "utf8"));
  const unit = (state.work_units || []).find((u) => u.name === "smoke-unit");
  if (!unit) fail("smoke-unit missing from the ledger after orchestrate", out);
  if (unit.status === "pending") fail(`unit never dispatched (status=${unit.status})`, out);
  if (!unit.evidence || unit.evidence.length === 0) {
    fail("no evidence persisted for the dispatched unit", out);
  }

  console.log(
    `✓ ship-gate smoke OK — unit status=${unit.status}, evidence=${unit.evidence.length}`,
  );
  rmSync(repo, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  fail("threw while driving the CLI", err?.stdout ? err.stdout : String(err));
}

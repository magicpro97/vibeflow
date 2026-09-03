import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake, mutateUnits, orchestrate } from "../src/commands.js";
import { CTX_DIR, type WorkflowState, readState } from "../src/core.js";
import type { EngineProcessSpawner } from "../src/dispatch/session-types.js";
import { policyGates } from "../src/gates.js";
import { resolveSkillNeeds } from "../src/skills/resolver.js";

/**
 * Golden path: a fresh repo is taken from intake → scan → demand-driven skill needs →
 * parallel orchestration (dry) → policy gates. Proves the whole pipeline is wired and
 * the verification story holds at every step.
 */
describe("e2e golden path", () => {
  const claudeEnvelope = (confidence: number, uncertainty = "") =>
    JSON.stringify({
      type: "result",
      session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
      result: `\`\`\`json\n{ "confidence": ${confidence}, "uncertainty": "${uncertainty}" }\n\`\`\``,
    });
  const processSpawner = (
    stdout: string,
    hooks: { onStart?: () => void; onFinish?: () => void; delayMs?: number } = {},
  ): EngineProcessSpawner => {
    const { onStart, onFinish, delayMs = 0 } = hooks;
    return () => {
      onStart?.();
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stdout));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited: new Promise<number>((resolve) =>
          setTimeout(() => {
            onFinish?.();
            resolve(0);
          }, delayMs),
        ),
        kill: () => onFinish?.(),
      };
    };
  };

  test("init → scan → resolve needs → orchestrate (dry) → gates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-e2e-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "shop-api",
          scripts: { build: "tsc", test: "bun test" },
          dependencies: { express: "^4.19.0" },
        }),
      );
      writeFileSync(join(dir, "README.md"), "# Shop API\n\nA small commerce backend.\n");

      // 1) Intake + scan: PROJECT_CONTEXT reflects the real detected stack.
      const { state } = await applyIntake(
        { goal: "Add product search endpoint", engines: ["claude"] },
        { useAi: false, base: dir },
      );
      expect(state.goal).toBe("Add product search endpoint");
      const projectCtx = readFileSync(join(dir, `${CTX_DIR}/PROJECT_CONTEXT.md`), "utf8");
      expect(projectCtx).toContain("Express");
      expect(projectCtx).toContain("Detected stack");

      // 2) Demand-driven skill needs: detected framework → docs need (acquire on demand).
      const needs = resolveSkillNeeds({ repo: dir, task: state.goal, profile: undefined });
      expect(Array.isArray(needs)).toBe(true);

      // 3) Orchestrate (dry): a READ-ONLY preview — leaves WORKFLOW_STATE.json byte-identical
      //    (no work unit persisted, no evidence recorded), only CONTEXT.md previews are written.
      const statePath = join(dir, `${CTX_DIR}/WORKFLOW_STATE.json`);
      const stateBefore = readFileSync(statePath, "utf8");
      const code = await orchestrate({ engine: "claude", dry: true }, dir);
      expect(code).toBe(0); // dry run is not "blocked"
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore); // persisted ledger untouched

      // 4) Gates: a real unit at confidence<1 must fail before close (no completion on a guess).
      mutateUnits(dir, "add", { name: "search" });
      const afterOrch = readState(dir) as WorkflowState;
      const unit = afterOrch.work_units[0];
      expect(policyGates(afterOrch).ok).toBe(false);

      // 5) Simulate a verified completion → gates pass (auditable close).
      mutateUnits(dir, "update", {
        name: unit?.name,
        status: "done",
        confidence: 1,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        evidence: ["src/gates.ts:47 — verified implementation"],
      });
      const finalState = readState(dir) as WorkflowState;
      expect(policyGates(finalState).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-dry confidence<1 still blocks (investigated, not silently closed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-block-"));
    try {
      await applyIntake(
        { goal: "Add risky thing", engines: ["claude"] },
        { useAi: false, base: dir },
      );
      // Inject a spawner that always reports low confidence (0.4). The bounded investigation
      // runs but cannot reach 1.0, so the unit must stay blocked → orchestrate exits 1.
      const code = await orchestrate({ engine: "claude", yes: true }, dir, {
        sessionRuntime: {
          processSpawner: processSpawner(claudeEnvelope(0.4, "still unsure")),
        },
      });
      expect(code).toBe(1); // a real confidence<1 run blocks (no completion on a guess)
      const after = readState(dir) as WorkflowState;
      const unit = after.work_units[0];
      expect(unit?.status).toBe("blocked");
      // Investigation evidence is recorded (dispatch result + investigation.json).
      expect(unit?.evidence?.some((e) => e.includes("investigation.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overlapping work-unit scopes are NOT dispatched concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scope-"));
    try {
      await applyIntake({ goal: "Touch auth", engines: ["claude"] }, { useAi: false, base: dir });
      // Two units with overlapping scopes (src/auth/ ⊃ src/auth/login.ts).
      mutateUnits(dir, "add", { name: "a", scope: ["src/auth/"] });
      mutateUnits(dir, "add", { name: "b", scope: ["src/auth/login.ts"] });

      let inFlight = 0;
      let maxInFlight = 0;
      await orchestrate({ engine: "claude", yes: true }, dir, {
        sessionRuntime: {
          processSpawner: processSpawner(claudeEnvelope(1), {
            delayMs: 5,
            onStart: () => {
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
            },
            onFinish: () => {
              inFlight--;
            },
          }),
        },
      });
      // Overlapping scopes serialize: at most one dispatch runs at a time.
      expect(maxInFlight).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disjoint scopes are dispatched concurrently (parallel preserved)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-parallel-"));
    try {
      await applyIntake({ goal: "Two lanes", engines: ["claude"] }, { useAi: false, base: dir });
      mutateUnits(dir, "add", { name: "a", scope: ["src/auth/"] });
      mutateUnits(dir, "add", { name: "b", scope: ["src/ui/"] });

      let inFlight = 0;
      let maxInFlight = 0;
      await orchestrate({ engine: "claude", yes: true, concurrency: "2" }, dir, {
        sessionRuntime: {
          processSpawner: processSpawner(claudeEnvelope(1), {
            delayMs: 5,
            onStart: () => {
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
            },
            onFinish: () => {
              inFlight--;
            },
          }),
        },
      });
      // Disjoint scopes overlap under the bounded pool.
      expect(maxInFlight).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("already-complete units are NOT re-dispatched (only incomplete ones run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-skipdone-"));
    try {
      await applyIntake(
        { goal: "Two units, one finished", engines: ["claude"] },
        { useAi: false, base: dir },
      );
      mutateUnits(dir, "add", { name: "alpha", scope: ["src/a/"] });
      mutateUnits(dir, "add", { name: "beta", scope: ["src/b/"] });
      // alpha is already finished: done @ conf 1 with evidence → must be skipped.
      mutateUnits(dir, "update", {
        name: "alpha",
        status: "done",
        confidence: 1,
        evidence: ["src/gates.ts:47 — verified implementation"],
      });

      const dispatched: string[] = [];
      const successSpawner = processSpawner(claudeEnvelope(1));
      await orchestrate({ engine: "claude", yes: true }, dir, {
        sessionRuntime: {
          processSpawner: (argv, options) => {
            dispatched.push(argv.join(" "));
            return successSpawner(argv, options);
          },
        },
      });

      // Exactly one engine round-trip — for beta, never for the finished alpha.
      expect(dispatched.length).toBe(1);
      // Both units survive in the ledger (alpha carried through, not dropped).
      const after = readState(dir) as WorkflowState;
      expect(after.work_units.map((u) => u.name).sort()).toEqual(["alpha", "beta"]);
      expect(after.work_units.find((u) => u.name === "alpha")?.status).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orchestrate with every unit complete dispatches nothing and reports the verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-alldone-"));
    try {
      await applyIntake(
        { goal: "Already finished", engines: ["claude"] },
        { useAi: false, base: dir },
      );
      mutateUnits(dir, "add", { name: "solo", scope: ["src/solo/"] });
      mutateUnits(dir, "update", {
        name: "solo",
        status: "done",
        confidence: 1,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        evidence: ["src/gates.ts:47 — verified implementation"],
      });

      let dispatched = 0;
      const successSpawner = processSpawner(claudeEnvelope(1));
      const code = await orchestrate({ engine: "claude", yes: true }, dir, {
        sessionRuntime: {
          processSpawner: (argv, options) => {
            dispatched++;
            return successSpawner(argv, options);
          },
        },
      });
      // No dispatch at all, and the goal is met → exit 0.
      expect(dispatched).toBe(0);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

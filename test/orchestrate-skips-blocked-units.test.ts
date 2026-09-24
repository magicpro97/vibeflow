import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectDispatchUnits } from "../src/commands/_shared.js";
import { orchestrate } from "../src/commands/orchestrate.js";
import { type WorkUnit, type WorkflowState, readState } from "../src/core.js";
import { WORK_UNIT_DISPATCH, WORK_UNIT_STATUS } from "../src/core/workflow-contract.js";
import type { EngineProcessSpawner } from "../src/dispatch/session-types.js";
import type { GitRunner } from "../src/safety/checkpoint.js";

// #783 regression: `vf orchestrate` dispatches blocked work units, breaking sequential gating.
// Only `pending` units are dispatchable; every other status stays out of the engine run and is
// reported as skipped (blocked explicitly, never silently dropped).

const unit = (name: string, status: WorkUnit["status"]): WorkUnit => ({
  name,
  status,
  confidence: 0,
  scope: [`src/${name}.ts`],
  gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
  resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
});

/** u1 pending · u2/u3 blocked · u4 running · u5 verifying · u6 done — one unit per status. */
const MIXED: WorkUnit[] = [
  unit("u1-pending", WORK_UNIT_STATUS.PENDING),
  unit("u2-blocked", WORK_UNIT_STATUS.BLOCKED),
  unit("u3-blocked", WORK_UNIT_STATUS.BLOCKED),
  unit("u4-running", WORK_UNIT_STATUS.RUNNING),
  unit("u5-verifying", WORK_UNIT_STATUS.VERIFYING),
  unit("u6-done", WORK_UNIT_STATUS.DONE),
];

const ledger = (units: WorkUnit[]): WorkflowState => ({
  task_id: "repro-783",
  goal: "sequential gating (#783)",
  success_criteria: [],
  work_units: units,
  totals: { units: units.length, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
});

const writeLedger = (base: string, units: WorkUnit[]): void => {
  mkdirSync(join(base, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(base, ".vibeflow", "WORKFLOW_STATE.json"),
    JSON.stringify(ledger(units), null, 2),
  );
};

/** Capture the CLI report: `out` prints through console.log, the non-TTY spinner through console.error. */
const capture = async (run: () => Promise<number>): Promise<{ code: number; text: string }> => {
  const lines: string[] = [];
  const [originalLog, originalError] = [console.log, console.error];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { code: await run(), text: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const completedEngineProcess = (stdout: string) => ({
  stdin: { write: () => {}, end: () => {} },
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout));
      controller.close();
    },
  }),
  stderr: new ReadableStream({ start: (controller) => controller.close() }),
  exited: Promise.resolve(0),
  kill: () => {},
});

const noGit: GitRunner = () => ({ status: 128, stdout: "", stderr: "not a git repository" });

describe("vf orchestrate dispatch policy (#783)", () => {
  test("dispatches pending only and groups every other status under its disposition", () => {
    const { dispatch, skipped } = selectDispatchUnits(MIXED);

    expect(dispatch.map((u) => u.name)).toEqual(["u1-pending"]);
    expect(
      skipped.map((group) => [group.disposition, group.units.map((u) => u.name)] as const),
    ).toEqual([
      [WORK_UNIT_DISPATCH.BLOCKED, ["u2-blocked", "u3-blocked"]],
      [WORK_UNIT_DISPATCH.IN_FLIGHT, ["u4-running"]],
      [WORK_UNIT_DISPATCH.AWAITING_VERIFICATION, ["u5-verifying"]],
      [WORK_UNIT_DISPATCH.ALREADY_COMPLETE, ["u6-done"]],
    ]);
  });

  test("dispatches no unit at all when nothing is pending", () => {
    const { dispatch, skipped } = selectDispatchUnits(
      MIXED.filter((u) => u.status !== WORK_UNIT_STATUS.PENDING),
    );

    expect(dispatch).toEqual([]);
    expect(skipped.flatMap((group) => group.units)).toHaveLength(5);
  });
});

describe("vf orchestrate skips blocked units (#783)", () => {
  let dir = "";

  beforeAll(() => {
    dir = join(tmpdir(), `vf-test-783-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    writeLedger(dir, MIXED);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry-run preview counts and dispatches pending units only, reporting every skip", async () => {
    const { code, text } = await capture(() => orchestrate({ engine: "codex", dry: true }, dir));

    // Dry preview: only the pending unit is in the dispatch set.
    expect(text).toContain("Orchestrating 1 unit(s)");
    expect(text).toContain("Dispatched 1 unit(s)");
    expect(text).not.toContain("Dispatched 6 unit(s)");
    // Excluded statuses are reported, never silently dropped.
    expect(text).toContain("Skipping 2 blocked unit(s): u2-blocked, u3-blocked");
    expect(text).toContain("Skipping 1 in-flight unit(s): u4-running");
    expect(text).toContain("Skipping 1 awaiting-verification unit(s): u5-verifying");
    expect(text).toContain("Skipping 1 already-complete unit(s): u6-done");
    // ...and no prompt is materialized for them.
    expect(readdirSync(join(dir, ".vibeflow", "workunits"))).toEqual(["u1-pending"]);
    // Blocked units keep the run from reporting "met".
    expect(code).toBe(1);
    expect(text).toContain("- blocked: u2-blocked");
  });

  test("a real (cli) run launches the engine for the pending unit only", async () => {
    const fresh = join(tmpdir(), `vf-test-783-cli-${process.pid}`);
    rmSync(fresh, { recursive: true, force: true });
    writeLedger(fresh, MIXED);
    const launched: string[] = [];
    const spawner: EngineProcessSpawner = (command) => {
      launched.push(command.join(" "));
      return completedEngineProcess(
        JSON.stringify({
          type: "result",
          session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
          result: '```json\n{"confidence": 1}\n```',
        }),
      );
    };

    const { code } = await capture(() =>
      orchestrate({ engine: "claude", yes: true }, fresh, {
        sessionRuntime: { processSpawner: spawner },
        git: noGit,
        gate: () => ({ pass: true }),
      }),
    );

    expect(launched).toHaveLength(1);
    // The ledger keeps every unit: skipped ones survive untouched, only the pending one ran.
    const persisted = readState(fresh);
    expect(persisted?.work_units).toHaveLength(MIXED.length);
    expect(persisted?.work_units.find((u) => u.name === "u2-blocked")).toMatchObject({
      name: "u2-blocked",
      status: "blocked",
      confidence: 0,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    });
    expect(persisted?.work_units.find((u) => u.name === "u6-done")).toMatchObject({
      name: "u6-done",
      status: "done",
    });
    expect(code).toBe(1); // blocked unit keeps the goal verdict at "blocked"
    rmSync(fresh, { recursive: true, force: true });
  });
});

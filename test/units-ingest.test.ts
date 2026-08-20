import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../src/commands/_shared.js";
import type { makeReviewer } from "../src/commands/dispatch-reviewer.js";
import { normalizeUnit } from "../src/commands/dispatch.js";
import { type UnitsIngestInject, unitsIngest } from "../src/commands/units-ingest.js";
import { units } from "../src/commands/units.js";
import { isVerifiableEvidence, policyGates } from "../src/gates.js";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const state = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), "utf8"));

type Evidence = { dir: string; rawPath: string; usagePath: string };
const contractHash = "a".repeat(64);

function repo(name = "unit") {
  const dir = mkdtempSync(join(tmpdir(), "vf-ingest-"));
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(dir, ".vibeflow", "WORKFLOW_STATE.json"),
    JSON.stringify({
      goal: "test",
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      work_units: [
        {
          name,
          status: "pending",
          confidence: 0,
          scope: ["src", "test"],
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
    }),
  );
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ".vibeflow/\n");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src", "work.ts"), "export const work = 1;\n");
  writeFileSync(join(dir, "test", "work.test.ts"), "export {};\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-s", "-m", "base");
  writeFileSync(join(dir, "src", "work.ts"), "export const work = 2;\n");
  writeFileSync(join(dir, "test", "work.test.ts"), "export const work = 2;\n");
  git(dir, "add", "src/work.ts", "test/work.test.ts");
  git(dir, "commit", "-q", "-s", "-m", "work");
  return dir;
}

function validRaw() {
  return 'worker output\n```json\n{"skills_used":["typescript"],"files_changed":["src/work.ts","test/work.test.ts"],"commands_run":["bun test test/work.test.ts"],"tests_run":["test/work.test.ts"],"confidence":0.9,"uncertainty":"none"}\n```\n```yaml\nresult: done\nfiles: [src/work.ts]\nproof: [test]\nopen: []\n```\n';
}

function evidence(raw = validRaw(), patch: Record<string, unknown> = {}): Evidence {
  const dir = mkdtempSync(join(tmpdir(), "vf-ingest-evidence-"));
  const rawPath = join(dir, "result.txt");
  const usagePath = join(dir, "usage.json");
  writeFileSync(rawPath, raw);
  writeFileSync(
    usagePath,
    JSON.stringify({
      status: "succeeded",
      exit_code: 0,
      timed_out: false,
      result_file: rawPath,
      contract_hash: contractHash,
      stdout_sha256: sha256(raw),
      duration_seconds: 1,
      hermes_usage: { total_tokens: 12, estimated_cost_usd: 0.03, completed: true, failed: false },
      ...patch,
    }),
  );
  return { dir, rawPath, usagePath };
}

function rewriteRaw(e: Evidence, raw: string) {
  writeFileSync(e.rawPath, raw);
  const usage = JSON.parse(readFileSync(e.usagePath, "utf8"));
  usage.result_file = e.rawPath;
  usage.stdout_sha256 = sha256(raw);
  writeFileSync(e.usagePath, JSON.stringify(usage));
}

const passing: UnitsIngestInject = {
  gate: (() => ({ pass: true })) as UnitsIngestInject["gate"],
  run: (() => ({ status: 0, stdout: "ok" })) as UnitsIngestInject["run"],
  reviewer: ((..._args: Parameters<typeof makeReviewer>) =>
    async () => ({ pass: true })) as unknown as UnitsIngestInject["reviewer"],
};

async function ingest(
  dir: string,
  e: Evidence,
  patch: Record<string, string | boolean> = {},
  inject = passing,
) {
  return unitsIngest(
    dir,
    ["unit"],
    {
      producer: "hermes",
      raw: e.rawPath,
      usage: e.usagePath,
      commit: git(dir, "rev-parse", "HEAD"),
      "contract-hash": contractHash,
      ...patch,
    },
    inject,
  );
}

function withTemp<T>(fn: (dir: string, e: Evidence) => Promise<T> | T) {
  const dir = repo();
  const e = evidence();
  return Promise.resolve(fn(dir, e)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(e.dir, { recursive: true, force: true });
  });
}

let commitSequence = 2;
function commit(
  dir: string,
  message: string,
  signed = true,
  paths = ["src/work.ts", "test/work.test.ts"],
) {
  commitSequence++;
  writeFileSync(join(dir, "src", "work.ts"), `export const work = ${commitSequence};\n`);
  writeFileSync(join(dir, "test", "work.test.ts"), `export const work = ${commitSequence};\n`);
  git(dir, "add", ...paths);
  git(dir, "commit", "-q", ...(signed ? ["-s"] : []), "-m", message);
}

describe("units ingest RED contract", () => {
  test("depends-on canonicalizes and normalization round-trips handoffs, acceptance, finite score", () => {
    const dir = repo();
    const before = process.cwd();
    try {
      process.chdir(dir);
      expect(units("add", ["next"], { "depends-on": " a, b ,a,, b " })).toBe(0);
      expect(units("update", ["next"], { spec: "unrelated" })).toBe(0);
      expect(
        state(dir).work_units.find((u: { name: string }) => u.name === "next").depends_on,
      ).toEqual(["a", "b"]);
      const preserved = normalizeUnit({
        name: "x",
        upstreamHandoffs: [{ unit: "a", summary: "ready" }],
        acceptance_criteria: [{ id: "a", criterion: "works" }],
        goal_score: 0.8,
        security: { consent: "run", verdict: "pass", notes: "checked" },
        gates: { build: "pass", security: "pass", goal_eval: "pass" } as never,
      } as any);
      expect(preserved.upstreamHandoffs).toEqual([{ unit: "a", summary: "ready" }]);
      expect(preserved.acceptance_criteria).toEqual([{ id: "a", criterion: "works" }]);
      expect(preserved.goal_score).toBe(0.8);
      expect((preserved as any).security).toEqual({
        consent: "run",
        verdict: "pass",
        notes: "checked",
      });
      expect(preserved.gates).toMatchObject({ security: "pass", goal_eval: "pass" });
      expect(
        normalizeUnit({ name: "x", goal_score: Number.POSITIVE_INFINITY }).goal_score,
      ).toBeUndefined();
    } finally {
      process.chdir(before);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts bounded wrapper stdout, reviews commit range, persists complete done outcome", () =>
    withTemp(async (dir, e) => {
      const commitId = git(dir, "rev-parse", "HEAD");
      let diff = "";
      const code = await ingest(
        dir,
        e,
        {},
        {
          ...passing,
          reviewer: ((...args: Parameters<typeof makeReviewer>) => {
            const opts = args[2];
            return async () => {
              diff = opts?.diffReader?.([], dir) ?? "";
              return { pass: true };
            };
          }) as unknown as UnitsIngestInject["reviewer"],
        },
      );
      expect(code).toBe(0);
      expect(diff).toBe("src/work.ts\ntest/work.test.ts\n");
      expect(diff).not.toContain("diff --git");
      expect(diff).not.toContain("export const work = 2");
      expect(state(dir).work_units[0]).toMatchObject({
        status: "done",
        confidence: 0.9,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 12, cost_usd: 0.03, wall_seconds: 1 },
      });
      expect(state(dir).work_units[0].evidence).toContain(`commit ${commitId}`);
      expect(
        readFileSync(join(dir, ".vibeflow", "workunits", "unit", "evidence", "hermes.raw"), "utf8"),
      ).toBe(validRaw());
    }));

  test("ancestor commit remains reviewable after HEAD advances", () =>
    withTemp(async (dir, e) => {
      const commitId = git(dir, "rev-parse", "HEAD");
      const oldBytes = readFileSync(join(dir, "src", "work.ts"), "utf8");
      writeFileSync(join(dir, "src", "work.ts"), "export const work = 99;\n");
      git(dir, "add", "src/work.ts");
      git(dir, "commit", "-q", "-s", "-m", "later");
      let gateCwd = "";
      expect(
        await ingest(
          dir,
          e,
          { commit: commitId },
          {
            ...passing,
            gate: ((input: { cwd: string }) => {
              gateCwd = input.cwd;
              expect(readFileSync(join(input.cwd, "src", "work.ts"), "utf8")).toBe(oldBytes);
              return { pass: true };
            }) as UnitsIngestInject["gate"],
          },
        ),
      ).toBe(0);
      expect(gateCwd).not.toBe(dir);
    }));

  test("builds detached snapshot before scoped gate", () =>
    withTemp(async (dir, e) => {
      const calls: Array<[string, string]> = [];
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            run: ((command, cwd) => {
              calls.push([command, cwd]);
              return { status: 0, stdout: "built" };
            }) as UnitsIngestInject["run"],
            gate: ((input: { cwd: string }) => {
              expect(calls).toEqual([["bun run --cwd src/ui build", input.cwd]]);
              return { pass: true };
            }) as UnitsIngestInject["gate"],
          },
        ),
      ).toBe(0);
      expect(calls[0]?.[1]).not.toBe(dir);
      expect(state(dir).work_units[0].evidence).toContain(
        'bun run --cwd src/ui build → "exit 0: built"',
      );
    }));

  test("blocks on snapshot build failure before gate or review", () =>
    withTemp(async (dir, e) => {
      let gateCalled = false;
      let reviewerCalled = false;
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            run: (() => ({
              status: 1,
              stdout: "Bun banner\nUI build exploded",
            })) as UnitsIngestInject["run"],
            gate: (() => {
              gateCalled = true;
              return { pass: true };
            }) as UnitsIngestInject["gate"],
            reviewer: ((..._args: Parameters<typeof makeReviewer>) => {
              reviewerCalled = true;
              return async () => ({ pass: true });
            }) as unknown as UnitsIngestInject["reviewer"],
          },
        ),
      ).toBe(1);
      expect(gateCalled).toBeFalse();
      expect(reviewerCalled).toBeFalse();
      expect(state(dir).work_units[0]).toMatchObject({
        status: "blocked",
        confidence: 0,
        gates: { build: "fail", lint: "pending", test: "pending", review: "pending" },
      });
      expect(state(dir).work_units[0].evidence).toContain(
        'bun run --cwd src/ui build → "exit 1: Bun banner UI build exploded"',
      );
    }));

  test("canonical reviewer needs exact-commit name-status paths", () =>
    withTemp(async (dir, e) => {
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            gate: (() => ({ pass: true })) as UnitsIngestInject["gate"],
          },
        ),
      ).toBe(0);
    }));

  test("keeps measured metadata and trusted reviewer evidence", () =>
    withTemp(async (dir, e) => {
      const s = state(dir);
      s.work_units[0] = {
        ...s.work_units[0],
        evidence: ["commit 1234567890abcdef", "commit fedcba0987654321"],
        evidence_at: { "commit 1234567890abcdef": "2000-01-01T00:00:00.000Z" },
      };
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
      let outcome: unknown;
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            reviewer: ((..._args: Parameters<typeof makeReviewer>) =>
              async (_unit: any, value: any) => {
                outcome = value;
                return { pass: true };
              }) as unknown as UnitsIngestInject["reviewer"],
          },
        ),
      ).toBe(0);
      expect(state(dir).work_units[0]).toMatchObject({
        skills_used: ["typescript"],
        evidence_at: { "commit 1234567890abcdef": "2000-01-01T00:00:00.000Z" },
      });
      expect(state(dir).work_units[0].evidence_at["commit fedcba0987654321"]).toBeUndefined();
      expect(outcome).toMatchObject({ commit: git(dir, "rev-parse", "HEAD") });
      expect(JSON.stringify(outcome)).not.toContain("commands_run");
    }));

  test("persists reviewer acceptance evidence without mutating ledger review input", () =>
    withTemp(async (dir, e) => {
      const acceptance = 'acceptance AC1: bun test → "ok"';
      let reviewedEvidence: string[] | undefined;
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            reviewer: ((..._args: Parameters<typeof makeReviewer>) =>
              async (reviewUnit: { evidence?: string[] }) => {
                reviewedEvidence = reviewUnit.evidence;
                reviewUnit.evidence = [...(reviewUnit.evidence ?? []), acceptance];
                return { pass: true };
              }) as unknown as UnitsIngestInject["reviewer"],
          },
        ),
      ).toBe(0);
      expect(reviewedEvidence).toBeUndefined();
      expect(state(dir).work_units[0].evidence).toContain(acceptance);
      expect(state(dir).work_units[0].evidence_at[acceptance]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }));

  test("retains block evidence and fails when final mutation returns null", async () => {
    await withTemp(async (dir, e) => {
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            gate: (() => ({
              pass: false,
              failedGate: "test",
              detail: "red",
            })) as UnitsIngestInject["gate"],
          },
        ),
      ).toBe(1);
      expect(state(dir).work_units[0]).toMatchObject({
        gates: { test: "fail" },
        resources: { agents: 1, tokens: 12, cost_usd: 0.03, wall_seconds: 1 },
        evidence: expect.arrayContaining(['vf units ingest → "gate test: red"']),
      });
    });
  });

  test("successful retry normalizes eligible legacy failure and passes policy", () =>
    withTemp(async (dir, e) => {
      const measured = 'bun test --timeout 30000 → "exit 1: exact failure bytes"';
      const reason = "gate test: exact failure";
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            run: ((command) =>
              command.includes("test")
                ? { status: 1, stdout: "exact failure bytes" }
                : { status: 0, stdout: "ok" }) as UnitsIngestInject["run"],
            gate: (({ run }) => {
              run?.("bunx biome check src test", dir);
              run?.("bun test --timeout 30000", dir);
              return { pass: false, failedGate: "test", detail: "exact failure" };
            }) as UnitsIngestInject["gate"],
          },
        ),
      ).toBe(1);
      const s = state(dir);
      const normalized = `vf units ingest → ${JSON.stringify(reason)}`;
      const at = s.work_units[0].evidence_at[measured];
      expect(s.work_units[0].evidence).toContain(measured);
      s.work_units[0].evidence = s.work_units[0].evidence.map((item: string) =>
        item === normalized ? reason : item,
      );
      s.work_units[0].evidence_at[reason] = at;
      delete s.work_units[0].evidence_at[normalized];
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
      expect(await ingest(dir, e)).toBe(0);
      const result = state(dir);
      expect(result.work_units[0].status).toBe("done");
      expect(result.work_units[0].evidence.filter((item: string) => item === measured)).toEqual([
        measured,
      ]);
      expect(result.work_units[0].evidence).not.toContain(reason);
      expect(result.work_units[0].evidence_at).toMatchObject({ [measured]: at, [normalized]: at });
      expect(result.work_units[0].evidence_at[reason]).toBeUndefined();
      expect(result.work_units[0].evidence).toContain('bun run --cwd src/ui build → "exit 0: ok"');
      expect(policyGates(result, { base: dir }).ok).toBeTrue();
    }));

  test("preserves buried legacy retry history", () =>
    withTemp(async (dir, e) => {
      const measured = 'bun test --timeout 30000 → "exit 1: old bytes"';
      const reason = "gate test: old reason";
      const canonical = `vf units ingest → ${JSON.stringify(reason)}`;
      const legacy = `vf units ingest legacy → ${JSON.stringify(reason)}`;
      const policy = 'vf units ingest → "policy gate failed"';
      const oldAt = "2026-01-01T00:00:00.000Z";
      const newAt = "2026-01-02T00:00:00.000Z";
      const policyAt = "2026-01-03T00:00:00.000Z";
      const original = [measured, reason, canonical, policy];
      const s = state(dir);
      Object.assign(s.work_units[0], {
        status: "blocked",
        knowledge_heavy: true,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        evidence: original,
        evidence_at: { [measured]: oldAt, [reason]: oldAt, [canonical]: newAt, [policy]: policyAt },
      });
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
      const rawPath = join(dir, ".vibeflow", "workunits", "unit", "evidence", "hermes.raw");
      mkdirSync(join(rawPath, ".."), { recursive: true });
      writeFileSync(rawPath, "validated old raw");
      const attempted = git(dir, "rev-parse", "HEAD");
      const reviewerEvidence = 'acceptance attempted: bun test → "ok"';
      const inject = {
        ...passing,
        reviewer: (() => async (unit: WorkUnit) => {
          unit.evidence = [...(unit.evidence ?? []), reviewerEvidence];
          return { pass: true };
        }) as unknown as UnitsIngestInject["reviewer"],
      };
      expect(await ingest(dir, e, {}, inject)).toBe(1);
      let row = state(dir).work_units[0];
      expect(row.evidence.slice(0, 4)).toEqual([measured, legacy, canonical, policy]);
      expect(row.evidence).toHaveLength(5);
      expect(row.evidence_at).toMatchObject({
        [measured]: oldAt,
        [legacy]: oldAt,
        [canonical]: newAt,
        [policy]: policyAt,
      });
      expect(row.evidence_at[reason]).toBeUndefined();
      expect(row.evidence).not.toContain(`commit ${attempted}`);
      expect(row.evidence).not.toContain(reviewerEvidence);
      expect(readFileSync(rawPath, "utf8")).toBe("validated old raw");
      const repaired = state(dir);
      repaired.work_units[0].knowledge_heavy = false;
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(repaired));
      expect(await ingest(dir, e, {}, inject)).toBe(0);
      row = state(dir).work_units[0];
      expect(row.status).toBe("done");
      expect(row.evidence.slice(0, 4)).toEqual([measured, legacy, canonical, policy]);
      expect(row.evidence_at).toMatchObject({
        [measured]: oldAt,
        [legacy]: oldAt,
        [canonical]: newAt,
      });
      expect(row.evidence.filter((item: string) => item === `commit ${attempted}`)).toHaveLength(1);
      expect(row.evidence.filter((item: string) => item === reviewerEvidence)).toHaveLength(1);
    }));

  test("buried legacy migration rejects wrapper and replacement collisions", async () => {
    const measured = 'bun test --timeout 30000 → "exit 1: old bytes"';
    const reason = "gate test: old reason";
    const canonical = `vf units ingest → ${JSON.stringify(reason)}`;
    const legacy = `vf units ingest legacy → ${JSON.stringify(reason)}`;
    const oldAt = "2026-01-01T00:00:00.000Z";
    const newAt = "2026-01-02T00:00:00.000Z";
    const cases = [
      { extra: [legacy], map: { [legacy]: "2025-01-01T00:00:00.000Z" } },
      { extra: [], map: { [legacy]: "2025-01-01T00:00:00.000Z" } },
      { extra: ["unrelated"], map: {}, wrapper: `vf units ingest → "gate test: other"` },
      { extra: ["unrelated"], map: {}, wrapper: "arbitrary later evidence" },
    ];
    for (const item of cases)
      await withTemp(async (dir, e) => {
        const wrapper = item.wrapper ?? canonical;
        const evidence = [measured, reason, wrapper, ...item.extra];
        const evidence_at = { [measured]: oldAt, [reason]: oldAt, [wrapper]: newAt, ...item.map };
        const s = state(dir);
        Object.assign(s.work_units[0], {
          status: "blocked",
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          evidence,
          evidence_at,
        });
        writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
        expect(
          await ingest(
            dir,
            e,
            {},
            {
              ...passing,
              gate: (() => ({
                pass: false,
                failedGate: "test",
                detail: "fresh",
              })) as UnitsIngestInject["gate"],
            },
          ),
        ).toBe(1);
        const row = state(dir).work_units[0];
        expect(row.evidence.slice(0, evidence.length)).toEqual(evidence);
        expect(
          Object.fromEntries(Object.keys(evidence_at).map((key) => [key, row.evidence_at[key]])),
        ).toEqual(evidence_at);
      });
  });

  test("legacy matcher accepts only complete mapped shapes", async () => {
    const rows: Array<[string, boolean]> = [
      ['bun test --timeout 30000 → "exit -1: x"', true],
      ['bun test --timeout 30000 → "exit 1: "', true],
      ['bun test --timeout 30000 → "exit 2: \\"x\\""', true],
      ['bun test --timeout 30000 → "exit 1: x"\n', false],
      ['bun test --timeout 30000 → "exit 1: x\ry"', false],
      ['bun test --timeout 30000 → "exit 1: x\ny"', false],
      ['bun test --timeout 30000 → "exit 1: x"garbage', false],
      ['bun test --timeout 30000 → "exit 1: x', false],
      ['bun test --timeout 30000 → "exit 1: "x""', false],
      ['bun test --timeout 30000 → "exit 0: x"', false],
      ['bunx biome check src test → "exit 1: file.ts:1"', false],
    ];
    for (const [measured, eligible] of rows)
      await withTemp(async (dir, e) => {
        const s = state(dir);
        const reason = "gate test: historical";
        const at = "2026-01-01T00:00:00.000Z";
        Object.assign(s.work_units[0], {
          status: "blocked",
          gates: { build: "pass", lint: "pass", test: "fail", review: "pending" },
          evidence: [measured, reason],
          evidence_at: { [measured]: at, [reason]: at },
        });
        writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
        expect(await ingest(dir, e)).toBe(eligible ? 0 : 1);
        expect(state(dir).work_units[0].evidence.includes(reason)).toBe(!eligible);
      });
  });

  test("persists complete long controller reason", () =>
    withTemp(async (dir, e) => {
      const reason = `review: ${"x".repeat(450)}`;
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            reviewer: (() => async () => ({ pass: false, reason: "x".repeat(450) })) as any,
          },
        ),
      ).toBe(1);
      const persisted = `vf units ingest → ${JSON.stringify(reason)}`;
      expect(
        state(dir).work_units[0].evidence.filter((item: string) => item === persisted),
      ).toEqual([persisted]);
      expect(persisted).toBe(`vf units ingest → "${reason}"`);
      expect(isVerifiableEvidence(persisted)).toBeTrue();
    }));

  test("done repair changes evidence fields only", () =>
    withTemp(async (dir, e) => {
      expect(await ingest(dir, e)).toBe(0);
      commit(dir, "repair");
      const s = state(dir);
      const sentinel: Required<Omit<WorkUnit, "evidence" | "evidence_at">> = {
        name: "unit",
        status: "done",
        confidence: 0.9,
        riskClass: "feature",
        owner_agent: "owner",
        skills_used: ["old-skill"],
        knowledge_heavy: false,
        knowledge_heavy_source: "risk",
        skills_injected: ["required"],
        skills_required: ["required"],
        skill_waiver: { reason: "waived", at: "2026-01-02T00:00:00.000Z", by: "lead" },
        scope: ["src", "test"],
        spec: "frozen",
        gates: {
          build: "pass",
          lint: "pass",
          test: "pass",
          review: "pass",
          security: "pending",
          goal_eval: "pending",
        },
        goal_score: 0.95,
        resources: { agents: 3, tokens: 777, cost_usd: 7.77, wall_seconds: 77 },
        depends_on: ["prior"],
        upstreamHandoffs: [{ unit: "prior", summary: "ready" }],
        acceptance_criteria: [
          { id: "AC1", criterion: "works", verification: "bun test", priority: "MUST" },
        ],
        canary: {
          file: "src/work.ts",
          author: "test@example.invalid",
          linkedAt: "2026-01-03T00:00:00.000Z",
        },
        impl_fingerprint: { removed: null },
        verified_sha: git(dir, "rev-parse", "HEAD"),
        security: {
          consent: "skip",
          verdict: "skipped",
          notes: "checked",
          items_checked: 2,
          items_failed: [],
        },
      };
      const acceptance = 'acceptance AC1: bun test → "ok"';
      const unit = {
        ...sentinel,
        evidence: [...s.work_units[0].evidence, acceptance],
        evidence_at: { ...s.work_units[0].evidence_at, [acceptance]: "2026-01-04T00:00:00.000Z" },
      };
      s.work_units[0] = unit;
      const oldCommit = unit.evidence.find((item: string) => item.startsWith("commit "));
      const oldAt = { ...unit.evidence_at };
      const before = structuredClone(unit);
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
      rewriteRaw(
        e,
        validRaw()
          .replace('"skills_used":["typescript"]', '"skills_used":["new-skill"]')
          .replace('"confidence":0.9', '"confidence":0.91'),
      );
      const usage = JSON.parse(readFileSync(e.usagePath, "utf8"));
      Object.assign(usage, { duration_seconds: 2 });
      Object.assign(usage.hermes_usage, { total_tokens: 34, estimated_cost_usd: 0.56 });
      writeFileSync(e.usagePath, JSON.stringify(usage));
      expect(await ingest(dir, e)).toBe(0);
      const after = state(dir).work_units[0] as WorkUnit;
      const strip = ({ evidence: _e, evidence_at: _a, ...rest }: WorkUnit) => rest;
      expect(strip(after)).toEqual(strip(before));
      expect(strip(before)).toEqual(strip(after));
      expect(Object.hasOwn(after, "canary")).toBeTrue();
      expect(after.canary).toEqual(before.canary);
      expect(after.evidence_at).toMatchObject(oldAt);
      for (const [item, at] of Object.entries(oldAt))
        expect(after.evidence_at?.[item]).toBe(at as string);
      for (const item of [oldCommit, `commit ${git(dir, "rev-parse", "HEAD")}`])
        expect(after.evidence?.filter((value: string) => value === item)).toHaveLength(1);
      expect(policyGates({ ...state(dir), work_units: [after] }, { base: dir }).ok).toBeTrue();
    }));

  test("blocks policy-invalid preserved done repair without replacing raw", () =>
    withTemp(async (dir, e) => {
      expect(await ingest(dir, e)).toBe(0);
      const rawPath = join(dir, ".vibeflow", "workunits", "unit", "evidence", "hermes.raw");
      const priorRaw = readFileSync(rawPath);
      commit(dir, "invalid done repair");
      const s = state(dir);
      const prior = s.work_units[0];
      prior.confidence = 0.73;
      const priorEvidence = [...prior.evidence];
      const priorEvidenceAt = { ...prior.evidence_at };
      writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
      expect(policyGates(state(dir), { base: dir }).ok).toBeFalse();
      rewriteRaw(
        e,
        validRaw()
          .replace('"skills_used":["typescript"]', '"skills_used":["attempted-skill"]')
          .replace('"confidence":0.9', '"confidence":0.99'),
      );
      const usage = JSON.parse(readFileSync(e.usagePath, "utf8"));
      Object.assign(usage, { duration_seconds: 9 });
      Object.assign(usage.hermes_usage, { total_tokens: 99, estimated_cost_usd: 9.99 });
      writeFileSync(e.usagePath, JSON.stringify(usage));
      const reviewerEvidence = 'acceptance attempted: bun test → "ok"';
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            reviewer: (() => async (unit: WorkUnit) => {
              unit.evidence = [...(unit.evidence ?? []), reviewerEvidence];
              return { pass: true };
            }) as unknown as UnitsIngestInject["reviewer"],
          },
        ),
      ).toBe(1);
      const reloaded = state(dir);
      const after = reloaded.work_units[0];
      expect(after).toMatchObject({
        status: "blocked",
        confidence: 0,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 99, cost_usd: 9.99, wall_seconds: 9 },
      });
      expect(reloaded.totals.done).toBe(0);
      expect(readFileSync(rawPath)).toEqual(priorRaw);
      for (const item of priorEvidence) expect(after.evidence).toContain(item);
      for (const [item, at] of Object.entries(priorEvidenceAt))
        expect(after.evidence_at[item]).toBe(at);
      expect(after.evidence).toContain('bun run --cwd src/ui build → "exit 0: ok"');
      expect(after.evidence).toContain('vf units ingest → "policy gate failed"');
      expect(after.evidence).not.toContain(`commit ${git(dir, "rev-parse", "HEAD")}`);
      expect(after.evidence).not.toContain(reviewerEvidence);
      expect(after.skills_used).toEqual(prior.skills_used);
    }));

  test("legacy normalization preserves independent normalized collisions", async () => {
    for (const collision of ["evidence", "key"] as const)
      await withTemp(async (dir, e) => {
        const s = state(dir);
        const measured = 'bun test --timeout 30000 → "exit 1: old bytes"';
        const reason = "gate test: old reason";
        const normalized = `vf units ingest → ${JSON.stringify(reason)}`;
        const at = "2026-01-01T00:00:00.000Z";
        const collisionAt = "2025-05-05T05:05:05.000Z";
        const evidence =
          collision === "evidence" ? [normalized, measured, reason] : [measured, reason];
        const evidence_at = {
          [measured]: at,
          [reason]: at,
          untouched: "2024-04-04T04:04:04.000Z",
          ...(collision === "key" ? { [normalized]: collisionAt } : {}),
        };
        Object.assign(s.work_units[0], {
          status: "blocked",
          gates: { build: "pass", lint: "pass", test: "fail", review: "pending" },
          evidence,
          evidence_at,
        });
        const rawPath = join(dir, ".vibeflow", "workunits", "unit", "evidence", "hermes.raw");
        mkdirSync(join(rawPath, ".."), { recursive: true });
        writeFileSync(rawPath, "raw sentinel");
        writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
        expect(await ingest(dir, e)).toBe(1);
        const row = state(dir).work_units[0];
        expect(readFileSync(rawPath, "utf8")).toBe("raw sentinel");
        expect(row.evidence.filter((item: string) => item === normalized)).toHaveLength(
          collision === "evidence" ? 1 : 0,
        );
        expect(row.evidence).toContain(reason);
        expect(row.evidence).toContain(measured);
        for (const [item, timestamp] of Object.entries(evidence_at))
          expect(row.evidence_at[item]).toBe(timestamp);
        if (collision === "evidence") expect(row.evidence_at[normalized]).toBeUndefined();
        else expect(row.evidence_at[normalized]).toBe(collisionAt);
      });
  });

  test("leaves structurally ineligible legacy rows unchanged", async () => {
    const rows: Array<[string, string, string | undefined, boolean]> = [
      ["unrelated", 'bun test --timeout 30000 → "exit 1: x"', "2026-01-01T00:00:00.000Z", true],
      ["gate test:", 'bun test --timeout 30000 → "exit 1: x"', "2026-01-01T00:00:00.000Z", true],
      [
        "gate test: wrong command",
        'bunx biome check src → "exit 1: x"',
        "2026-01-01T00:00:00.000Z",
        true,
      ],
      ["gate test: missing timestamp", 'bun test --timeout 30000 → "exit 1: x"', undefined, true],
      [
        "gate test: nonfinal",
        'bun test --timeout 30000 → "exit 1: x"',
        "2026-01-01T00:00:00.000Z",
        false,
      ],
    ];
    for (const [reason, measured, at, final] of rows)
      await withTemp(async (dir, e) => {
        const s = state(dir);
        Object.assign(s.work_units[0], {
          status: "blocked",
          gates: { build: "pass", lint: "pass", test: "fail", review: "pending" },
          evidence: final ? [measured, reason] : [measured, reason, "later free text"],
          evidence_at: at
            ? { [measured]: at, [reason]: at }
            : { [measured]: "2026-01-01T00:00:00.000Z" },
        });
        writeFileSync(join(dir, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
        expect(await ingest(dir, e)).toBe(1);
        expect(state(dir).work_units[0].evidence).toContain(reason);
      });
  });

  test("final mutation returning null exits 1", () =>
    withTemp((dir, e) =>
      expect(ingest(dir, e, {}, { ...passing, mutate: () => null } as any)).resolves.toBe(1),
    ));

  test("copies validated raw bytes once and rejects destination symlink", async () => {
    await withTemp(async (dir, e) => {
      const validated = readFileSync(e.rawPath);
      let reads = 0;
      expect(
        await ingest(
          dir,
          e,
          {},
          {
            ...passing,
            read: (p) => {
              const bytes = readFileSync(p);
              if (++reads === 1) writeFileSync(e.rawPath, "mutated after validation");
              return bytes;
            },
          },
        ),
      ).toBe(0);
      expect(
        readFileSync(join(dir, ".vibeflow", "workunits", "unit", "evidence", "hermes.raw")),
      ).toEqual(validated);
    });
    await withTemp(async (dir, e) => {
      const outside = join(e.dir, "outside");
      writeFileSync(outside, "sentinel");
      const evidenceDir = join(dir, ".vibeflow", "workunits", "unit", "evidence");
      mkdirSync(evidenceDir, { recursive: true });
      symlinkSync(outside, join(evidenceDir, "hermes.raw"));
      expect(await ingest(dir, e)).toBe(1);
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    });
  });

  test("rejection matrix has named cases and blocks every row", async () => {
    const cases: Array<[string, (dir: string, e: Evidence) => Promise<number>]> = [
      [
        "missing state",
        async (d, e) => {
          rmSync(join(d, ".vibeflow", "WORKFLOW_STATE.json"));
          return ingest(d, e);
        },
      ],
      [
        "missing unit",
        (d, e) =>
          unitsIngest(d, ["none"], {
            producer: "hermes",
            raw: e.rawPath,
            usage: e.usagePath,
            commit: git(d, "rev-parse", "HEAD"),
          }),
      ],
      ["unknown producer", (d, e) => ingest(d, e, { producer: "codex" })],
      ["relative evidence", (d, e) => ingest(d, e, { raw: "result.txt" })],
      ["non-normalized evidence", (d, e) => ingest(d, e, { raw: `${e.dir}/x/../result.txt` })],
      ["missing evidence", (d, e) => ingest(d, e, { raw: join(e.dir, "none") })],
      [
        "directory evidence",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.result_file = e.dir;
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e, { raw: e.dir });
        },
      ],
      ["equal paths", (d, e) => ingest(d, e, { usage: e.rawPath })],
      [
        "symlink",
        (d, e) => {
          const link = join(e.dir, "link");
          symlinkSync(e.rawPath, link);
          return ingest(d, e, { raw: link });
        },
      ],
      ["uppercase commit", (d, e) => ingest(d, e, { commit: "A".repeat(40) })],
      ["missing commit", (d, e) => ingest(d, e, { commit: "a".repeat(40) })],
      [
        "non-ancestor commit",
        (d, e) =>
          ingest(d, e, {
            commit: git(d, "commit-tree", git(d, "rev-parse", "HEAD^{tree}"), "-m", "other"),
          }),
      ],
      [
        "dirty tree",
        async (d, e) => {
          writeFileSync(join(d, "dirty.txt"), "dirty\n");
          return ingest(d, e);
        },
      ],
      [
        "empty diff",
        async (d, e) => {
          git(d, "commit", "-q", "--allow-empty", "-s", "-m", "empty");
          return ingest(d, e);
        },
      ],
      [
        "no committed test",
        async (d, e) => {
          writeFileSync(join(d, "src", "work.ts"), "export const sourceOnly = true;\n");
          git(d, "add", "src/work.ts");
          git(d, "commit", "-q", "-s", "-m", "source only");
          return ingest(d, e);
        },
      ],
      [
        "scope escape",
        async (d, e) => {
          mkdirSync(join(d, "docs"));
          writeFileSync(join(d, "docs", "escape.md"), "x\n");
          writeFileSync(join(d, "test", "work.test.ts"), "export const escaped = true;\n");
          git(d, "add", "docs/escape.md", "test/work.test.ts");
          git(d, "commit", "-q", "-s", "-m", "escape");
          return ingest(d, e);
        },
      ],
      [
        "ancestor-file scope escape",
        async (d, e) => {
          const s = state(d);
          s.work_units[0].scope = ["src/work.ts", "test"];
          writeFileSync(join(d, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
          git(d, "rm", "-rq", "src");
          writeFileSync(join(d, "src"), "ancestor file\n");
          writeFileSync(join(d, "test", "work.test.ts"), "export const escaped = true;\n");
          git(d, "add", "src", "test/work.test.ts");
          git(d, "commit", "-q", "-s", "-m", "ancestor escape");
          return ingest(d, e);
        },
      ],
      [
        "missing expected contract hash",
        (d, e) =>
          unitsIngest(
            d,
            ["unit"],
            {
              producer: "hermes",
              raw: e.rawPath,
              usage: e.usagePath,
              commit: git(d, "rev-parse", "HEAD"),
            },
            passing,
          ),
      ],
      [
        "mismatched expected contract hash",
        (d, e) => ingest(d, e, { "contract-hash": "b".repeat(64) }),
      ],
      [
        "missing DCO",
        async (d, e) => {
          commit(d, "unsigned", false);
          return ingest(d, e);
        },
      ],
      [
        "malformed usage",
        async (d, e) => {
          writeFileSync(e.usagePath, "{");
          return ingest(d, e);
        },
      ],
      [
        "timed-out usage",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.timed_out = true;
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "incomplete Hermes usage",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.hermes_usage.completed = false;
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "failed Hermes usage",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.hermes_usage.failed = true;
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "result-file mismatch",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.result_file = join(e.dir, "other.txt");
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "stdout hash mismatch",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.stdout_sha256 = "0".repeat(64);
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "negative resource",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.duration_seconds = -1;
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "nonfinite resource",
        async (d, e) => {
          const u = JSON.parse(readFileSync(e.usagePath, "utf8"));
          u.hermes_usage.total_tokens = "NaN";
          writeFileSync(e.usagePath, JSON.stringify(u));
          return ingest(d, e);
        },
      ],
      [
        "malformed summary",
        async (d, e) => {
          rewriteRaw(e, "result: done\n");
          return ingest(d, e);
        },
      ],
      [
        "invalid summary",
        async (d, e) => {
          rewriteRaw(e, validRaw().replace('"confidence":0.9', '"confidence":2'));
          return ingest(d, e);
        },
      ],
      [
        "out-of-scope summary",
        async (d, e) => {
          rewriteRaw(e, validRaw().replace("src/work.ts", "docs/escape.md"));
          return ingest(d, e);
        },
      ],
      [
        "summary omits committed path",
        async (d, e) => {
          rewriteRaw(e, validRaw().replace(',"test/work.test.ts"', ""));
          return ingest(d, e);
        },
      ],
      [
        "source parent symlink into repository",
        async (d, e) => {
          const source = join(d, ".vibeflow", "result.txt");
          const link = join(e.dir, "repository-link");
          writeFileSync(source, validRaw());
          symlinkSync(join(d, ".vibeflow"), link);
          e.rawPath = join(link, "result.txt");
          const usage = JSON.parse(readFileSync(e.usagePath, "utf8"));
          usage.result_file = e.rawPath;
          usage.stdout_sha256 = sha256(validRaw());
          writeFileSync(e.usagePath, JSON.stringify(usage));
          return ingest(d, e);
        },
      ],
      [
        "bounded result not done",
        async (d, e) => {
          rewriteRaw(e, validRaw().replace("result: done", "result: failed"));
          return ingest(d, e);
        },
      ],
      [
        "measured gate failure",
        (d, e) =>
          ingest(
            d,
            e,
            {},
            {
              ...passing,
              gate: (() => ({
                pass: false,
                failedGate: "test",
                detail: "red",
              })) as UnitsIngestInject["gate"],
            },
          ),
      ],
      [
        "reviewer failure",
        (d, e) =>
          ingest(
            d,
            e,
            {},
            {
              ...passing,
              reviewer: ((..._args: Parameters<typeof makeReviewer>) =>
                async () => ({
                  pass: false,
                  reason: "no",
                })) as unknown as UnitsIngestInject["reviewer"],
            },
          ),
      ],
      [
        "policy failure",
        async (d, e) => {
          const s = state(d);
          s.work_units[0].knowledge_heavy = true;
          writeFileSync(join(d, ".vibeflow", "WORKFLOW_STATE.json"), JSON.stringify(s));
          return ingest(d, e);
        },
      ],
    ];
    expect(cases.length).toBe(37);
    for (const [name, run] of cases)
      await withTemp(async (dir, e) => {
        expect(await run(dir, e)).toBe(1);
        if (name !== "missing state" && name !== "missing unit")
          expect(state(dir).work_units[0].status).toBe("blocked");
      });
  }, 25000);
});

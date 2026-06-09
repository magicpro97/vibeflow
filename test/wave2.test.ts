import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContext } from "../src/adapters.js";
import type { WorkflowState } from "../src/core.js";
import {
  buildEnginePrompt,
  engineCommand,
  parseEngineSummary,
  runDispatch,
} from "../src/dispatch.js";
import { policyGates } from "../src/gates.js";
import { claudeHookConfig, engineHookFiles } from "../src/hooks/adapters.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { resolveSkillNeeds, skillForFile } from "../src/skills/resolver.js";

describe("dispatch", () => {
  test("engineCommand maps each engine to its headless invocation", () => {
    const claude = engineCommand("claude");
    expect(claude).toEqual({ cmd: "claude", args: ["-p", "--output-format", "json"] });
    const codex = engineCommand("codex");
    if (!("unavailable" in codex)) expect(codex.cmd).toBe("codex");
  });

  test("buildEnginePrompt appends the JSON-summary contract", () => {
    const p = buildEnginePrompt("claude", defaultContext(), ["auth"]);
    expect(p).toContain("→ claude");
    expect(p).toContain("```json");
    expect(p).toContain("confidence");
  });

  test("buildEnginePrompt injects per-unit spec and scope when provided", () => {
    const p = buildEnginePrompt("claude", defaultContext(), [
      {
        name: "find-court",
        spec: "Replace the stub with a real browse screen",
        scope: ["ui/FindCourt.kt"],
      },
    ]);
    expect(p).toContain("Work unit details:");
    expect(p).toContain("find-court");
    expect(p).toContain("spec: Replace the stub with a real browse screen");
    expect(p).toContain("scope: ui/FindCourt.kt");
  });

  test("buildEnginePrompt omits the details block when units are bare names", () => {
    const p = buildEnginePrompt("claude", defaultContext(), ["auth"]);
    expect(p).not.toContain("Work unit details:");
  });

  test("buildEnginePrompt injects the code-navigation block when tools are enabled", () => {
    const ctx = { ...defaultContext() };
    ctx.settings = {
      ...DEFAULT_SETTINGS,
      tools: { codegraph: true, lsp: true },
    };
    const p = buildEnginePrompt("claude", ctx, ["auth"]);
    expect(p).toContain("Code navigation:");
    expect(p).toContain("codegraph");
    expect(p).toContain("lsp");
    expect(p).toContain("codegraph > lsp > native");
  });

  test("buildEnginePrompt omits the navigation block when no tools enabled (default)", () => {
    const p = buildEnginePrompt("claude", defaultContext(), ["auth"]);
    expect(p).not.toContain("Code navigation:");
  });

  test("buildEnginePrompt names resolved skills the engine must follow", () => {
    const p = buildEnginePrompt("claude", defaultContext(), [
      { name: "report", spec: "build a PDF report", skills: ["pdf-reader", "chart-gen"] },
    ]);
    expect(p).toContain("Skills:");
    expect(p).toContain("Follow these verified skills");
    expect(p).toContain("pdf-reader");
    expect(p).toContain("chart-gen");
  });

  test("buildEnginePrompt flags a skill gap so the engine won't freelance UX/UI", () => {
    const p = buildEnginePrompt("claude", defaultContext(), [
      { name: "dashboard-ui", spec: "design the dashboard screen", skillGap: true },
    ]);
    expect(p).toContain("NO verified skill matched");
    expect(p).toContain("dashboard-ui");
    expect(p).toContain("Do NOT freelance");
  });

  test("buildEnginePrompt omits the Skills block when no skills and no gap", () => {
    const p = buildEnginePrompt("claude", defaultContext(), [{ name: "x", spec: "do a thing" }]);
    expect(p).not.toContain("Skills:");
  });

  test("parseEngineSummary extracts the last fenced JSON block", () => {
    const out = 'noise\n```json\n{"confidence":0.9,"files_changed":["a.ts"]}\n```\ntail';
    const s = parseEngineSummary(out);
    expect(s?.confidence).toBe(0.9);
    expect(s?.files_changed).toEqual(["a.ts"]);
  });

  test("runDispatch uses an injected spawner and parses the result", () => {
    const spawner = () => ({ status: 0, stdout: '```json\n{"confidence":1}\n```' });
    const r = runDispatch({ engine: "claude", prompt: "p", mode: "cli", spawner });
    expect(r.ok).toBe(true);
    expect(r.summary?.confidence).toBe(1);
  });

  test("bridge mode reports a clear reason when VIBEFLOW_AI is unset", () => {
    const r = runDispatch({ engine: "codex", prompt: "p", mode: "bridge", bridgeCmd: "" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("VIBEFLOW_AI");
  });
});

describe("hook adapters", () => {
  test("each engine + git gets a config that delegates to vf hook", () => {
    const files = engineHookFiles();
    expect(Object.keys(files)).toContain(".claude/settings.json");
    expect(Object.keys(files)).toContain(".githooks/pre-commit");
    expect(claudeHookConfig()).toContain("vf hook");
    expect(files[".githooks/pre-commit"]).toContain("vf hook");
  });
});

describe("policy gates", () => {
  const base: WorkflowState = {
    task_id: "T",
    goal: "g",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };

  test("confidence<1, missing evidence, and scope overlap all fail", () => {
    const state: WorkflowState = {
      ...base,
      work_units: [
        {
          name: "a",
          status: "done",
          confidence: 0.8,
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          scope: ["src/auth/"],
        },
        {
          name: "b",
          status: "done",
          confidence: 1,
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          scope: ["src/auth/login.ts"],
        },
      ],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("confidence<1"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("no-evidence"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("scope-overlap"))).toBe(true);
  });

  test("a clean ledger passes all policy gates", () => {
    const state: WorkflowState = {
      ...base,
      work_units: [
        {
          name: "a",
          status: "done",
          confidence: 1,
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          scope: ["src/auth/"],
          evidence: ["evidence/build.log"],
        },
        {
          name: "b",
          status: "done",
          confidence: 1,
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          scope: ["src/ui/"],
          evidence: ["evidence/test.log"],
        },
      ],
    };
    expect(policyGates(state).ok).toBe(true);
  });

  // --- Skill gate: WARN-only, never FAIL (the key anti-regression). ---
  const cleanUnit = (over: Partial<WorkflowState["work_units"][number]>) => ({
    name: "u",
    status: "done" as const,
    confidence: 1,
    gates: {
      build: "pass" as const,
      lint: "pass" as const,
      test: "pass" as const,
      review: "pass" as const,
    },
    resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    evidence: ["evidence/x.log"],
    ...over,
  });

  test("regex-classified knowledge-heavy unit only warns, never fails", () => {
    const state = {
      ...base,
      work_units: [cleanUnit({ knowledge_heavy: true, knowledge_heavy_source: "regex" })],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("skills(warn)") && w.includes("heuristic"))).toBe(
      true,
    );
  });

  test("knowledge-heavy with no verified skill warns (skill-gap), ok stays true", () => {
    const state = {
      ...base,
      work_units: [
        cleanUnit({ knowledge_heavy: true, knowledge_heavy_source: "risk", skills_required: [] }),
      ],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("no verified skill matched"))).toBe(true);
  });

  test("required skill not reported used → WARN, NOT fail", () => {
    const state = {
      ...base,
      work_units: [
        cleanUnit({
          knowledge_heavy: true,
          knowledge_heavy_source: "risk",
          skills_required: ["compose-screen-ux"],
          skills_used: [],
        }),
      ],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.failures.length).toBe(0);
    expect(r.warnings.some((w) => w.includes("did not report using a required skill"))).toBe(true);
  });

  test("required skill reported used → passed, no warning", () => {
    const state = {
      ...base,
      work_units: [
        cleanUnit({
          knowledge_heavy: true,
          knowledge_heavy_source: "risk",
          skills_required: ["s"],
          skills_used: ["s"],
        }),
      ],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.passed.some((p) => p.includes("applied a required skill"))).toBe(true);
  });

  test("waiver clears the skill gate and is reported", () => {
    const state = {
      ...base,
      work_units: [
        cleanUnit({
          knowledge_heavy: true,
          knowledge_heavy_source: "risk",
          skills_required: ["s"],
          skill_waiver: { reason: "none authored", at: "2026-06-09T00:00:00Z", by: "human" },
        }),
      ],
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.passed.some((p) => p.includes("under waiver"))).toBe(true);
  });

  test("non-knowledge-heavy done unit is ignored by the skill gate", () => {
    const state = { ...base, work_units: [cleanUnit({ skills_required: [] })] };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("skills(warn)"))).toBe(false);
  });

  test("malformed skills fields (non-array) do not crash the gate", () => {
    // Simulates parsed engine JSON or a hand-edited ledger with the wrong shape.
    const bad = cleanUnit({ knowledge_heavy: true, knowledge_heavy_source: "risk" }) as Record<
      string,
      unknown
    >;
    bad.skills_required = { not: "an array" };
    bad.skills_used = "compose-screen-ux";
    const state = { ...base, work_units: [bad as never] };
    let r: ReturnType<typeof policyGates> | undefined;
    expect(() => {
      r = policyGates(state);
    }).not.toThrow();
    expect(r?.ok).toBe(true);
    // non-array skills_required coerces to [] → treated as skill-gap warning, never a crash.
    expect(r?.warnings.some((w) => w.includes("no verified skill matched"))).toBe(true);
  });
});

describe("skill resolver (demand-driven)", () => {
  test("skillForFile names the reader capability a file would need", () => {
    expect(skillForFile("BRD.docx")).toBe("docx-reader");
    expect(skillForFile("data.xlsx")).toBe("xlsx-reader");
    expect(skillForFile("weird.zzz")).toBe("generic-file-reader");
  });

  test("needs from attachments are reported missing when no local skill satisfies them", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-res-"));
    try {
      const needs = resolveSkillNeeds({ repo: dir, attachments: ["spec.xlsx"] });
      const xlsx = needs.find((n) => n.need === "xlsx-reader");
      expect(xlsx?.status).toBe("missing");
      expect(xlsx?.acquire).toContain("vf discover skills xlsx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-eval-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("skillsEvalCmd", () => {
  async function loadCmd() {
    return await import("../src/commands/skills-eval");
  }

  test("usage error when no skill dir", async () => {
    const d = tmpDir();
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, [])).toBe(2);
  });

  test("fails when skill dir has no SKILL.md", async () => {
    const d = tmpDir();
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, [tmpDir()])).toBe(1);
  });

  test("fails when no evals.json", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody");
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill"])).toBe(1);
  });

  test("runs eval and returns 0 on pass", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: my-skill",
        "description: test skill",
        "triggers:",
        "  - pdf",
        "capabilities:",
        "  - parse",
        "---",
        "# Skill body",
      ].join("\n"),
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [
          {
            id: "p1",
            type: "positive",
            prompt: "parse this pdf",
            expected: "parsed",
          },
        ],
      }),
    );
    const mod = await loadCmd();
    const prompts: string[] = [];
    expect(
      mod.skillsEvalCmd(d, ["my-skill", "--engine", "opencode"], {
        spawner: (_cmd, _args, input) => {
          prompts.push(input);
          const text = input.includes("# Skill body") ? "parsed" : "wrong";
          return { status: 0, stdout: JSON.stringify({ type: "text", part: { text } }) };
        },
      }),
    ).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe("parse this pdf");
    expect(prompts[1]).toContain("# Skill body");
  });

  test("rejects invalid --engine", async () => {
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(tmpDir(), ["my-skill", "--engine", "invalid"])).toBe(2);
  });

  test("returns 1 on regression with --previous", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: my-skill", "description: test skill", "---", "# Skill body"].join("\n"),
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "parse this pdf" }],
      }),
    );
    const prevPath = join(d, "prev.json");
    writeFileSync(
      prevPath,
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        timestamp: "2026-01-01T00:00:00.000Z",
        cases: [],
        summary: {
          positive: { total: 0, passed: 0, triggerAccuracy: 1 },
          negative: { total: 0, passed: 0, triggerAccuracy: 1 },
          baseline: { total: 0, passed: 0, triggerAccuracy: 1 },
          taskPassRate: 1,
          regression: false,
        },
      }),
    );
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill", "--previous", prevPath])).toBe(1);
  });

  test("--json flag", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "hello world" }],
      }),
    );
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill", "--json"])).toBe(0);
  });

  test("--out writes result file", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "hello" }],
      }),
    );
    const outPath = join(d, "out.json");
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill", "--out", outPath])).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  test("warns on mismatched skill name", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "different-name",
        cases: [{ id: "p1", type: "positive", prompt: "hello" }],
      }),
    );
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill"])).toBe(0);
  });

  test("handles error in loadSingleSkill gracefully", async () => {
    const d = tmpDir();
    const skillDir = join(d, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Bad Skill\ndescription: test\n---\nbody");
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["bad-skill"])).toBe(1);
  });

  test("--out without value returns error code 2", async () => {
    const d = tmpDir();
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill", "--out"])).toBe(2);
  });

  test("--previous without value returns error code 2", async () => {
    const d = tmpDir();
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill", "--previous"])).toBe(2);
  });

  test("engineText handles item.completed agent_message format", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "hello", expected: "parsed" }],
      }),
    );
    const mod = await loadCmd();
    expect(
      mod.skillsEvalCmd(d, ["my-skill"], {
        spawner: () => ({
          status: 0,
          stdout: JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "parsed" },
          }),
        }),
      }),
    ).toBe(0);
  });

  test("task vs previous comparison in human output", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "hello", expected: "parsed" }],
      }),
    );
    const prevPath = join(d, "prev.json");
    writeFileSync(
      prevPath,
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        timestamp: "2026-01-01T00:00:00.000Z",
        cases: [],
        summary: {
          positive: { total: 0, passed: 0, triggerAccuracy: 1 },
          negative: { total: 0, passed: 0, triggerAccuracy: 1 },
          baseline: { total: 0, passed: 0, triggerAccuracy: 1 },
          triggerAccuracy: 1,
          regression: false,
        },
        task: {
          cases: [],
          baselinePassRate: 1,
          skillPassRate: 1,
          delta: 0,
          taskPassRate: 1,
          regression: false,
        },
      }),
    );
    const mod = await loadCmd();
    const runner = (prompt: string, skillContext?: string) => (skillContext ? "wrong" : "parsed");
    expect(mod.skillsEvalCmd(d, ["my-skill", "--previous", prevPath], { runner })).toBe(1);
  });

  test("displays baseline cases in human output", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [
          { id: "p1", type: "positive", prompt: "hello" },
          { id: "b1", type: "baseline", prompt: "test case" },
        ],
      }),
    );
    const mod = await loadCmd();
    expect(mod.skillsEvalCmd(d, ["my-skill"])).toBe(0);
  });
});

describe("vf skills eval CLI integration", () => {
  test("skills() dispatches eval subcommand", async () => {
    const mod = await import("../src/commands/skills");
    expect(typeof mod.skills).toBe("function");
  });

  function withCwd<T>(dir: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  test("skills() eval subcommand calls through", async () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: test skill\n---\nbody",
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "hello" }],
      }),
    );
    const mod = await import("../src/commands/skills");
    const code = withCwd(d, () => mod.skills("eval", ["my-skill"]));
    expect(code).toBe(0);
  });
});

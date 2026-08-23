import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPrompt } from "../src/adapters/dispatch-prompt.js";
import { makeDispatcher } from "../src/commands.js";
import { CTX_DIR, type Skill, writeState } from "../src/core.js";
import { discoverSkills } from "../src/skills/discovery.js";
import {
  materializeDispatchSkills,
  materializeResolvedSkill,
  resolveDispatchSkills,
} from "../src/skills/dispatch-resolution.js";
import { parseSkill, repoSkills, selectDispatchSkills } from "../src/skills/registry.js";
import { validateSkillDir } from "../src/skills/validator.js";

function writeSkill(root: string, name: string, frontmatter: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", ...frontmatter, "---", "", `# ${name}`, "", "Steps."].join("\n"),
  );
  return dir;
}

function skill(over: Partial<Skill>): Skill {
  return {
    name: "s",
    description: "d",
    status: "verified",
    dir: "/x",
    path: "/x/SKILL.md",
    ...over,
  };
}

describe("#543 parseSkill type field", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-543-parse-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("type: repo → repo", () => {
    const dir = writeSkill(root, "law", ["name: law", "description: project law", "type: repo"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBe("repo");
  });
  test("type: knowledge → knowledge", () => {
    const dir = writeSkill(root, "know", ["name: know", "description: gated", "type: knowledge"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBe("knowledge");
  });
  test("absent → undefined", () => {
    const dir = writeSkill(root, "plain", ["name: plain", "description: no type"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
  test("garbage string → undefined", () => {
    const dir = writeSkill(root, "garbage", ["name: garbage", "description: bad", 'type: "foo"']);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
  test("garbage number → undefined", () => {
    const dir = writeSkill(root, "numbertype", [
      "name: numbertype",
      "description: bad",
      "type: 123",
    ]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
});

describe("#543 repoSkills()", () => {
  test("filters type===repo only", () => {
    const out = repoSkills([
      skill({ name: "a", type: "repo" }),
      skill({ name: "b", type: "knowledge" }),
      skill({ name: "c" }),
    ]);
    expect(out.map((s) => s.name)).toEqual(["a"]);
  });
  test("excludes deprecated repo skills", () => {
    const out = repoSkills([skill({ name: "a", type: "repo", status: "deprecated" })]);
    expect(out).toEqual([]);
  });
  test("sorts by STATUS_RANK descending", () => {
    const out = repoSkills([
      skill({ name: "low", type: "repo", status: "draft" }),
      skill({ name: "high", type: "repo", status: "verified" }),
    ]);
    expect(out.map((s) => s.name)).toEqual(["high", "low"]);
  });
  test("empty input → []", () => {
    expect(repoSkills([])).toEqual([]);
  });
});

describe("#543 selectDispatchSkills", () => {
  test("a repo skill with matching triggers does NOT count as a knowledge match", () => {
    // The repo skill declares a trigger that hits unitText, so matchSkillsForTask
    // returns it — but it must be excluded from matchedNames (always-on law, not a
    // knowledge match), else it would falsely suppress the knowledge-gap flag.
    const skills = [skill({ name: "law", type: "repo", status: "verified", triggers: ["widget"] })];
    const r = selectDispatchSkills(skills, "build the widget");
    expect(r.alwaysNames).toEqual(["law"]); // injected as project law
    expect(r.skillNames).toEqual(["law"]); // in the union
    expect(r.matchedNames).toEqual([]); // NOT a knowledge match → gap flag stays truthful
    expect(r.skillsRequired).toEqual(["law"]); // verified subset of the union
  });

  test("a knowledge skill with matching triggers is a knowledge match", () => {
    const skills = [
      skill({ name: "kb", type: "knowledge", status: "verified", triggers: ["widget"] }),
    ];
    const r = selectDispatchSkills(skills, "build the widget");
    expect(r.matchedNames).toEqual(["kb"]);
    expect(r.alwaysNames).toEqual([]);
  });
});

describe("canonical dispatch skill materialization", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-skill-materialize-"));
  const shared = mkdtempSync(join(tmpdir(), "vf-skill-shared-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  });

  function sourcedSkill(sourceRoot: string, name: string, overrides: Partial<Skill> = {}): Skill {
    const dir = join(sourceRoot, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(
      path,
      ["---", `name: ${name}`, `description: ${name}`, "---", "", `# ${name}`, "", "raw body"].join(
        "\n",
      ),
    );
    return skill({ name, dir, path, ...overrides });
  }

  function rewriteSourcedSkill(
    candidate: Skill,
    name: string,
    fields: string[] = [],
    body = `# ${name}\n\nraw body`,
  ): void {
    writeFileSync(
      candidate.path,
      ["---", `name: ${name}`, `description: ${name}`, ...fields, "---", "", body].join("\n"),
    );
  }

  test("preserves canonical selection and maps repo mirrors plus shared roots", () => {
    const repoSkill = sourcedSkill(join(root, CTX_DIR, "skills"), "project-law", {
      type: "repo",
    });
    const sharedSkill = sourcedSkill(shared, "shared-knowledge", { triggers: ["widget"] });
    const mirrorSkill = sourcedSkill(join(root, ".agents", "skills"), "builtin-extra");
    rewriteSourcedSkill(repoSkill, "project-law", ["type: repo", "status: verified"]);
    rewriteSourcedSkill(sharedSkill, "shared-knowledge", [
      "type: knowledge",
      "status: experimental",
      "triggers: [widget]",
    ]);
    const all = [repoSkill, sharedSkill, mirrorSkill];
    const out = materializeDispatchSkills(all, "build widget", {
      repoRoot: root,
      sharedRoot: shared,
      additionalSkillRefs: ["builtin-extra"],
    });
    expect(out.selection.skillNames).toEqual(["project-law", "shared-knowledge"]);
    expect(out.skills.map((s) => s.ref)).toEqual([
      "project-law",
      "shared-knowledge",
      "builtin-extra",
    ]);
    expect(out.skills.map((s) => s.source)).toEqual(["repo", "shared", "repo"]);
  });

  test("classifies every repo-resident engine mirror as repo authority", () => {
    const mirrors = [
      join(".kiro", "skills"),
      join(".claude", "skills"),
      join(".agents", "skills"),
      join(".github", "skills"),
      join(".opencode", "skills"),
    ];
    const skills = mirrors.map((mirror, index) =>
      sourcedSkill(join(root, mirror), `mirror-${index}`),
    );
    for (const candidate of skills) {
      expect(
        materializeResolvedSkill(candidate, skills, { repoRoot: root, sharedRoot: shared }).source,
      ).toBe("repo");
    }
  });

  test("hashes disk-derived body plus ordered dependencies deterministically", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const a = sourcedSkill(baseRoot, "dep-a");
    const b = sourcedSkill(baseRoot, "dep-b");
    const top = sourcedSkill(baseRoot, "top", {
      dependsOn: ["dep-a", "dep-b"],
    });
    rewriteSourcedSkill(top, "top", ["dependsOn: [dep-a, dep-b]"]);
    const options = { repoRoot: root, sharedRoot: shared };
    const first = materializeResolvedSkill(top, [a, b, top], options);
    const repeat = materializeResolvedSkill(top, [a, b, top], options);
    const callerReversed = materializeResolvedSkill(
      { ...top, dependsOn: ["dep-b", "dep-a"] },
      [a, b, top],
      options,
    );
    expect(first.resolved_body).toBe("# top\n\nraw body");
    expect(first.resolved_hash).toBe(repeat.resolved_hash);
    expect(first.resolved_hash).toBe(callerReversed.resolved_hash);
    expect(first.resolved_hash).toMatch(/^[a-f0-9]{64}$/);
    rewriteSourcedSkill(top, "top", ["dependsOn: [dep-b, dep-a]"]);
    const diskReversed = materializeResolvedSkill(top, [a, b, top], options);
    expect(first.resolved_hash).not.toBe(diskReversed.resolved_hash);
  });

  test("fails closed for missing, cyclic, or out-of-root skill dependencies", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const missing = sourcedSkill(baseRoot, "missing-top", { dependsOn: ["not-installed"] });
    const cycleA = sourcedSkill(baseRoot, "cycle-a", { dependsOn: ["cycle-b"] });
    const cycleB = sourcedSkill(baseRoot, "cycle-b", { dependsOn: ["cycle-a"] });
    rewriteSourcedSkill(missing, "missing-top", ["dependsOn: [not-installed]"]);
    rewriteSourcedSkill(cycleA, "cycle-a", ["dependsOn: [cycle-b]"]);
    rewriteSourcedSkill(cycleB, "cycle-b", ["dependsOn: [cycle-a]"]);
    expect(() =>
      materializeResolvedSkill(missing, [missing], { repoRoot: root, sharedRoot: shared }),
    ).toThrow(/not installed/i);
    expect(() =>
      materializeResolvedSkill(cycleA, [cycleA, cycleB], { repoRoot: root, sharedRoot: shared }),
    ).toThrow(/cycle/i);
    const outside = sourcedSkill(join(root, "outside-root"), "outside");
    expect(() =>
      materializeResolvedSkill(outside, [outside], {
        repoRoot: root,
        sharedRoot: shared,
      }),
    ).toThrow(/discovery roots/i);
  });

  test("resolvedBody cannot override disk authority or bypass file caps", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const absentPath = join(baseRoot, "absent", "SKILL.md");
    expect(() =>
      materializeResolvedSkill(
        skill({
          name: "absent",
          dir: join(baseRoot, "absent"),
          path: absentPath,
          resolvedBody: "x",
        }),
        [],
        { repoRoot: root, sharedRoot: shared },
      ),
    ).toThrow(/cannot materialize/i);

    const canonical = sourcedSkill(baseRoot, "disk-authority");
    const clean = materializeResolvedSkill(canonical, [canonical], {
      repoRoot: root,
      sharedRoot: shared,
    });
    const forged = materializeResolvedSkill(
      { ...canonical, resolvedBody: "CALLER FORGED BODY" },
      [{ ...canonical, resolvedBody: "CALLER FORGED BODY" }],
      { repoRoot: root, sharedRoot: shared },
    );
    expect(forged.resolved_body).toBe(clean.resolved_body);
    expect(forged.resolved_hash).toBe(clean.resolved_hash);

    const huge = sourcedSkill(baseRoot, "huge-disk");
    writeFileSync(huge.path, "x".repeat(1024 * 1024 + 1));
    expect(() =>
      materializeResolvedSkill(huge, [huge], { repoRoot: root, sharedRoot: shared }),
    ).toThrow(/1 MiB/i);
  });

  test("recomputes the existing adapter body from disk before hashing", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const base = sourcedSkill(baseRoot, "adapter-base");
    writeFileSync(
      base.path,
      [
        "---",
        "name: adapter-base",
        "description: adapter base",
        "---",
        "",
        "# Shared",
        "",
        "base body",
      ].join("\n"),
    );
    const adapter = sourcedSkill(baseRoot, "disk-adapter");
    writeFileSync(
      adapter.path,
      [
        "---",
        "name: disk-adapter",
        "description: disk adapter",
        "extends: [adapter-base]",
        "---",
        "",
        "# Shared",
        "",
        "adapter override",
      ].join("\n"),
    );
    const discovered = discoverSkills(root, {
      sharedCatalogDir: () => shared,
      homedir: () => shared,
    });
    const resolvedAdapter = discovered.find((skill) => skill.name === "disk-adapter");
    if (!resolvedAdapter?.resolvedBody) throw new Error("missing resolved adapter fixture");
    const materialized = materializeResolvedSkill(
      { ...resolvedAdapter, resolvedBody: "CALLER FORGED ADAPTER BODY" },
      discovered,
      { repoRoot: root, sharedRoot: shared },
    );
    expect(materialized.resolved_body).toBe(resolvedAdapter.resolvedBody);
    expect(materialized.resolved_body).toContain("adapter override");
    expect(materialized.resolved_body).not.toContain("CALLER FORGED");
  });

  test("reparses identity, version, status, and the complete dependency graph from disk", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const base = sourcedSkill(baseRoot, "authority-base");
    const dependency = sourcedSkill(baseRoot, "authority-dependency");
    const top = sourcedSkill(baseRoot, "authority-top");
    rewriteSourcedSkill(base, "authority-base", ["version: 1.0.0"], "# Shared\n\nbase");
    rewriteSourcedSkill(dependency, "authority-dependency", [], "# Dependency\n\ndisk");
    rewriteSourcedSkill(
      top,
      "authority-top",
      [
        "version: 2.0.0",
        "status: verified",
        "extends: [authority-base@1.0.0]",
        "dependsOn: [authority-dependency]",
        "triggers: [disk-trigger]",
        "capabilities: [disk-capability]",
      ],
      "# Shared\n\noverride",
    );
    const discovered = discoverSkills(root, {
      sharedCatalogDir: () => shared,
      homedir: () => shared,
    }).filter((candidate) => candidate.name.startsWith("authority-"));
    const canonicalTop = discovered.find((candidate) => candidate.name === "authority-top");
    if (!canonicalTop) throw new Error("missing authority fixture");
    const options = { repoRoot: root, sharedRoot: shared };
    const clean = materializeResolvedSkill(canonicalTop, discovered, options);
    const forged = discovered.map((candidate) => ({
      ...candidate,
      name: `forged-${candidate.name}`,
      version: "99.0.0",
      status: "deprecated" as const,
      extends: ["caller-added-base"],
      dependsOn: ["caller-added-dependency"],
      triggers: ["caller-trigger"],
      capabilities: ["caller-capability"],
      resolvedBody: "CALLER FORGED GRAPH BODY",
    }));
    const forgedTop = forged.find((candidate) => candidate.path === canonicalTop.path);
    if (!forgedTop) throw new Error("missing forged fixture");
    const repaired = materializeResolvedSkill(forgedTop, forged, options);
    expect(repaired.ref).toBe("authority-top");
    expect(repaired.version).toBe("2.0.0");
    expect(repaired.dependency_hashes).toHaveLength(2);
    expect(repaired.resolved_body).toBe(clean.resolved_body);
    expect(repaired.resolved_hash).toBe(clean.resolved_hash);
  });

  test("dispatch selection and its alias ignore caller-forged discovery metadata", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const law = sourcedSkill(baseRoot, "authority-law");
    const knowledge = sourcedSkill(baseRoot, "authority-knowledge");
    rewriteSourcedSkill(law, "authority-law", ["status: verified", "type: repo"]);
    rewriteSourcedSkill(knowledge, "authority-knowledge", [
      "status: verified",
      "type: knowledge",
      "triggers: [widget]",
      "capabilities: [gizmo]",
    ]);
    const forged = [
      {
        ...law,
        name: "caller-law",
        status: "deprecated" as const,
        type: "knowledge" as const,
        triggers: ["caller-only"],
        capabilities: ["caller-only"],
        extends: ["caller-added-base"],
        dependsOn: ["caller-added-dependency"],
      },
      {
        ...knowledge,
        name: "caller-knowledge",
        status: "deprecated" as const,
        type: "repo" as const,
        triggers: ["caller-only"],
        capabilities: ["caller-only"],
        extends: ["caller-added-base"],
        dependsOn: ["caller-added-dependency"],
      },
    ];
    const options = { repoRoot: root, sharedRoot: shared };
    const materialized = materializeDispatchSkills(forged, "build widget", options);
    const aliased = resolveDispatchSkills(forged, "build widget", options);
    for (const result of [materialized, aliased]) {
      expect(result.selection.skillNames).toEqual(["authority-law", "authority-knowledge"]);
      expect(result.selection.skillsRequired).toEqual(["authority-law", "authority-knowledge"]);
      expect(result.skills.map((candidate) => candidate.ref)).toEqual([
        "authority-law",
        "authority-knowledge",
      ]);
    }
  });

  test("rejects a skill reached through an in-root symlink component", () => {
    const baseRoot = join(root, CTX_DIR, "skills");
    const target = sourcedSkill(baseRoot, "symlink-target");
    const aliasDir = join(baseRoot, "symlink-alias");
    symlinkSync(target.dir, aliasDir, "dir");
    const aliased = { ...target, dir: aliasDir, path: join(aliasDir, "SKILL.md") };
    expect(() =>
      materializeResolvedSkill(aliased, [aliased], { repoRoot: root, sharedRoot: shared }),
    ).toThrow(/symlink|unsafe/i);
  });
});

describe("#543 dispatchPrompt repo vs matched", () => {
  const ctx = { goal: "g", settings: {} } as never;
  test("renders Project law line when repoSkills present", () => {
    const out = dispatchPrompt("claude", ctx, [
      { name: "u1", spec: "x", skills: ["law", "xlsx"], repoSkills: ["law"] },
    ]);
    expect(out).toContain("Project law (always apply, every unit): law.");
    expect(out).toContain("Follow these verified skills before improvising: xlsx.");
  });
  test("back-compat: identical output when no repoSkills", () => {
    const withUndef = dispatchPrompt("claude", ctx, [{ name: "u1", spec: "x", skills: ["xlsx"] }]);
    expect(withUndef).not.toContain("Project law");
    expect(withUndef).toContain("Follow these verified skills before improvising: xlsx.");
  });
});

describe("#543 validator type checks", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-543-valid-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("type is a standard field (no non-standard warning)", () => {
    const dir = writeSkill(root, "ok", ["name: ok", "description: fine", "type: repo"]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("type") && w.includes("non-standard"))).toBe(false);
  });
  test("invalid type value emits warning", () => {
    const dir = writeSkill(root, "bad", ["name: bad", "description: fine", "type: nope"]);
    const r = validateSkillDir(dir);
    expect(r.warnings).toContain('frontmatter.type must be "repo" or "knowledge"');
  });
  test("valid type value → no type warning", () => {
    const dir = writeSkill(root, "good", ["name: good", "description: fine", "type: knowledge"]);
    const r = validateSkillDir(dir);
    expect(r.warnings).not.toContain('frontmatter.type must be "repo" or "knowledge"');
  });
});

describe("#543 dispatch injection (dry run)", () => {
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-543-dispatch-"));
    const skillsRoot = join(dir, CTX_DIR, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    // repo skill, no keyword match to the unit text
    writeSkill(skillsRoot, "project-law", [
      "name: project-law",
      "description: always on law",
      "status: verified",
      "type: repo",
    ]);
    // knowledge skill matched by keyword "xlsxthing"
    writeSkill(skillsRoot, "xlsxthing", [
      "name: xlsxthing",
      "description: gated skill",
      "status: verified",
      "triggers: [xlsxthing]",
    ]);
    // knowledge skill NOT matched
    writeSkill(skillsRoot, "nevermatch", [
      "name: nevermatch",
      "description: unmatched",
      "status: verified",
      "triggers: [zzzznomatch]",
    ]);
    writeState(dir, {
      task_id: "T1",
      goal: "do thing",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "pending",
          confidence: 0,
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    });
    return dir;
  }

  test("repo skill injected without match; knowledge needs a match; dedup", async () => {
    const dir = setup();
    try {
      const dispatcher = makeDispatcher("claude", {} as never, dir, "dry", "feature");
      await dispatcher({
        name: "u1",
        spec: "please handle xlsxthing here",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      });
      const ctx = readFileSync(join(dir, CTX_DIR, "workunits", "u1", "CONTEXT.md"), "utf8");
      expect(ctx).toContain("project-law");
      expect(ctx).toContain("xlsxthing");
      expect(ctx).not.toContain("nevermatch");
      // dedup: project-law only appears in the "Project law" line, not duplicated as matched
      expect(ctx).toContain("Project law (always apply, every unit): project-law.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsUpdateDependentCmd } from "../src/commands/skills-update-dependent";
import { CTX_DIR } from "../src/core";
import type { Skill } from "../src/core/types";
import {
  type DependentVersionState,
  type ReviewEntry,
  clearNeedsReview,
  defaultState,
  detectVersionChange,
  evalDependentSkill,
  markNeedsReview,
  readDependentVersions,
  resolveDependentSkills,
  resolveTransitiveDependents,
  writeDependentVersions,
} from "../src/skills/dependent";

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-dep-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeSkill(name: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `Skill ${name}`,
    status: "verified",
    capabilities: [],
    triggers: [],
    dir: "/tmp/skills",
    path: `/tmp/skills/${name}/SKILL.md`,
    ...over,
  };
}

describe("resolveDependentSkills", () => {
  test("finds direct dependents via domain.id", () => {
    const canonical = makeSkill("neomatch-ctc", {
      domain: { id: "neomatch", role: "canonical" },
    });
    const child = makeSkill("neomatch-ctc-verification", {
      domain: { id: "neomatch", role: "child" },
      dependsOn: ["neomatch"],
    });
    const unrelated = makeSkill("unrelated", {});
    const result = resolveDependentSkills([canonical, child, unrelated], "neomatch-ctc");
    expect(result).toEqual(["neomatch-ctc-verification"]);
  });

  test("finds direct dependents via skill name fallback", () => {
    const canonical = makeSkill("auth", {});
    const child = makeSkill("auth-ui", { dependsOn: ["auth"] });
    const result = resolveDependentSkills([canonical, child], "auth");
    expect(result).toEqual(["auth-ui"]);
  });

  test("returns empty when canonical not found", () => {
    const result = resolveDependentSkills([makeSkill("a")], "nonexistent");
    expect(result).toEqual([]);
  });

  test("returns empty when no dependents", () => {
    const canonical = makeSkill("standalone", { domain: { id: "standalone", role: "canonical" } });
    const result = resolveDependentSkills([canonical], "standalone");
    expect(result).toEqual([]);
  });

  test("skips canonical itself", () => {
    const canonical = makeSkill("core", {
      domain: { id: "core", role: "canonical" },
      dependsOn: ["core"],
    });
    const result = resolveDependentSkills([canonical], "core");
    expect(result).toEqual([]);
  });
});

describe("resolveTransitiveDependents", () => {
  test("direct only", () => {
    const a = makeSkill("a", { domain: { id: "a" } });
    const b = makeSkill("b", { dependsOn: ["a"], domain: { id: "b" } });
    const result = resolveTransitiveDependents([a, b], ["b"]);
    expect(result).toEqual(["b"]);
  });

  test("transitive closure: a -> b -> c", () => {
    const a = makeSkill("a", { domain: { id: "a" } });
    const b = makeSkill("b", { dependsOn: ["a"], domain: { id: "b" } });
    const c = makeSkill("c", { dependsOn: ["b"], domain: { id: "c" } });
    const result = resolveTransitiveDependents([a, b, c], ["b"]);
    expect(result).toEqual(["b", "c"]);
  });

  test("deep transitive: a -> b -> c -> d", () => {
    const a = makeSkill("a", { domain: { id: "a" } });
    const b = makeSkill("b", { dependsOn: ["a"], domain: { id: "b" } });
    const c = makeSkill("c", { dependsOn: ["b"], domain: { id: "c" } });
    const d = makeSkill("d", { dependsOn: ["c"], domain: { id: "d" } });
    const result = resolveTransitiveDependents([a, b, c, d], ["b"]);
    expect(result).toEqual(["b", "c", "d"]);
  });

  test("no dependents returns empty sorted", () => {
    const result = resolveTransitiveDependents([makeSkill("a")], []);
    expect(result).toEqual([]);
  });

  test("deterministic sorted output", () => {
    const a = makeSkill("a", { domain: { id: "z" } });
    const skills = [];
    for (const name of ["z", "y", "x", "w"]) {
      skills.push(makeSkill(name, { dependsOn: ["z"], domain: { id: name } }));
    }
    const result = resolveTransitiveDependents([a, ...skills], ["z", "y", "x", "w"]);
    expect(result).toEqual(["w", "x", "y", "z"]);
  });
});

describe("detectVersionChange", () => {
  test("no prior version — no change", () => {
    const state = defaultState();
    const result = detectVersionChange(state, "my-skill", "1.0.0");
    expect(result.versionChanged).toBe(false);
    expect(result.oldVersion).toBeUndefined();
    expect(result.newVersion).toBe("1.0.0");
  });

  test("same version — no change", () => {
    const state = defaultState();
    state.versions["my-skill"] = "1.0.0";
    const result = detectVersionChange(state, "my-skill", "1.0.0");
    expect(result.versionChanged).toBe(false);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.0.0");
  });

  test("version bump — change detected", () => {
    const state = defaultState();
    state.versions["my-skill"] = "1.0.0";
    const result = detectVersionChange(state, "my-skill", "2.0.0");
    expect(result.versionChanged).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("2.0.0");
  });

  test("undefined version becomes 0.0.0", () => {
    const state = defaultState();
    state.versions["my-skill"] = "1.0.0";
    const result = detectVersionChange(state, "my-skill", undefined);
    expect(result.versionChanged).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("0.0.0");
  });
});

describe("markNeedsReview / clearNeedsReview", () => {
  test("marks a dependent as needs-review", () => {
    const state = defaultState();
    markNeedsReview(state, "child", "parent", "version bump");
    const entry = state.needsReview.child as ReviewEntry;
    expect(entry.canonical).toBe("parent");
    expect(entry.reason).toBe("version bump");
    expect(entry.markedAt).toBeTruthy();
  });

  test("clears needs-review", () => {
    const state = defaultState();
    markNeedsReview(state, "child", "parent", "reason");
    expect(Object.keys(state.needsReview)).toHaveLength(1);
    clearNeedsReview(state, "child");
    expect(Object.keys(state.needsReview)).toHaveLength(0);
  });

  test("clear non-existent is no-op", () => {
    const state = defaultState();
    clearNeedsReview(state, "nonexistent");
    expect(Object.keys(state.needsReview)).toHaveLength(0);
  });
});

describe("evalDependentSkill", () => {
  test("returns no-evals when no evals.json", () => {
    const skill = makeSkill("test-skill", { dir: tmpDir() });
    const result = evalDependentSkill(skill);
    expect(result.status).toBe("no-evals");
    expect(result.name).toBe("test-skill");
  });

  test("returns pass for passing evals", () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: my-skill",
        "description: test",
        "triggers:",
        "  - pdf",
        "capabilities:",
        "  - parse",
        "---",
        "# body",
      ].join("\n"),
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "parse this pdf" }],
      }),
    );
    const skill = makeSkill("my-skill", {
      triggers: ["pdf"],
      capabilities: ["parse"],
      dir: skillDir,
      path: join(skillDir, "SKILL.md"),
    });
    const result = evalDependentSkill(skill);
    expect(result.status).toBe("pass");
    expect(result.triggerAccuracy).toBe(1);
  });

  test("returns fail for failing evals", () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: my-skill", "description: test", "triggers:", "  - pdf", "---", "# body"].join(
        "\n",
      ),
    );
    writeFileSync(
      join(skillDir, "evals", "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: "my-skill",
        cases: [{ id: "p1", type: "positive", prompt: "compile rust code" }],
      }),
    );
    const skill = makeSkill("my-skill", {
      triggers: ["pdf"],
      dir: skillDir,
      path: join(skillDir, "SKILL.md"),
    });
    const result = evalDependentSkill(skill);
    expect(result.status).toBe("fail");
    expect(result.triggerAccuracy).toBe(0);
  });

  test("returns error for malformed eval file", () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(join(skillDir, "evals", "evals.json"), "not-json");
    const skill = makeSkill("my-skill", {
      dir: skillDir,
      path: join(skillDir, "SKILL.md"),
    });
    const result = evalDependentSkill(skill);
    expect(result.status).toBe("error");
  });
});

describe("state persistence", () => {
  test("readDependentVersions returns default when no file", () => {
    const state = readDependentVersions(tmpDir());
    expect(state.schemaVersion).toBe(1);
    expect(state.versions).toEqual({});
    expect(state.needsReview).toEqual({});
  });

  test("write then read round-trips", () => {
    const d = tmpDir();
    const state: DependentVersionState = {
      schemaVersion: 1,
      versions: { "my-skill": "1.0.0" },
      needsReview: { child: { canonical: "my-skill", reason: "bump", markedAt: "2026-01-01" } },
    };
    writeDependentVersions(d, state);
    const loaded = readDependentVersions(d);
    expect(loaded.versions).toEqual({ "my-skill": "1.0.0" });
    expect(loaded.needsReview.child?.canonical).toBe("my-skill");
  });

  test("read returns default on schema version mismatch", () => {
    const d = tmpDir();
    mkdirSync(join(d, ".vibeflow", "skills"), { recursive: true });
    writeFileSync(
      join(d, ".vibeflow", "skills", "dependent-versions.json"),
      JSON.stringify({ schemaVersion: 999, versions: {}, needsReview: {} }),
    );
    const state = readDependentVersions(d);
    expect(state.schemaVersion).toBe(1);
  });

  test("read returns default on corrupted JSON", () => {
    const d = tmpDir();
    mkdirSync(join(d, ".vibeflow", "skills"), { recursive: true });
    writeFileSync(join(d, ".vibeflow", "skills", "dependent-versions.json"), "not-json");
    const state = readDependentVersions(d);
    expect(state.versions).toEqual({});
  });
});

describe("version bump marks child needs-review — integration", () => {
  test("updating neomatch-ctc marks neomatch-ctc-verification needs-review", () => {
    const canonical = makeSkill("neomatch-ctc", {
      version: "2.0.0",
      domain: { id: "neomatch", role: "canonical" },
    });
    const child = makeSkill("neomatch-ctc-verification", {
      domain: { id: "neomatch", role: "child" },
      dependsOn: ["neomatch"],
    });
    const state = defaultState();
    state.versions["neomatch-ctc"] = "1.0.0";

    const versionChange = detectVersionChange(state, "neomatch-ctc", "2.0.0");
    expect(versionChange.versionChanged).toBe(true);
    expect(versionChange.oldVersion).toBe("1.0.0");
    expect(versionChange.newVersion).toBe("2.0.0");

    const dependents = resolveDependentSkills([canonical, child], "neomatch-ctc");
    expect(dependents).toEqual(["neomatch-ctc-verification"]);

    markNeedsReview(
      state,
      "neomatch-ctc-verification",
      "neomatch-ctc",
      "version bump 1.0.0 → 2.0.0",
    );
    expect(state.needsReview["neomatch-ctc-verification"]).toBeDefined();
    expect(state.needsReview["neomatch-ctc-verification"]?.canonical).toBe("neomatch-ctc");
  });

  test("no version change does not mark needs-review", () => {
    const canonical = makeSkill("neomatch-ctc", {
      version: "1.0.0",
      domain: { id: "neomatch", role: "canonical" },
    });
    const child = makeSkill("neomatch-ctc-verification", {
      domain: { id: "neomatch", role: "child" },
      dependsOn: ["neomatch"],
    });
    const state = defaultState();
    state.versions["neomatch-ctc"] = "1.0.0";

    const versionChange = detectVersionChange(state, "neomatch-ctc", "1.0.0");
    expect(versionChange.versionChanged).toBe(false);

    const dependents = resolveDependentSkills([canonical, child], "neomatch-ctc");
    expect(dependents).toEqual(["neomatch-ctc-verification"]);
    expect(Object.keys(state.needsReview)).toHaveLength(0);
  });
});

// ── CLI integration: skillsUpdateDependentCmd ──────────────────────

describe("skillsUpdateDependentCmd CLI branches", () => {
  let repo: string;
  let orig: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vf-dep-cmd-"));
    orig = process.cwd();
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(orig);
    rmSync(repo, { recursive: true, force: true });
  });

  // Write valid SKILL.md under .vibeflow/skills/<name>/
  function scaffoldSkill(
    name: string,
    fm: {
      description?: string;
      version?: string;
      domain?: { id: string; role?: string };
      dependsOn?: string[];
      triggers?: string[];
    },
  ): void {
    const dir = join(repo, CTX_DIR, "skills", name);
    mkdirSync(dir, { recursive: true });
    const lines = ["---", `name: ${name}`, `description: ${fm.description ?? `Skill ${name}`}`];
    if (fm.version) lines.push(`version: "${fm.version}"`);
    if (fm.domain) {
      lines.push("domain:");
      lines.push(`  id: ${fm.domain.id}`);
      if (fm.domain.role) lines.push(`  role: ${fm.domain.role}`);
    }
    if (fm.dependsOn?.length) {
      lines.push("dependsOn:");
      for (const d of fm.dependsOn) lines.push(`  - ${d}`);
    }
    if (fm.triggers?.length) {
      lines.push("triggers:");
      for (const t of fm.triggers) lines.push(`  - ${t}`);
    }
    lines.push("---", "", `# ${name}`, "", "Body text.");
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  }

  function scaffoldEval(name: string, prompts: string[]): void {
    const eDir = join(repo, CTX_DIR, "skills", name, "evals");
    mkdirSync(eDir, { recursive: true });
    writeFileSync(
      join(eDir, "evals.json"),
      JSON.stringify({
        schemaVersion: 1,
        skill: name,
        cases: prompts.map((p, i) => ({ id: `c${i}`, type: "positive", prompt: p })),
      }),
    );
  }

  function writeVersionState(versions: Record<string, string>): void {
    const sd = join(repo, CTX_DIR, "skills");
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      join(sd, "dependent-versions.json"),
      JSON.stringify({ schemaVersion: 1, versions, needsReview: {} }),
    );
  }

  // 1. Usage: invalid
  test("empty name returns 2", () => {
    expect(skillsUpdateDependentCmd(repo, [])).toBe(2);
  });

  test("invalid name returns 2", () => {
    expect(skillsUpdateDependentCmd(repo, ["Bad_Name"])).toBe(2);
    expect(skillsUpdateDependentCmd(repo, ["has space"])).toBe(2);
  });

  // 2. Unknown canonical
  test("unknown canonical returns 1", () => {
    expect(skillsUpdateDependentCmd(repo, ["nonexistent"])).toBe(1);
  });

  // 3. Non-canonical warning
  test("non-canonical role warns exits 0", () => {
    scaffoldSkill("my-skill", { domain: { id: "my", role: "child" } });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 4. No dependents + version changed
  test("no dependents + version changed warns exits 0", () => {
    scaffoldSkill("my-skill", { version: "2.0.0", domain: { id: "my", role: "canonical" } });
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 5. No dependents + no version change
  test("no dependents + no version change exits 0", () => {
    scaffoldSkill("my-skill", { domain: { id: "my", role: "canonical" } });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 6. Version changed + evals pass
  test("version changed + evals pass exits 0", () => {
    scaffoldSkill("my-skill", { version: "2.0.0", domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"], triggers: ["pdf"] });
    scaffoldEval("dep-skill", ["parse this pdf"]);
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 7. Version changed + no evals
  test("version changed + no evals exits 0", () => {
    scaffoldSkill("my-skill", { version: "2.0.0", domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"] });
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 8. Version changed + evals fail
  test("version changed + evals fail exits 1", () => {
    scaffoldSkill("my-skill", { version: "2.0.0", domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"], triggers: ["python"] });
    scaffoldEval("dep-skill", ["parse this pdf"]);
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(1);
  });

  // 9. Version changed + evals error (malformed json)
  test("version changed + malformed evals exits 1", () => {
    scaffoldSkill("my-skill", { version: "2.0.0", domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"] });
    const eDir = join(repo, CTX_DIR, "skills", "dep-skill", "evals");
    mkdirSync(eDir, { recursive: true });
    writeFileSync(join(eDir, "evals.json"), "not-json");
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(1);
  });

  // 10. Canonical no version
  test("canonical has no version exits 0", () => {
    scaffoldSkill("my-skill", { domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"] });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });

  // 11. Version unchanged
  test("version unchanged exits 0", () => {
    scaffoldSkill("my-skill", { version: "1.0.0", domain: { id: "my", role: "canonical" } });
    scaffoldSkill("dep-skill", { dependsOn: ["my"] });
    writeVersionState({ "my-skill": "1.0.0" });
    expect(skillsUpdateDependentCmd(repo, ["my-skill"])).toBe(0);
  });
});

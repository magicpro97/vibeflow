import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR, type Skill } from "../src/core.js";
import {
  discoverSkills,
  matchSkillsForFile,
  matchSkillsForTask,
  parseSkill,
  renderSkillIndex,
} from "../src/skills/registry.js";
import { renderSkillNeeds, resolveSkillNeeds, skillForFile } from "../src/skills/resolver.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-skills-"));
}

function skill(partial: Partial<Skill> & { name: string }): Skill {
  return {
    description: partial.description ?? `${partial.name} skill`,
    status: partial.status ?? "unverified",
    capabilities: partial.capabilities,
    triggers: partial.triggers,
    requires: partial.requires,
    dir: partial.dir ?? `/tmp/${partial.name}`,
    path: partial.path ?? `/tmp/${partial.name}/SKILL.md`,
    version: partial.version,
    name: partial.name,
  };
}

describe("registry provenance (never auto-verify external skills)", () => {
  test("a prototype-pollution SKILL.md does NOT yield a verified skill", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: evil", "description: x", "__proto__:", "  status: verified", "---"].join(
          "\n",
        ),
      );
      const parsed = parseSkill(sk, dir);
      expect(parsed).not.toBeNull();
      expect(parsed?.status).not.toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a discovered (non-local) skill claiming verified is downgraded", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: from-internet", "description: imported", "status: verified", "---"].join(
          "\n",
        ),
      );
      // provenance "discovered" must cap trust at experimental.
      const parsed = parseSkill(sk, dir, { provenance: "discovered" });
      expect(parsed?.status).toBe("experimental");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a local skill may declare verified", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: local-one", "description: trusted local", "status: verified", "---"].join(
          "\n",
        ),
      );
      const parsed = parseSkill(sk, dir, { provenance: "local" });
      expect(parsed?.status).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("draft and deprecated are recognized as valid statuses", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: lifecycle", "description: d", "status: draft", "---"].join("\n"),
      );
      expect(parseSkill(sk, dir)?.status).toBe("draft");
      writeFileSync(
        sk,
        ["---", "name: lifecycle", "description: d", "status: deprecated", "---"].join("\n"),
      );
      expect(parseSkill(sk, dir)?.status).toBe("deprecated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discoverSkills treats local SKILL.md folders as local provenance (verified kept)", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "local-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: local-reader",
          "description: a trusted local reader",
          "status: verified",
          "triggers: [md]",
          "---",
        ].join("\n"),
      );
      const found = discoverSkills(dir);
      expect(found[0]?.status).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #93: parseSkill normalized names per-root by REJECTING any
  // mixed-case `name:` (the lowercase regex), and discoverSkills deduped
  // by raw string equality. The combined effect: a skill whose frontmatter
  // used any uppercase letter (e.g. `name: Shared-Tool`) was silently
  // dropped instead of being recognized as the canonical `shared-tool`.
  //
  // Fix: parseSkill lowercases the declared name before regex validation
  // (so a mixed-case `name:` normalizes to its canonical form), and
  // discoverSkills dedups on the lowercased key as a defense-in-depth.
  // Net effect: the same skill surfaces exactly once regardless of
  // casing differences between roots, and a slightly-mistyped name no
  // longer disappears.
  test("parseSkill normalizes mixed-case names to canonical lowercase form (issue #93)", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: Shared-Tool", "description: mixed case should normalize", "---"].join("\n"),
      );
      const parsed = parseSkill(sk, dir);
      // Pre-fix: parseSkill returned null (the regex `^[a-z0-9]+…$`
      // rejected any uppercase letter). Post-fix: the name is lowercased
      // before the regex check, so the skill is accepted under its
      // canonical form.
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("shared-tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discoverSkills dedupes case-insensitively across roots (issue #93)", () => {
    const dir = tmpRepo();
    try {
      // Root 1 (.vibeflow/skills) declares the canonical name.
      const local = join(dir, CTX_DIR, "skills", "shared-tool");
      mkdirSync(local, { recursive: true });
      writeFileSync(
        join(local, "SKILL.md"),
        ["---", "name: shared-tool", "description: first mirror", "---"].join("\n"),
      );
      // Root 2 (.claude/skills) declares the same skill in mixed case.
      // The folder name is distinct from `shared-tool` on every
      // filesystem (digit suffix), so dedup MUST come from frontmatter
      // name comparison — not from the folder name.
      const mirror = join(dir, ".claude", "skills", "shared-tool-2");
      mkdirSync(mirror, { recursive: true });
      writeFileSync(
        join(mirror, "SKILL.md"),
        ["---", "name: Shared-Tool", "description: second mirror", "---"].join("\n"),
      );
      const found = discoverSkills(dir);
      const shared = found.filter((s) => s.name === "shared-tool");
      // Both roots declare the same skill (case-insensitively); the
      // registry must collapse them into one entry, not two.
      expect(shared.length).toBe(1);
      expect(shared[0]?.description).toBe("first mirror");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolver status-aware matching", () => {
  test("(a) verified wins over experimental for the same trigger", () => {
    const skills = [
      skill({ name: "exp", status: "experimental", triggers: ["xlsx"] }),
      skill({ name: "ver", status: "verified", triggers: ["xlsx"] }),
    ];
    const ranked = matchSkillsForFile(skills, "report.xlsx");
    expect(ranked[0]?.skill.name).toBe("ver");
  });

  test("(b) a deprecated skill is never returned", () => {
    const skills = [skill({ name: "old", status: "deprecated", triggers: ["xlsx"] })];
    expect(matchSkillsForFile(skills, "report.xlsx")).toEqual([]);
    expect(matchSkillsForTask(skills, "read the xlsx").length).toBe(0);
  });

  test("(c) only an experimental match → need is NOT silently satisfied", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "xlsx-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: xlsx-reader",
          "description: experimental xlsx reader",
          "status: experimental",
          "triggers: [xlsx]",
          "---",
        ].join("\n"),
      );
      const needs = resolveSkillNeeds({ repo: dir, attachments: ["data.xlsx"] });
      const xlsx = needs.find((n) => n.need === "xlsx-reader");
      expect(xlsx?.status).toBe("missing");
      expect(xlsx?.acquire).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a verified local skill DOES satisfy the need", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "xlsx-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: xlsx-reader",
          "description: trusted xlsx reader",
          "status: verified",
          "triggers: [xlsx]",
          "---",
        ].join("\n"),
      );
      const needs = resolveSkillNeeds({ repo: dir, attachments: ["data.xlsx"] });
      const xlsx = needs.find((n) => n.need === "xlsx-reader");
      expect(xlsx?.status).toBe("satisfied");
      expect(xlsx?.satisfiedBy).toBe("xlsx-reader");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseSkill: edge cases", () => {
  test("returns null when SKILL.md is missing (readFileSync catch)", async () => {
    // Non-existent path → readFileSync throws → catch returns null.
    // Line 75 uncovered branch.
    const dir = mkdtempSync(join(tmpdir(), "vf-skill-parse-"));
    try {
      const result = parseSkill(join(dir, "ghost", "SKILL.md"), dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Line 121 (readdirSync catch) and line 128 (statSync catch) in
// discoverSkills are essentially unreachable from a normal filesystem
// — they only fire when readdirSync/statSync throw, which doesn't
// happen on a healthy POSIX FS. The functions are wrapped in
// try/catch defensively for symlink loops, network FS errors, etc.
// Documented limitation: the catch blocks exist for fail-closed
// behaviour but cannot be exercised in unit tests without mocking
// the fs module.

describe("coordinator skill (A2 #168)", () => {
  const repoRoot = join(import.meta.dir, "..");
  const skillPath = join(repoRoot, ".vibeflow", "skills", "coordinator", "SKILL.md");

  test("SKILL.md exists at the canonical path", () => {
    const exists = existsSync(skillPath);
    expect(exists).toBe(true);
  });

  test("SKILL.md has YAML frontmatter with name=coordinator, description, when_to_load", () => {
    const text = readFileSync(skillPath, "utf8");
    // Frontmatter opens on line 1 and closes on a later --- line.
    expect(text.split("\n")[0]?.trim()).toBe("---");
    const fmEnd = text
      .split("\n")
      .slice(1)
      .findIndex((l) => l.trim() === "---");
    expect(fmEnd).toBeGreaterThan(0);
    const fm = text
      .split("\n")
      .slice(1, fmEnd + 1)
      .join("\n");
    expect(fm).toMatch(/^name:\s*coordinator\s*$/m);
    expect(fm).toMatch(/^description:\s*\S/m);
    expect(fm).toMatch(/^when_to_load:\s*\S/m);
  });

  test("SKILL.md has the 6 required sections (## 0 .. ## 5)", () => {
    const text = readFileSync(skillPath, "utf8");
    for (const n of ["0", "1", "2", "3", "4", "5"]) {
      // Match "## N. <heading>" — the section number is required.
      const re = new RegExp(`^## ${n}\\. `, "m");
      expect(text).toMatch(re);
    }
  });

  test("SKILL.md is between 100 and 200 lines (skill must be cheap to read)", () => {
    const text = readFileSync(skillPath, "utf8");
    const n = text.trim() === "" ? 0 : text.split("\n").length;
    // The "skill is cheap" rule from the A2 spec: 100-200 lines.
    // The exact 100-lower bound is a hard floor; the 200 ceiling
    // is a soft cap. Assert both.
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThanOrEqual(200);
  });

  test("validate-coordinator-skill.sh exits 0 on the shipped SKILL.md", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("bash", [join(repoRoot, "scripts", "validate-coordinator-skill.sh")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // The script is the "skill is shipped" gate — exit 0 = pass.
    if (r.status !== 0) {
      // Surface the actual error so a CI failure isn't a black box.
      console.error("validate-coordinator-skill.sh stdout:", r.stdout);
      console.error("validate-coordinator-skill.sh stderr:", r.stderr);
    }
    expect(r.status).toBe(0);
  });

  test("validate-coordinator-skill.sh exits non-zero on a malformed SKILL.md", () => {
    // Sanity-check the gate: a SKILL.md missing the frontmatter MUST fail.
    // This protects against a future refactor that silently passes everything.
    const dir = mkdtempSync(join(tmpdir(), "vf-coord-bad-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "skills", "coordinator"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "skills", "coordinator", "SKILL.md"),
        "# no frontmatter\n",
      );
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const r = spawnSync("bash", [join(repoRoot, "scripts", "validate-coordinator-skill.sh")], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("matchSkillsForFile: deprecated + score branches", () => {
  test("deprecated skill is never matched (line 155 continue)", () => {
    // A deprecated skill with a matching trigger must NOT appear
    // in the matches list.
    const skills: Skill[] = [
      {
        name: "old",
        description: "deprecated skill that should never match",
        status: "deprecated",
        triggers: ["report"],
        dir: "/tmp/old",
        path: "/tmp/old/SKILL.md",
      },
      {
        name: "fresh",
        description: "active skill that should match",
        status: "experimental",
        triggers: ["report"],
        dir: "/tmp/fresh",
        path: "/tmp/fresh/SKILL.md",
      },
    ];
    const matches = matchSkillsForFile(skills, "report.xlsx");
    expect(matches.length).toBe(1);
    expect(matches[0]?.skill.name).toBe("fresh");
  });

  test("trigger appears as substring of filename (line 156 else-if)", () => {
    // The else-if branch: triggers.some(t => lower.includes(t)).
    // Trigger "report" appears inside "annual-report-2024.xlsx".
    const skills: Skill[] = [
      {
        name: "report-skill",
        description: "matches report files",
        status: "experimental",
        triggers: ["report"],
        dir: "/tmp/report-skill",
        path: "/tmp/report-skill/SKILL.md",
      },
    ];
    const matches = matchSkillsForFile(skills, "annual-report-2024.xlsx");
    expect(matches.length).toBe(1);
    expect(matches[0]?.reason).toBe("filename contains a declared trigger");
    expect(matches[0]?.score).toBe(0.6);
  });
});

describe("renderSkillIndex", () => {
  test("renders the header even when skills is empty (line 202-208)", () => {
    const out = renderSkillIndex([]);
    expect(out).toContain("# Skill Index");
    expect(out).toContain("| skill |");
    // Only header + separator lines (2 total), no data rows.
    expect(out.split("\n").filter((l) => l.startsWith("|")).length).toBe(2);
  });

  test("renders rows for each skill", () => {
    const skills: Skill[] = [
      {
        name: "alpha",
        description: "alpha",
        status: "experimental",
        capabilities: ["read", "write"],
        dir: "/tmp/alpha",
        path: "/tmp/alpha/SKILL.md",
      },
      {
        name: "beta",
        description: "beta",
        status: "verified",
        capabilities: [],
        dir: "/tmp/beta",
        path: "/tmp/beta/SKILL.md",
      },
    ];
    const out = renderSkillIndex(skills);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("read, write");
  });
});

describe("skillForFile", () => {
  test("maps known extensions to their reader skill", () => {
    expect(skillForFile("data.xlsx")).toBe("xlsx-reader");
    expect(skillForFile("README.md")).toBe("markdown-reader");
  });

  test("falls back to generic-file-reader for unknown extensions", () => {
    expect(skillForFile("data.unknownext")).toBe("generic-file-reader");
  });
});

describe("resolveSkillNeeds: branches", () => {
  test("declares file-type needs from fileTypes[] (line 110-112)", () => {
    const dir = tmpRepo();
    const needs = resolveSkillNeeds({ repo: dir, fileTypes: [".pdf", "csv", "  ", ""] });
    // "  " and "" trimmed to nothing, skipped
    // ".pdf" → "pdf-reader" (no reader mapping → generic)
    // "csv" → "csv-reader"
    const map = new Map(needs.map((n) => [n.need, n]));
    expect(map.has("csv-reader")).toBe(true);
  });

  test("derives needs from detected frameworks (line 116-122)", () => {
    const dir = tmpRepo();
    const needs = resolveSkillNeeds({
      repo: dir,
      profile: {
        name: "test",
        languages: ["ts"],
        frameworks: ["react", "vue"],
        hasCI: false,
        manifests: ["package.json"],
        findings: [],
      },
    });
    expect(needs.some((n) => n.need === "react docs")).toBe(true);
    expect(needs.some((n) => n.need === "vue docs")).toBe(true);
    expect(needs.find((n) => n.need === "react docs")?.status).toBe("missing");
  });

  test("attachment with no ext derives an empty ext fallback (line 101-104)", () => {
    const dir = tmpRepo();
    const needs = resolveSkillNeeds({
      repo: dir,
      attachments: ["README", "noext", "file.md"],
    });
    // "README" has no extension → ext="" → reader="generic-file-reader"
    // "file.md" → reader="markdown-reader"
    const map = new Map(needs.map((n) => [n.need, n]));
    expect(map.has("generic-file-reader")).toBe(true);
    expect(map.has("markdown-reader")).toBe(true);
  });

  test("dedupes when same reader need is reported multiple times", () => {
    const dir = tmpRepo();
    const needs = resolveSkillNeeds({
      repo: dir,
      attachments: ["data.xlsx", "another.xlsx", "third.xlsx"],
    });
    // All three map to the same reader — Map dedupes.
    expect(needs.filter((n) => n.need === "xlsx-reader").length).toBe(1);
  });

  test("marks need as satisfied when a local verified skill matches by name", () => {
    const dir = tmpRepo();
    // Add a verified local skill whose name matches the reader for .md
    mkdirSync(join(dir, ".vibeflow", "skills", "markdown-reader"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, ".vibeflow", "skills", "markdown-reader", "SKILL.md"),
      "---\nname: markdown-reader\ndescription: a real markdown reader for testing\nstatus: verified\n---\n\n# Markdown Reader\n\nSufficient body content to clear the placeholder check for the validator.\n",
    );
    const needs = resolveSkillNeeds({ repo: dir, attachments: ["file.md"] });
    const mdNeed = needs.find((n) => n.need === "markdown-reader");
    expect(mdNeed).toBeDefined();
    expect(mdNeed?.status).toBe("satisfied");
    expect(mdNeed?.satisfiedBy).toBe("markdown-reader");
  });
});

describe("renderSkillNeeds", () => {
  test("returns the empty message when no needs", () => {
    const out = renderSkillNeeds([]);
    expect(out).toContain("No skill needs");
  });

  test("renders satisfied needs with ✓ and satisfiedBy (line 134-135)", () => {
    const out = renderSkillNeeds([
      {
        need: "xlsx-reader",
        reason: "attachment data.xlsx",
        status: "satisfied",
        satisfiedBy: "xlsx-reader",
      },
    ]);
    expect(out).toContain("✓");
    expect(out).toContain("satisfied by xlsx-reader");
  });

  test("renders missing needs with • and acquire command (line 133-136)", () => {
    const out = renderSkillNeeds([
      {
        need: "xlsx-reader",
        reason: "attachment data.xlsx",
        status: "missing",
        acquire: "vf discover skills xlsx --yes",
      },
    ]);
    expect(out).toContain("•");
    expect(out).toContain("missing — vf discover skills xlsx --yes");
  });
});

describe("skillNames (test seam)", () => {
  test("skillNames: statSync throws → entry filtered out (line 36-37)", () => {
    const { skillNames } = require("../src/skills/sync.js");
    const r = skillNames("/tmp", {
      readdirSync: (_p: string) => ["a", "b"],
      statSync: () => {
        throw new Error("perm denied");
      },
    });
    // Both entries fail statSync → both filtered out → empty list
    expect(r).toEqual([]);
  });

  test("syncSkillMirrors: statSync throws on entry → skipped (line 46-47)", () => {
    // The same statSync try/catch in skillNames is also in
    // syncSkillMirrors's iteration. Inject a throwing statSync.
    const { syncSkillMirrors } = require("../src/skills/sync.js");
    const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vf-sync-stat-"));
    mkdirSync(join(dir, ".vibeflow", "skills"), { recursive: true });
    try {
      const r = syncSkillMirrors(dir, {
        statSync: () => {
          throw new Error("perm denied");
        },
      });
      // No errors, no synced skills (all skipped)
      expect(r.errors).toEqual([]);
      expect(r.synced).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skillNames: real broken symlink filtered (line 46-47)", () => {
    // A real broken symlink in the skills dir causes statSync to
    // throw ENOENT. The catch fires and the entry is filtered out.
    const { skillNames } = require("../src/skills/sync.js");
    const fs2 = require("node:fs") as typeof import("node:fs");
    const dir = fs2.mkdtempSync(join(tmpdir(), "vf-sync-brokensym-"));
    try {
      const base = join(dir, ".vibeflow", "skills");
      fs2.mkdirSync(base, { recursive: true });
      fs2.mkdirSync(join(base, "realdir"));
      fs2.symlinkSync("/nonexistent/abc", join(base, "brokensym"));
      const r = skillNames(dir);
      expect(r).toEqual(["realdir"]);
    } finally {
      fs2.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateSkillDir (test seam)", () => {
  test("validateSkillDir: readFileSync throws → ok:false with 'cannot read' (line 35-40)", () => {
    const { validateSkillDir } = require("../src/skills/validator.js");
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("disk on fire");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => e.includes("cannot read SKILL.md"))).toBe(true);
  });

  test("validateSkillDir: readdirSync throws → warning 'could not inspect' (line 92-94)", () => {
    const { validateSkillDir } = require("../src/skills/validator.js");
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        "---\nname: x\ndescription: y\n---\n\n# Body\n\nHas a body that is long enough to pass the validation check.\n",
      readdirSync: () => {
        throw new Error("perm denied");
      },
    });
    expect(r.warnings.some((w: string) => w.includes("could not inspect"))).toBe(true);
  });

  test("validateSkillDir: statSync throws on ALLOWED_DIRS entry → ignored (line 86-87)", () => {
    const { validateSkillDir } = require("../src/skills/validator.js");
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        "---\nname: x\ndescription: y\n---\n\n# Body\n\nHas a body that is long enough to pass the validation check.\n",
      readdirSync: (_p: string) => ["examples"],
      statSync: () => {
        throw new Error("perm denied");
      },
    });
    expect(r.warnings.some((w: string) => w.includes("is empty"))).toBe(false);
  });

  test("validateSkillDir: readdirSync throws on inner ALLOWED_DIRS entry → ignored (line 84-85)", () => {
    const { validateSkillDir } = require("../src/skills/validator.js");
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        "---\nname: x\ndescription: y\n---\n\n# Body\n\nHas a body that is long enough to pass the validation check.\n",
      readdirSync: (p: string) => {
        if (p === "/tmp") return ["examples"];
        throw new Error("inner perm denied");
      },
      statSync: () => ({ isDirectory: () => true }),
    });
    expect(r.warnings.some((w: string) => w.includes("is empty"))).toBe(false);
  });
});

describe("importer catch branches (line 53, 87)", () => {
  test("importSkillFromDir: cpSync throws → catch fires (line 53)", () => {
    const { importSkillFromDir } = require("../src/skills/importer.js");
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = fs.mkdtempSync(join(tmpdir(), "vf-imp-err-"));
    try {
      const src = join(dir, "mysrc");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(
        join(src, "SKILL.md"),
        "---\nname: mysrc\ndescription: y\n---\n\n# Body\n\nHas a body that is long enough to pass the validation check.\n",
      );
      const r = importSkillFromDir(dir, src, {
        cpSync: () => {
          throw new Error("disk on fire");
        },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e: string) => e.includes("disk on fire"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("importSkillsFromParent: readdirSync throws → catch fires (line 87)", () => {
    const { importSkillsFromParent } = require("../src/skills/importer.js");
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = fs.mkdtempSync(join(tmpdir(), "vf-imp-parent-"));
    fs.mkdirSync(dir, { recursive: true });
    try {
      const r = importSkillsFromParent(dir, dir, {
        readdirSync: () => {
          throw new Error("perm denied");
        },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e: string) => e.includes("perm denied"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("importSkillsFromParent: statSync throws → entry skipped (line 97)", () => {
    // Inject a statSync that throws on the entry check. The catch
    // fires and the entry is skipped.
    const { importSkillsFromParent } = require("../src/skills/importer.js");
    const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vf-imp-stat-throw-"));
    mkdirSync(dir, { recursive: true });
    try {
      const r = importSkillsFromParent(dir, dir, {
        statSync: () => {
          throw new Error("perm denied");
        },
      });
      // No entries succeed (all skipped via catch). ok is true
      // because errors.length === 0.
      expect(r.ok).toBe(true);
      expect(r.imported).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registryLockPath, writeRegistryLock } from "../src/skills/registry-channel";
import { skillBundleHash } from "../src/skills/registry-install";
import { requiredSkillNames, syncSkillMirrors, verifySkillSync } from "../src/skills/sync";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("syncSkillMirrors pointer mode (default)", () => {
  test("writes a small pointer SKILL.md to the default engine mirror (copilot)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-"));
    dirs.push(repo);
    // Issue #631: catalogDir is now an isolated shared-catalog stand-in, separate
    // from repo's project-local .vibeflow/skills/ (which shadows it when present).
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-catalog-"));
    dirs.push(catalogDir);
    const src = join(catalogDir, "project-fit-skill");
    mkdirSync(join(src, "references"), { recursive: true });
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: project-fit-skill\ndescription: Project-specific workflow skill.\n---\n\n# Project Fit\n\nUse this skill for project-specific workflow guidance.\n",
    );
    writeFileSync(join(src, "references", "domain.md"), "domain notes");
    writeFileSync(join(src, "scripts", "helper.js"), "console.log('ok')\n");

    const result = syncSkillMirrors(repo, { mode: "pointer", catalogDir });
    expect(result.ok).toBe(true);
    // Default is copilot only — must NOT touch .claude/ or .agents/ skill dirs.
    const pointer = readFileSync(
      join(repo, ".github", "skills", "project-fit-skill", "SKILL.md"),
      "utf8",
    );
    expect(pointer).toContain("~/.vibeflow/skills/project-fit-skill/SKILL.md");
    expect(
      existsSync(join(repo, ".github", "skills", "project-fit-skill", "references", "domain.md")),
    ).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "project-fit-skill"))).toBe(false);
    expect(existsSync(join(repo, ".agents", "skills", "project-fit-skill"))).toBe(false);
  });

  test("does not write mirrors if canonical skill fails validation", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-invalid-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "bad-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: bad-skill\n---\n\nTODO\n");

    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, { mode: "pointer", catalogDir });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(repo, ".claude", "skills", "bad-skill"))).toBe(false);
  });

  test("syncs only the specified engine mirrors when engines= is passed", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-engines-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "picked-engine-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: picked-engine-skill\ndescription: Only one engine mirror.\n---\n\n# Picked\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );
    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude"],
      catalogDir,
    });
    expect(result.ok).toBe(true);
    // Only the claude mirror should exist; the others must be absent.
    expect(existsSync(join(repo, ".claude", "skills", "picked-engine-skill"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "picked-engine-skill"))).toBe(false);
    expect(existsSync(join(repo, ".github", "skills", "picked-engine-skill"))).toBe(false);
  });

  test("syncs only the requested canonical skill into the codex mirror", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-codex-target-"));
    dirs.push(repo);
    const selected = join(repo, ".vibeflow", "skills", "typed-protocol-contracts");
    mkdirSync(selected, { recursive: true });
    writeFileSync(
      join(selected, "SKILL.md"),
      "---\nname: typed-protocol-contracts\ndescription: The targeted canonical skill.\n---\n\n# Typed Protocol Contracts\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );
    const untouched = join(repo, ".vibeflow", "skills", "other-skill");
    mkdirSync(untouched, { recursive: true });
    writeFileSync(
      join(untouched, "SKILL.md"),
      "---\nname: other-skill\ndescription: Another canonical skill.\n---\n\n# Other Skill\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );

    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["codex"],
      skills: ["typed-protocol-contracts"],
      catalogDir,
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toEqual([join(".agents", "skills", "typed-protocol-contracts")]);
    expect(
      existsSync(join(repo, ".agents", "skills", "typed-protocol-contracts", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "other-skill"))).toBe(false);
    expect(existsSync(join(repo, ".github", "skills", "typed-protocol-contracts"))).toBe(false);
  });

  test("ignores unknown engine names in the engines= array", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-bad-engine-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "ok-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: ok-skill\ndescription: An ok skill.\n---\n\n# Ok\n\nActionable body content for validation. This is more than fifty characters long so it passes the body check.\n",
    );
    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      // Force a non-engine value to exercise the filter branch.
      engines: ["not-a-real-engine" as unknown as "claude"],
      catalogDir,
    });
    expect(result.ok).toBe(true);
    // Unknown engine filtered out → no mirrors written.
    expect(result.synced).toEqual([]);
  });
});

describe("syncSkillMirrors full mode", () => {
  test("copies the entire skill directory including references and scripts", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-full-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "project-fit-skill");
    mkdirSync(join(src, "references"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: project-fit-skill\ndescription: Project-specific workflow skill.\n---\n\n# Project Fit\n\nUse this skill for project-specific workflow guidance.\n",
    );
    writeFileSync(join(src, "references", "domain.md"), "domain notes");
    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, { mode: "full", catalogDir });
    expect(result.ok).toBe(true);
    // Default is copilot mirror only
    expect(
      readFileSync(
        join(repo, ".github", "skills", "project-fit-skill", "references", "domain.md"),
        "utf8",
      ),
    ).toBe("domain notes");
  });
});

describe("full mode mirrors the references/ subtree (#326)", () => {
  test("copies every references/*.md into each requested engine mirror", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-refs-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "vf");
    mkdirSync(join(src, "references"), { recursive: true });
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: vf\ndescription: The vf workflow skill.\n---\n\n# vf\n\nDrive every task through the vf loop with the confidence gate and recorded evidence.\n",
    );
    // The #322 split moved the long workflow detail OUT of SKILL.md into references/*.md.
    // Full-mode sync MUST mirror that whole subtree, not just SKILL.md (cross-review gap).
    const refs: Record<string, string> = {
      "flow.md": "# Flow A-D\nfull workflow narrative",
      "pitfalls.md": "# Pitfalls\nknown failure modes",
      "hooks.md": "# Hooks\nguardrail reference",
    };
    for (const [name, body] of Object.entries(refs)) {
      writeFileSync(join(src, "references", name), body);
    }
    writeFileSync(join(src, "scripts", "doctor.sh"), "#!/bin/sh\necho ok\n");

    const engines = ["claude", "codex", "copilot"] as const;
    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = syncSkillMirrors(repo, { mode: "full", engines: [...engines], catalogDir });
    expect(result.ok).toBe(true);

    const mirrorRoot: Record<(typeof engines)[number], string> = {
      claude: ".claude",
      codex: ".agents",
      copilot: ".github",
    };
    for (const engine of engines) {
      const refDir = join(repo, mirrorRoot[engine], "skills", "vf", "references");
      for (const [name, body] of Object.entries(refs)) {
        // Each references/*.md must be mirrored byte-identical — not just SKILL.md.
        expect(existsSync(join(refDir, name))).toBe(true);
        expect(readFileSync(join(refDir, name), "utf8")).toBe(body);
      }
      // Full mode copies the whole dir, so SKILL.md is the real file (not a pointer stub).
      const skillMd = readFileSync(
        join(repo, mirrorRoot[engine], "skills", "vf", "SKILL.md"),
        "utf8",
      );
      expect(skillMd).toContain("confidence gate");
      expect(skillMd).not.toContain("Canonical skill lives at");
    }
  });
});

describe("verifySkillSync", () => {
  test("reports missing mirrors per engine", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-missing-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "missing-mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: missing-mirror\ndescription: Missing mirror test skill.\n---\n\n# Missing Mirror\n\nEnough actionable body content for validation.\n",
    );
    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = verifySkillSync(repo, undefined, { catalogDir });
    expect(result.ok).toBe(false);
    // Mirror paths are joined with the platform separator; just check the
    // trailing segment to be cross-platform safe.
    expect(result.errors.join("\n")).toMatch(/missing-mirror[\\/]SKILL\.md missing/);
  });

  test("reports ok when all mirrors are present", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-ok-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "all-good");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: all-good\ndescription: All good mirror test skill.\n---\n\n# All Good\n\nEnough actionable body content for validation.\n",
    );
    const catalogDir = join(repo, ".vibeflow", "skills");
    syncSkillMirrors(repo, { mode: "pointer", catalogDir });
    const result = verifySkillSync(repo, undefined, { catalogDir });
    expect(result.ok).toBe(true);
  });
});

// Documented limitation: skillNames's statSync catch (line 36-37) cannot
// be exercised in unit tests without mocking node:fs. The branch
// fires only on race conditions (file deleted between readdirSync and
// statSync) or symlink loops, neither of which we can reliably trigger.

describe("requiredSkillNames from registry lock", () => {
  test("returns empty when no registries in lock", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-reg-empty-"));
    dirs.push(repo);
    const result = requiredSkillNames(repo);
    expect(result.names).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("returns names from lock with matching catalog dirs", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-reg-ok-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-reg-cat-"));
    dirs.push(catalogDir);

    // Write a lock file with an installed skill
    const lockDir = join(repo, ".vibeflow");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "test-reg",
            url: "https://example.com/repo.git",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "installed-skill", version: "1.0.0", commitOID: "a".repeat(40) }],
          },
        ],
      }),
    );
    // Create matching catalog dir
    mkdirSync(join(catalogDir, "installed-skill"), { recursive: true });

    const result = requiredSkillNames(repo, { catalogDir });
    expect(result.names).toEqual(["installed-skill"]);
    expect(result.errors).toEqual([]);
  });

  test("reports errors when lock has installed skills missing from catalog", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-reg-miss-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-reg-cat-miss-"));
    dirs.push(catalogDir);

    const lockDir = join(repo, ".vibeflow");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "test-reg",
            url: "https://example.com/repo.git",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "missing-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );

    const result = requiredSkillNames(repo, { catalogDir });
    expect(result.names).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("missing-skill");
    expect(result.errors[0]).toContain("registry install");
  });
});

describe("syncSkillMirrors --from-registry", () => {
  test("also mirrors registry-pinned skills alongside canonical ones", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-sync-reg-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-sync-reg-cat-"));
    dirs.push(catalogDir);

    // A canonical skill in catalog
    mkdirSync(join(catalogDir, "canonical-skill"), { recursive: true });
    writeFileSync(
      join(catalogDir, "canonical-skill", "SKILL.md"),
      "---\nname: canonical-skill\ndescription: Canonical skill.\n---\n\n# Canonical\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );

    // A registry-pinned skill in catalog
    mkdirSync(join(catalogDir, "reg-pinned-skill"), { recursive: true });
    writeFileSync(
      join(catalogDir, "reg-pinned-skill", "SKILL.md"),
      "---\nname: reg-pinned-skill\ndescription: Registry-pinned skill.\n---\n\n# Reg Pinned\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );

    // Write lock file with reg-pinned-skill installed
    const lockDir = join(repo, ".vibeflow");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/repo.git",
            ref: "v1",
            commitOID: "c".repeat(40),
            installed: [{ name: "reg-pinned-skill", version: "1.0.0", commitOID: "c".repeat(40) }],
          },
        ],
      }),
    );

    // Sync with --from-registry to claude + opencode mirrors
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude", "opencode"],
      fromRegistry: true,
      catalogDir,
    });
    expect(result.ok).toBe(true);
    // Both canonical and registry-pinned should be mirrored
    expect(existsSync(join(repo, ".claude", "skills", "canonical-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "skills", "reg-pinned-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".opencode", "skills", "canonical-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".opencode", "skills", "reg-pinned-skill", "SKILL.md"))).toBe(
      true,
    );
  });
});

describe("verifySkillSync --from-registry", () => {
  test("fails when registry-pinned skill has no mirror stub", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-verify-reg-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-verify-reg-cat-"));
    dirs.push(catalogDir);

    // Canonical skill
    mkdirSync(join(catalogDir, "my-skill"), { recursive: true });
    writeFileSync(
      join(catalogDir, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Test skill.\n---\n\n# My Skill\n\nActionable body content that is long enough for validation purposes.\n",
    );
    // Mirror it to claude only
    syncSkillMirrors(repo, { mode: "pointer", engines: ["claude"], catalogDir });

    // Write lock with a DIFFERENT reg-pinned skill that has NO mirror
    const lockDir = join(repo, ".vibeflow");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "other-reg",
            url: "https://example.com/repo.git",
            ref: "v1",
            commitOID: "d".repeat(40),
            installed: [{ name: "orphan-skill", version: "1.0.0", commitOID: "d".repeat(40) }],
          },
        ],
      }),
    );
    // Create catalog dir for orphan skill so it's not a "missing from catalog" error
    mkdirSync(join(catalogDir, "orphan-skill"), { recursive: true });
    writeFileSync(
      join(catalogDir, "orphan-skill", "SKILL.md"),
      "---\nname: orphan-skill\ndescription: Orphan test.\n---\n\n# Orphan\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );

    const result = verifySkillSync(repo, ["claude", "opencode"], {
      fromRegistry: true,
      catalogDir,
    });
    // Should have errors for orphan-skill missing from opencode mirror
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("orphan-skill") && e.includes("SKILL.md missing")),
    ).toBe(true);
  });
});

describe("verifySkillSync --from-registry bundleHash (#694)", () => {
  function setup(): { repo: string; catalogDir: string; lockDir: string; skillName: string } {
    const repo = mkdtempSync(join(tmpdir(), "vf-bhash-verify-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-bhash-cat-"));
    dirs.push(catalogDir);
    const skillName = "bhash-skill";
    mkdirSync(join(catalogDir, skillName), { recursive: true });
    writeFileSync(
      join(catalogDir, skillName, "SKILL.md"),
      "---\nname: bhash-skill\ndescription: test\n---\n\n# BHash\n\nContent for validation purposes. This is more than fifty characters.\n",
    );
    const lockDir = join(repo, ".vibeflow");
    mkdirSync(lockDir, { recursive: true });
    return { repo, catalogDir, lockDir, skillName };
  }

  function writeLock(lockDir: string, skillName: string, bundleHash?: string): void {
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "test-reg",
            url: "https://example.com/repo.git",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [
              {
                name: skillName,
                version: "1.0.0",
                commitOID: "a".repeat(40),
                ...(bundleHash !== undefined ? { bundleHash } : {}),
              },
            ],
          },
        ],
      }),
    );
  }

  test("matching bundleHash → passes", () => {
    const { repo, catalogDir, lockDir, skillName } = setup();
    // --from-registry without explicit engines verifies every mirror.
    syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude", "codex", "copilot", "opencode", "antigravity"],
      catalogDir,
    });
    const hash = skillBundleHash(join(catalogDir, skillName));
    writeLock(lockDir, skillName, hash);
    const result = verifySkillSync(repo, undefined, { fromRegistry: true, catalogDir });
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("mismatched bundleHash → error with reinstall command", () => {
    const { repo, catalogDir, lockDir, skillName } = setup();
    syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude", "codex", "copilot", "opencode", "antigravity"],
      catalogDir,
    });
    writeLock(lockDir, skillName, "f".repeat(64));
    const result = verifySkillSync(repo, undefined, { fromRegistry: true, catalogDir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("bundle hash mismatch"))).toBe(true);
    expect(result.errors.some((e) => e.includes("--on-collision=replace --yes"))).toBe(true);
  });

  test("missing bundleHash in lock → warns but passes (backward compat)", () => {
    const { repo, catalogDir, lockDir, skillName } = setup();
    syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude", "codex", "copilot", "opencode", "antigravity"],
      catalogDir,
    });
    writeLock(lockDir, skillName, undefined);
    const result = verifySkillSync(repo, undefined, { fromRegistry: true, catalogDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("no bundleHash"))).toBe(true);
  });
});

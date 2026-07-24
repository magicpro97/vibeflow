import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "../src/core";
import { toSafeSkills } from "../src/skills/api-types";
import type { RegistryLock } from "../src/skills/registry-types";

describe("toSafeSkills", () => {
  test("sets shared origin for skills under injected catalog dir", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-shared-"));
    const localDir = mkdtempSync(join(tmpdir(), "vf-safe-local-"));
    const skills: Skill[] = [
      {
        name: "shared-skill",
        description: "from shared catalog",
        status: "verified",
        dir: join(sharedDir, "shared-skill"),
        path: join(sharedDir, "shared-skill", "SKILL.md"),
      },
      {
        name: "local-skill",
        description: "from project-local",
        status: "experimental",
        dir: join(localDir, "local-skill"),
        path: join(localDir, "local-skill", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe).toHaveLength(2);
    const shared = safe.find((s) => s.name === "shared-skill");
    const local = safe.find((s) => s.name === "local-skill");
    expect(shared?.origin).toBe("shared");
    expect(local?.origin).toBe("project-local");
  });

  test("does not leak internal fields", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-noleak-"));
    const skills: Skill[] = [
      {
        name: "safe",
        description: "no internal fields",
        status: "draft",
        dir: join(sharedDir, "safe"),
        path: join(sharedDir, "safe", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    const keys = Object.keys(safe[0] ?? {});
    expect(keys).not.toContain("dir");
    expect(keys).not.toContain("path");
    expect(keys).not.toContain("triggers");
    expect(keys).not.toContain("capabilities");
    expect(keys).not.toContain("requires");
    expect(keys).not.toContain("mcp");
  });

  test("prepends version when present", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-ver-"));
    const skills: Skill[] = [
      {
        name: "versioned",
        description: "has version",
        status: "verified",
        version: "1.2.3",
        dir: join(sharedDir, "versioned"),
        path: join(sharedDir, "versioned", "SKILL.md"),
      },
      {
        name: "unversioned",
        description: "no version",
        status: "draft",
        dir: join(sharedDir, "unversioned"),
        path: join(sharedDir, "unversioned", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe.find((s) => s.name === "versioned")?.version).toBe("1.2.3");
    expect(safe.find((s) => s.name === "unversioned")?.version).toBeUndefined();
  });

  test("attaches registry metadata for installed skills from lock", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-reg-"));
    const skills: Skill[] = [
      {
        name: "installed-skill",
        description: "from registry",
        status: "verified",
        version: "1.0.0",
        dir: join(sharedDir, "installed-skill"),
        path: join(sharedDir, "installed-skill", "SKILL.md"),
      },
      {
        name: "local-only",
        description: "not in registry",
        status: "draft",
        dir: join(sharedDir, "local-only"),
        path: join(sharedDir, "local-only", "SKILL.md"),
      },
    ];
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [
        {
          name: "platform",
          url: "https://example.com/repo.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [{ name: "installed-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
        },
      ],
    };
    const safe = toSafeSkills(skills, sharedDir, lock);
    const regSkill = safe.find((s) => s.name === "installed-skill");
    expect(regSkill?.registry).toBeDefined();
    expect(regSkill?.registry?.id).toBe("platform");
    expect(regSkill?.registry?.version).toBe("1.0.0");
    expect(regSkill?.registry?.pinned).toBe(true);
    const noReg = safe.find((s) => s.name === "local-only");
    expect(noReg?.registry).toBeUndefined();
  });

  test("registry undefined when no lock passed", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-nolock-"));
    const skills: Skill[] = [
      {
        name: "free",
        description: "no lock file",
        status: "verified",
        dir: join(sharedDir, "free"),
        path: join(sharedDir, "free", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe[0]?.registry).toBeUndefined();
  });

  test("does not expose dir/path/mcp/requires in registry-enriched output", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf-safe-noleak2-"));
    const skills: Skill[] = [
      {
        name: "safe",
        description: "still no leaks",
        status: "verified",
        dir: join(sharedDir, "safe"),
        path: join(sharedDir, "safe", "SKILL.md"),
      },
    ];
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg",
          url: "x",
          ref: "x",
          commitOID: "a".repeat(40),
          installed: [{ name: "safe", version: "1.0.0", commitOID: "b".repeat(40) }],
        },
      ],
    };
    const safe = toSafeSkills(skills, sharedDir, lock);
    const keys = Object.keys(safe[0] ?? {});
    expect(keys).not.toContain("dir");
    expect(keys).not.toContain("path");
    expect(keys).not.toContain("triggers");
    expect(keys).not.toContain("capabilities");
    expect(keys).not.toContain("requires");
    expect(keys).not.toContain("mcp");
  });
});

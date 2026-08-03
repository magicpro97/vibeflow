import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "../src/core";
import { type SafeSkill, toSafeSkills } from "../src/skills/api-types";
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

  // ── #690: scope, domain, owners, stale ──────────────────────────────────

  test("maps scope from Skill", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf690-scope-"));
    const skills: Skill[] = [
      {
        name: "common-skill",
        description: "common scope",
        status: "verified",
        scope: "common",
        dir: join(sharedDir, "common-skill"),
        path: join(sharedDir, "common-skill", "SKILL.md"),
      },
      {
        name: "project-skill",
        description: "project scope",
        status: "verified",
        scope: "project",
        projectId: "my-repo",
        dir: join(sharedDir, "project-skill"),
        path: join(sharedDir, "project-skill", "SKILL.md"),
      },
      {
        name: "no-scope",
        description: "no scope set",
        status: "draft",
        dir: join(sharedDir, "no-scope"),
        path: join(sharedDir, "no-scope", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe.find((s) => s.name === "common-skill")?.scope).toBe("common");
    expect(safe.find((s) => s.name === "project-skill")?.scope).toBe("project");
    expect(safe.find((s) => s.name === "no-scope")?.scope).toBeUndefined();
  });

  test("maps domain metadata from Skill", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf690-domain-"));
    const skills: Skill[] = [
      {
        name: "with-domain",
        description: "has domain",
        status: "verified",
        dir: join(sharedDir, "with-domain"),
        path: join(sharedDir, "with-domain", "SKILL.md"),
        domain: { id: "testing", role: "canonical" },
      },
      {
        name: "no-domain",
        description: "no domain",
        status: "draft",
        dir: join(sharedDir, "no-domain"),
        path: join(sharedDir, "no-domain", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    const withDomain = safe.find((s) => s.name === "with-domain");
    expect(withDomain?.domain).toBeDefined();
    expect(withDomain?.domain?.id).toBe("testing");
    expect(withDomain?.domain?.role).toBe("canonical");
    expect(safe.find((s) => s.name === "no-domain")?.domain).toBeUndefined();
  });

  test("maps owners from Skill", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf690-owners-"));
    const skills: Skill[] = [
      {
        name: "owned",
        description: "has owners",
        status: "verified",
        dir: join(sharedDir, "owned"),
        path: join(sharedDir, "owned", "SKILL.md"),
        owners: ["alice@example.com", "bob@example.com"],
      },
      {
        name: "unowned",
        description: "no owners",
        status: "draft",
        dir: join(sharedDir, "unowned"),
        path: join(sharedDir, "unowned", "SKILL.md"),
      },
      {
        name: "empty-owners",
        description: "empty array",
        status: "draft",
        owners: [],
        dir: join(sharedDir, "empty-owners"),
        path: join(sharedDir, "empty-owners", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe.find((s) => s.name === "owned")?.owners).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(safe.find((s) => s.name === "unowned")?.owners).toBeUndefined();
    expect(safe.find((s) => s.name === "empty-owners")?.owners).toBeUndefined();
  });

  test("maps stale status from freshness", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf690-stale-"));
    const skills: Skill[] = [
      {
        name: "stale-skill",
        description: "out of date",
        status: "verified",
        dir: join(sharedDir, "stale-skill"),
        path: join(sharedDir, "stale-skill", "SKILL.md"),
        freshness: "stale",
        freshnessReason: "source file hash mismatch",
      },
      {
        name: "fresh-skill",
        description: "up to date",
        status: "verified",
        dir: join(sharedDir, "fresh-skill"),
        path: join(sharedDir, "fresh-skill", "SKILL.md"),
        freshness: "fresh",
      },
      {
        name: "unknown-skill",
        description: "not checked",
        status: "draft",
        dir: join(sharedDir, "unknown-skill"),
        path: join(sharedDir, "unknown-skill", "SKILL.md"),
        freshness: "unknown",
      },
      {
        name: "no-freshness",
        description: "freshness undefined",
        status: "draft",
        dir: join(sharedDir, "no-freshness"),
        path: join(sharedDir, "no-freshness", "SKILL.md"),
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    expect(safe.find((s) => s.name === "stale-skill")?.stale).toBe(true);
    expect(safe.find((s) => s.name === "stale-skill")?.staleReason).toBe(
      "source file hash mismatch",
    );
    expect(safe.find((s) => s.name === "fresh-skill")?.stale).toBeUndefined();
    expect(safe.find((s) => s.name === "unknown-skill")?.stale).toBeUndefined();
    expect(safe.find((s) => s.name === "no-freshness")?.stale).toBeUndefined();
    expect(safe.find((s) => s.name === "fresh-skill")?.staleReason).toBeUndefined();
    expect(safe.find((s) => s.name === "unknown-skill")?.staleReason).toBeUndefined();
    expect(safe.find((s) => s.name === "no-freshness")?.staleReason).toBeUndefined();
  });

  test("backward compatible: new fields are optional for old clients", () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "vf690-bc-"));
    const skills: Skill[] = [
      {
        name: "full",
        description: "all fields",
        status: "verified",
        version: "1.0.0",
        scope: "project",
        projectId: "my-repo",
        dir: join(sharedDir, "full"),
        path: join(sharedDir, "full", "SKILL.md"),
        domain: { id: "db", role: "canonical" },
        owners: ["ops@example.com"],
        freshness: "stale",
        freshnessReason: "hash mismatch",
      },
    ];
    const safe = toSafeSkills(skills, sharedDir);
    const s = safe[0] as SafeSkill;
    // Old fields still present
    expect(s.name).toBe("full");
    expect(s.description).toBe("all fields");
    expect(s.version).toBe("1.0.0");
    expect(s.status).toBe("verified");
    expect(s.origin).toBe("shared");
    expect(s.securityScan).toBe("not-scanned");
    // New fields present
    expect(s.scope).toBe("project");
    expect(s.domain).toBeDefined();
    expect(s.owners).toEqual(["ops@example.com"]);
    expect(s.stale).toBe(true);
    expect(s.staleReason).toBe("hash mismatch");
  });
});

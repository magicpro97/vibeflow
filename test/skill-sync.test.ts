import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registryLockPath, writeRegistryLock } from "../src/skills/registry-channel";
import { skillBundleHash } from "../src/skills/registry-install";
import {
  mirrorDescriptionFrom,
  requiredSkillNames,
  syncSkillMirrors,
  verifySkillSync,
} from "../src/skills/sync";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("mirrorDescriptionFrom", () => {
  test("collapses a multi-line description to one line without changing words", () => {
    const multiline = "Use when auditing fixtures.\n  Keeps trigger words, drops newlines.";
    expect(mirrorDescriptionFrom(multiline)).toBe(
      "Use when auditing fixtures. Keeps trigger words, drops newlines.",
    );
  });

  test("keeps a long description verbatim, including its exclusion clause", () => {
    const long = `${"Use when reviewing pull requests. ".repeat(8)}Not for legacy PHP repos.`;
    const out = mirrorDescriptionFrom(long);
    expect(out).toBe(long.trim());
    expect(out?.endsWith("Not for legacy PHP repos.")).toBe(true);
  });

  test("returns undefined for a missing, non-string or blank description", () => {
    expect(mirrorDescriptionFrom(undefined as unknown as string)).toBeUndefined();
    expect(mirrorDescriptionFrom("   ")).toBeUndefined();
  });
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

  test("pointer stub carries the canonical description, not a placeholder", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-desc-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-catalog-desc-"));
    dirs.push(catalogDir);
    const src = join(catalogDir, "described-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: described-skill\ndescription: Route vendor invoices through the approval queue.\n---\n\n# Described\n\n1. Open the invoice queue.\n2. Approve or reject each invoice with a reason.\n3. Re-run the reconciliation report to confirm the queue is empty.\n",
    );

    const result = syncSkillMirrors(repo, { mode: "pointer", catalogDir });
    expect(result.ok).toBe(true);
    const pointer = readFileSync(
      join(repo, ".github", "skills", "described-skill", "SKILL.md"),
      "utf8",
    );
    expect(pointer).toContain('description: "Route vendor invoices through the approval queue."');
    expect(pointer).not.toContain("See canonical SKILL.md");
  });

  test("pointer stub keeps a long description verbatim (no silent truncation)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-long-"));
    dirs.push(repo);
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-catalog-long-"));
    dirs.push(catalogDir);
    const src = join(catalogDir, "verbose-skill");
    mkdirSync(src, { recursive: true });
    const firstSentence = "Use when auditing generated fixtures against the canonical schema.";
    const long = `${firstSentence} ${"Extra trigger detail. ".repeat(20)}`.trim();
    writeFileSync(
      join(src, "SKILL.md"),
      `---\nname: verbose-skill\ndescription: ${JSON.stringify(long)}\n---\n\n# Verbose\n\n1. Collect the fixtures.\n2. Compare each field against the canonical schema.\n3. Report mismatches with file and line so the author can fix them.\n`,
    );

    const result = syncSkillMirrors(repo, { mode: "pointer", catalogDir });
    expect(result.ok).toBe(true);
    const pointer = readFileSync(
      join(repo, ".github", "skills", "verbose-skill", "SKILL.md"),
      "utf8",
    );
    const line = pointer.split("\n").find((l) => l.startsWith("description: ")) ?? "";
    const value = JSON.parse(line.slice("description: ".length)) as string;
    expect(value).toBe(long);
    expect(value.endsWith("Extra trigger detail.")).toBe(true);
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
  test("flags a pointer stub whose description no longer matches the canonical", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-stale-desc-"));
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-sync-stale-catalog-"));
    dirs.push(repo, catalogDir);
    const source = join(catalogDir, "stale-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: stale-skill\ndescription: Use when auditing fixture drift.\n---\n\n# Stale\n\nThis actionable canonical body is deliberately longer than fifty characters.\n",
    );
    expect(syncSkillMirrors(repo, { mode: "pointer", engines: ["claude"], catalogDir }).ok).toBe(
      true,
    );
    expect(verifySkillSync(repo, ["claude"], { catalogDir }).ok).toBe(true);

    // Canonical description edited after the stub was mirrored: the path is still
    // right, so only a description comparison can catch the stale stub.
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: stale-skill\ndescription: Use when auditing fixture drift and stale mirrors.\n---\n\n# Stale\n\nThis actionable canonical body is deliberately longer than fifty characters.\n",
    );
    const stale = verifySkillSync(repo, ["claude"], { catalogDir });
    expect(stale.ok).toBe(false);
    expect(stale.errors.join("\n")).toMatch(/description differs from canonical/);
  });

  test("round-trips a description containing double quotes", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-quotes-"));
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-sync-quotes-catalog-"));
    dirs.push(repo, catalogDir);
    const source = join(catalogDir, "quoted-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      '---\nname: quoted-skill\ndescription: Use when the user says "make me a GIF" for Slack.\n---\n\n# Quoted\n\nThis actionable canonical body is deliberately longer than fifty characters.\n',
    );
    expect(syncSkillMirrors(repo, { mode: "pointer", engines: ["claude"], catalogDir }).ok).toBe(
      true,
    );
    const stub = readFileSync(join(repo, ".claude", "skills", "quoted-skill", "SKILL.md"), "utf8");
    const line = stub.split("\n").find((l) => l.startsWith("description: ")) ?? "";
    expect(JSON.parse(line.slice("description: ".length))).toBe(
      'Use when the user says "make me a GIF" for Slack.',
    );
    expect(verifySkillSync(repo, ["claude"], { catalogDir }).ok).toBe(true);
  });

  test("accepts the placeholder stub when the canonical has no description", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-no-desc-"));
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-sync-no-desc-catalog-"));
    dirs.push(repo, catalogDir);
    const source = join(catalogDir, "no-desc-skill");
    mkdirSync(source, { recursive: true });
    // Validator rejects this during sync, so the stub can only exist from an
    // earlier sync — verify must still agree with what pointerBody() writes.
    writeFileSync(
      join(source, "SKILL.md"),
      '---\nname: no-desc-skill\ndescription: ""\n---\n\n# No Desc\n\nThis actionable canonical body is deliberately longer than fifty characters.\n',
    );
    mkdirSync(join(repo, ".claude", "skills", "no-desc-skill"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "skills", "no-desc-skill", "SKILL.md"),
      '---\nname: no-desc-skill\ndescription: "See canonical SKILL.md for full details."\n---\n\n# no-desc-skill\n\nCanonical skill lives at:\n\n`~/.vibeflow/skills/no-desc-skill/SKILL.md`\n',
    );
    const result = verifySkillSync(repo, ["claude"], { catalogDir });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

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

  test("resolves shared-catalog full mirrors without a local canonical", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-shared-verify-"));
    const catalogDir = mkdtempSync(join(tmpdir(), "vf-skill-sync-shared-catalog-"));
    dirs.push(repo, catalogDir);
    const source = join(catalogDir, "shared-skill");
    mkdirSync(source, { recursive: true });
    const body =
      "---\nname: shared-skill\ndescription: Shared catalog skill.\n---\n\n# Shared\n\nThis actionable shared catalog body is deliberately longer than fifty characters.\n";
    writeFileSync(join(source, "SKILL.md"), body);
    const result = syncSkillMirrors(repo, {
      mode: "full",
      engines: ["claude"],
      catalogDir,
    });
    expect(result.ok).toBe(true);
    const verified = verifySkillSync(repo, ["claude"], { catalogDir });
    expect(verified.ok).toBe(true);
    expect(verified.errors).toEqual([]);
    expect(readFileSync(join(repo, ".claude", "skills", "shared-skill", "SKILL.md"), "utf8")).toBe(
      body,
    );
  });
  test("preserves full mirror validation for local canonical skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-local-full-"));
    dirs.push(repo);
    const canonical = join(repo, ".vibeflow", "skills", "local-skill");
    mkdirSync(canonical, { recursive: true });
    const body =
      "---\nname: local-skill\ndescription: Local skill.\n---\n\n# Local\n\nThis body is long enough for validation and has actionable instructions.\n";
    writeFileSync(join(canonical, "SKILL.md"), body);
    const result = syncSkillMirrors(repo, { mode: "full", engines: ["claude"] });
    expect(result.ok).toBe(true);
    const mirror = join(repo, ".claude", "skills", "local-skill", "SKILL.md");
    expect(readFileSync(mirror, "utf8")).toBe(body);
    expect(verifySkillSync(repo, ["claude"]).ok).toBe(true);
  });
  test("rejects a pointer with a canonical-path substring but wrong root", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-pointer-root-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "identity-skill");
    mkdirSync(src, { recursive: true });
    const canonical =
      "---\nname: identity-skill\ndescription: Identity check.\n---\n\n# Identity\n\nActionable body content for validation.\n";
    writeFileSync(join(src, "SKILL.md"), canonical);
    const mirror = join(repo, ".claude", "skills", "identity-skill");
    mkdirSync(mirror, { recursive: true });
    writeFileSync(
      join(mirror, "SKILL.md"),
      "---\nname: identity-skill\ndescription: pointer\n---\n\nCanonical skill lives at:\n`evil/.vibeflow/skills/identity-skill/SKILL.md`\n",
    );
    const result = verifySkillSync(repo, ["claude"]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      ".claude/skills/identity-skill/SKILL.md points at wrong canonical path",
    );
  });
  test("checks pointer target and full mirror byte identity", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-identity-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "identity-skill");
    mkdirSync(src, { recursive: true });
    const canonical =
      "---\nname: identity-skill\ndescription: Identity check.\n---\n\n# Identity\n\nActionable body content for validation.\n";
    writeFileSync(join(src, "SKILL.md"), canonical);
    const mirror = join(repo, ".claude", "skills", "identity-skill", "SKILL.md");
    mkdirSync(join(repo, ".claude", "skills", "identity-skill"), { recursive: true });

    writeFileSync(
      mirror,
      "---\nname: identity-skill\ndescription: bad\n---\n\nCanonical skill lives at:\n`.vibeflow/skills/wrong/SKILL.md`\n",
    );
    let result = verifySkillSync(repo, ["claude"], {
      catalogDir: join(repo, ".vibeflow", "skills"),
    });
    expect(result.errors.some((error) => error.includes("wrong canonical path"))).toBe(true);

    writeFileSync(mirror, canonical);
    result = verifySkillSync(repo, ["claude"], { catalogDir: join(repo, ".vibeflow", "skills") });
    expect(result.ok).toBe(true);

    writeFileSync(mirror, canonical.replace("Identity check", "Different mirror"));
    result = verifySkillSync(repo, ["claude"], { catalogDir: join(repo, ".vibeflow", "skills") });
    expect(result.errors.some((error) => error.includes("differs from canonical source"))).toBe(
      true,
    );
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR, c } from "../src/core.js";
import type { Skill } from "../src/core.js";
import type { AnchorFreshnessDeps } from "../src/skills/anchor-freshness.js";
import type { AuditDuplicatesResult } from "../src/skills/audit-duplicates.js";
import {
  type CuratorScanResult,
  type Finding,
  curatorScan,
  handleCuratorSubcommand,
  handleCuratorSubcommandWithDeps,
  parseCuratorScope,
  readCuratorFindings,
  writeCuratorFindings,
} from "../src/skills/curator-scan.js";
import type { RegistryLock } from "../src/skills/registry-types.js";

function makeSkill(name: string, anchors?: Record<string, string>): Skill {
  return {
    name,
    description: "test",
    status: "verified",
    sourceAnchors: anchors,
    dir: "",
    path: "",
  } as Skill;
}

function captureConsole(fn: () => number): { code: number; lines: string[] } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const spy = (s: string) => {
    lines.push(s.replace(/\n$/, ""));
  };
  console.log = spy as typeof console.log;
  console.error = spy as typeof console.error;
  try {
    const code = fn();
    return { code, lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("parseCuratorScope", () => {
  test("default [] returns local", () => {
    expect(parseCuratorScope([])).toBe("local");
  });

  test("only --scope=local and --scope=repo accepted", () => {
    expect(parseCuratorScope(["--scope=local"])).toBe("local");
    expect(parseCuratorScope(["--scope=repo"])).toBe("repo");
  });

  test("split --scope repo rejected", () => {
    expect(parseCuratorScope(["--scope", "repo"])).toBeNull();
  });

  test("duplicate and unknown scope rejected", () => {
    expect(parseCuratorScope(["--scope=local", "--scope=repo"])).toBeNull();
    expect(parseCuratorScope(["--scope=remote"])).toBeNull();
    expect(parseCuratorScope(["--scope=local", "--scope=local"])).toBeNull();
  });
});

describe("curatorScan", () => {
  test("no skills, no lock — empty findings", () => {
    const result = curatorScan("/nonexistent", {
      discoverSkills: () => [],
      checkAnchors: () => {
        throw new Error("should not be called");
      },
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toEqual([]);
    expect(result.schemaVersion).toBe(1);
  });

  test("detects stale anchors", () => {
    const result = curatorScan("/repo", {
      discoverSkills: () => [makeSkill("alpha", { "src/lib.ts": "deadbeef" })],
      checkAnchors: () => ({ status: "stale", reason: "content changed: src/lib.ts" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe("stale-anchor");
    expect((result.findings[0] as any).skill).toBe("alpha");
    expect(result.findings[0]?.detail).toBe("content changed: src/lib.ts");
  });

  test("detects duplicate owners", () => {
    const result = curatorScan("/repo", {
      discoverSkills: () => [makeSkill("a"), makeSkill("b")],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({
        errors: [],
        findings: [
          {
            type: "owns-fact-collision",
            skills: ["a", "b"],
            detail: 'Fact key "db" claimed by multiple skills: "a", "b"',
            recommendation: "parent-child",
          },
        ],
      }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe("duplicate-owner");
    expect((result.findings[0] as any).skills).toEqual(["a", "b"]);
  });

  test("detects unpinned registry records", () => {
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [
        {
          name: "main",
          url: "https://example.com/skills.git",
          ref: "main",
          commitOID: "abc123",
          installed: [
            { name: "alpha", version: "1.0", commitOID: "" },
            { name: "beta", version: "1.0", commitOID: "def456" },
          ],
        },
      ],
    };
    const result = curatorScan("/repo", {
      discoverSkills: () => [],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => lock,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe("unpinned-registry");
    expect((result.findings[0] as any).skill).toBe("alpha");
    expect((result.findings[0] as any).registry).toBe("main");
  });

  test("stable unique IDs — same input produces same IDs", () => {
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [
        {
          name: "main",
          url: "https://example.com/skills.git",
          ref: "main",
          commitOID: "abc",
          installed: [{ name: "bad", version: "1.0", commitOID: "" }],
        },
      ],
    };
    const r1 = curatorScan("/repo", {
      discoverSkills: () => [],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => lock,
    });
    const r2 = curatorScan("/repo", {
      discoverSkills: () => [],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => lock,
    });
    expect(r1.findings).toHaveLength(1);
    expect(r2.findings).toHaveLength(1);
    expect(r1.findings[0]?.id).toBe(r2.findings[0]?.id);
  });

  test("no duplicates — distinct stale skills are separate findings", () => {
    const result = curatorScan("/repo", {
      discoverSkills: () => [
        makeSkill("x", { "f.ts": "dead" }),
        makeSkill("y", { "f.ts": "dead" }),
      ],
      checkAnchors: () => ({ status: "stale", reason: "content changed: f.ts" }),
      auditSkillDuplicates: () => ({
        errors: [],
        findings: [
          {
            type: "owns-fact-collision",
            skills: ["x", "y"],
            detail: 'Fact key "k" claimed by multiple skills: "x", "y"',
            recommendation: "parent-child",
          },
        ],
      }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toHaveLength(3);
    const types = result.findings.map((f) => f.type);
    expect(types.filter((t) => t === "stale-anchor")).toHaveLength(2);
    expect(types.filter((t) => t === "duplicate-owner")).toHaveLength(1);
  });

  test("canonical order by type then findingKey", () => {
    const result = curatorScan("/repo", {
      discoverSkills: () => [
        makeSkill("z", { "z.ts": "dead" }),
        makeSkill("a", { "a.ts": "dead" }),
      ],
      checkAnchors: () => ({ status: "stale", reason: "content changed" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toHaveLength(2);
    const skills = result.findings.map((f) => (f as any).skill);
    expect(skills).toEqual(["a", "z"]);
  });

  test("skip trigger-overlap and procedure-duplicate findings", () => {
    const result = curatorScan("/repo", {
      discoverSkills: () => [makeSkill("a"), makeSkill("b")],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({
        errors: [],
        findings: [
          {
            type: "trigger-overlap",
            skills: ["a", "b"],
            detail: "overlap",
            recommendation: "merge",
          },
          {
            type: "procedure-duplicate",
            skills: ["a", "b"],
            detail: "dupe",
            recommendation: "merge",
          },
        ],
      }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe("writeCuratorFindings / readCuratorFindings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-cscan-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips findings file", () => {
    const result: CuratorScanResult = {
      schemaVersion: 1,
      findings: [{ id: "ab12", type: "stale-anchor", skill: "x", detail: "changed" }],
    };
    writeCuratorFindings(dir, result);
    const path = join(dir, CTX_DIR, "curator", "findings.json");
    expect(existsSync(path)).toBe(true);
    const parsed = readCuratorFindings(dir);
    expect(parsed).toEqual(result);
  });

  test("read returns null for missing file", () => {
    const parsed = readCuratorFindings("/nonexistent");
    expect(parsed).toBeNull();
  });

  test("read returns null for malformed JSON", () => {
    mkdirSync(join(dir, CTX_DIR, "curator"), { recursive: true });
    writeFileSync(join(dir, CTX_DIR, "curator", "findings.json"), "not-json");
    const parsed = readCuratorFindings(dir);
    expect(parsed).toBeNull();
  });
});

describe("handleCuratorSubcommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-cscan-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("scan: no issues when nothing wrong", () => {
    const { code, lines } = captureConsole(() => handleCuratorSubcommand(dir, ["scan"]));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No issues"))).toBe(true);
  });

  test("scan: writes findings file", () => {
    handleCuratorSubcommand(dir, ["scan"]);
    const path = join(dir, CTX_DIR, "curator", "findings.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CuratorScanResult;
    expect(parsed.findings).toEqual([]);
  });

  test("scan: rejects invalid scope before scanning", () => {
    const { code, lines } = captureConsole(() =>
      handleCuratorSubcommand(dir, ["scan", "--scope=nope"]),
    );
    expect(code).toBe(2);
    expect(lines.some((l) => l.includes("Usage"))).toBe(true);
  });

  test("repo scope rejects dirty state before scan or local write", () => {
    let scanned = false;
    let wrote = false;
    const { code } = captureConsole(() =>
      handleCuratorSubcommandWithDeps(dir, ["scan", "--scope=repo"], {
        resolveCommit: () => null,
        scan: () => {
          scanned = true;
          return { schemaVersion: 1, findings: [] };
        },
        writeFindings: () => {
          wrote = true;
        },
      }),
    );
    expect(code).toBe(2);
    expect(scanned).toBe(false);
    expect(wrote).toBe(false);
  });

  test("repo scope handles unavailable Git without scanning", () => {
    let scanned = false;
    const { code } = captureConsole(() =>
      handleCuratorSubcommandWithDeps("/definitely-not-a-repository", ["scan", "--scope=repo"], {
        scan: () => {
          scanned = true;
          return { schemaVersion: 1, findings: [] };
        },
      }),
    );
    expect(code).toBe(2);
    expect(scanned).toBe(false);
  });

  test("repo scope reports anchored scan, previews sync, and fails closed on sync error", () => {
    const commit = "a".repeat(40);
    const result = {
      schemaVersion: 1 as const,
      findings: [
        { id: "x", type: "stale-anchor" as const, skill: "alpha", detail: "private detail" },
      ],
    };
    const base = { resolveCommit: () => commit, scan: () => result, writeFindings: () => {} };

    expect(
      captureConsole(() => handleCuratorSubcommandWithDeps(dir, ["scan", "--scope=repo"], base))
        .code,
    ).toBe(1);
    const preview = captureConsole(() =>
      handleCuratorSubcommandWithDeps(dir, ["scan", "--scope=repo", "--sync"], base),
    );
    expect(preview.code).toBe(1);
    expect(preview.lines.join("\n")).toContain("Shared sync preview");
    expect(
      captureConsole(() =>
        handleCuratorSubcommandWithDeps(dir, ["scan", "--scope=repo", "--sync", "--yes"], {
          ...base,
          sync: () => ({ synced: false, duplicateFingerprints: new Set() }),
        }),
      ).code,
    ).toBe(2);
    const success = captureConsole(() =>
      handleCuratorSubcommandWithDeps(dir, ["scan", "--scope=repo", "--sync", "--yes"], {
        ...base,
        sync: () => ({ synced: true, duplicateFingerprints: new Set() }),
      }),
    );
    expect(success.code).toBe(1);
    expect(success.lines.join("\n")).toContain("1 new finding(s)");
  });

  test("unknown subcommand returns 2", () => {
    const { code, lines } = captureConsole(() => handleCuratorSubcommand(dir, ["unknown"]));
    expect(code).toBe(2);
    expect(lines.some((l) => l.includes("Usage"))).toBe(true);
  });

  test("scan: returns 1 when findings exist (real scan path)", () => {
    const lockDir = join(dir, CTX_DIR);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "main",
            url: "https://example.com/skills.git",
            ref: "main",
            commitOID: "abc",
            installed: [{ name: "unpinned-skill", version: "1.0", commitOID: "" }],
          },
        ],
      }),
    );
    const { code, lines } = captureConsole(() => handleCuratorSubcommand(dir, ["scan"]));
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("1 issue(s) found"))).toBe(true);
    expect(lines.some((l) => l.includes("unpinned-registry"))).toBe(true);
  });
});

describe("byte-identical idempotence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-cscan-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("handleCuratorSubcommand > issue dispatches to proposal handler", () => {
    writeCuratorFindings(dir, { schemaVersion: 1, findings: [] });
    const code = handleCuratorSubcommand(dir, ["issue"]);
    expect(code).toBe(0);
  });

  test("identical rerun produces byte-identical store", () => {
    const r1 = curatorScan(dir, {
      discoverSkills: () => [],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    writeCuratorFindings(dir, r1);
    const bytes1 = readFileSync(join(dir, CTX_DIR, "curator", "findings.json"));

    const r2 = curatorScan(dir, {
      discoverSkills: () => [],
      checkAnchors: () => ({ status: "fresh" }),
      auditSkillDuplicates: () => ({ errors: [], findings: [] }),
      parseRegistryLock: () => ({ schemaVersion: 1, registries: [] }),
    });
    writeCuratorFindings(dir, r2);
    const bytes2 = readFileSync(join(dir, CTX_DIR, "curator", "findings.json"));

    expect(bytes1.compare(bytes2)).toBe(0);
  });
});

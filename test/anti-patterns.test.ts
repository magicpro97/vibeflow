import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContext } from "../src/adapters/context-builders.js";
import { dispatchPrompt } from "../src/adapters/dispatch-prompt.js";
import {
  loadRelevantAntiPatterns,
  parseAntiPatterns,
  relevantAntiPatterns,
  renderAntiPatterns,
} from "../src/skills/anti-patterns.js";

const REGISTRY = `# Anti-pattern registry

## [AP-001] Shared fixture root survives parallel runs
Pattern: \\.e2e-workspace
Why: Concurrent browser runs can delete each other's fixtures.
Scope files: e2e/**, scripts/**
Detection: regex
Status: active
Guidance: Give every run a unique workspace and clean it after quiescence.

## [AP-002] Resolved example
Pattern: mock\\.module
Why: Historical test isolation problem.
Scope files: test/**
Detection: regex
Status: resolved
Guidance: Use an injected seam.
`;

describe("anti-pattern registry", () => {
  test("parses active entries and ignores resolved entries for relevance", () => {
    const patterns = parseAntiPatterns(REGISTRY);

    expect(patterns).toHaveLength(2);
    expect(relevantAntiPatterns(patterns, ["e2e/conversation-home.spec.ts"])).toEqual([
      expect.objectContaining({ id: "AP-001" }),
    ]);
    expect(relevantAntiPatterns(patterns, ["test/example.test.ts"])).toEqual([]);
  });

  test("matches nested paths for ** scopes", () => {
    const patterns = parseAntiPatterns(REGISTRY);
    expect(relevantAntiPatterns(patterns, ["e2e/sub/home.spec.ts"])).toEqual([
      expect.objectContaining({ id: "AP-001" }),
    ]);
  });

  test("matches nested middle segments for ** scopes", () => {
    const patterns = parseAntiPatterns(
      REGISTRY.replace("e2e/**, scripts/**", "test/**/source-contract*.test.ts"),
    );
    expect(relevantAntiPatterns(patterns, ["test/a/b/source-contract-x.test.ts"])).toEqual([
      expect.objectContaining({ id: "AP-001" }),
    ]);
  });
  test("keeps active pointer guidance scoped to skill sync", () => {
    const patterns = parseAntiPatterns(
      `${REGISTRY}\n## [AP-006] Pointer mirror\nPattern: Canonical skill lives at:\nWhy: pointer\nScope files: src/skills/**\nDetection: review\nStatus: active\nGuidance: parse pointer target.\n`,
    );
    expect(relevantAntiPatterns(patterns, ["src/skills/sync.ts"])).toEqual([
      expect.objectContaining({ id: "AP-006" }),
    ]);
  });

  test("renders bounded guidance with evidence and scope", () => {
    const rendered = renderAntiPatterns(parseAntiPatterns(REGISTRY));

    expect(rendered).toContain("Anti-pattern guardrails");
    expect(rendered).toContain("AP-001");
    expect(rendered).toContain("Give every run a unique workspace");
    expect(rendered).toContain("e2e/**, scripts/**");
    expect(rendered).not.toContain("AP-002");
  });

  test("loads only active patterns matching unit scope", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-anti-patterns-"));
    try {
      const path = join(base, ".vibeflow", "knowledge", "anti-patterns.md");
      mkdirSync(join(base, ".vibeflow", "knowledge"), { recursive: true });
      writeFileSync(path, REGISTRY);
      expect(loadRelevantAntiPatterns(base, ["e2e/home.spec.ts"])).toContain("AP-001");
      expect(loadRelevantAntiPatterns(base, ["src/server.ts"])).toBe("");
      expect(loadRelevantAntiPatterns(base, [])).toContain("AP-001");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("dispatch prompt carries scoped anti-pattern guidance", () => {
    const prompt = dispatchPrompt("claude", defaultContext(), ["ui"], {
      antiPatterns: "## Anti-pattern guardrails\n- AP-001: do not share fixture roots",
    });

    expect(prompt).toContain("Anti-pattern guardrails");
    expect(prompt).toContain("do not share fixture roots");
  });
});

describe("scan-anti-patterns.py", () => {
  test("matches nested paths in the Python scanner", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-anti-scan-nested-"));
    try {
      mkdirSync(join(base, ".vibeflow", "knowledge"), { recursive: true });
      mkdirSync(join(base, "scripts", "nested"), { recursive: true });
      const registry =
        "## [AP-003] broad staging\nPattern: ^\\s*git\\s+add\\s+-A\\s*$\nWhy: test\nScope files: scripts/**\nDetection: regex\nStatus: active\nGuidance: test\n";
      writeFileSync(join(base, ".vibeflow", "knowledge", "anti-patterns.md"), registry);
      writeFileSync(join(base, "scripts", "nested", "bad.py"), "git add -A\n");
      const script = join(process.cwd(), "scripts", "scan-anti-patterns.py");
      const result = spawnSync("python3", [script, "--root", base, "--json"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("scripts/nested/bad.py");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("scans nested .vibeflow files without inspecting generated mirrors", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-anti-scan-vibeflow-"));
    try {
      mkdirSync(join(base, ".vibeflow", "skills", "nested"), { recursive: true });
      mkdirSync(join(base, ".vibeflow", "knowledge"), { recursive: true });
      const body =
        "## [AP-004] verified declaration\nPattern: ^\\s*status: verified\\s*$\nWhy: test\nScope files: .vibeflow/skills/**\nDetection: regex\nStatus: active\nGuidance: test\n";
      writeFileSync(join(base, ".vibeflow", "knowledge", "anti-patterns.md"), body);
      writeFileSync(join(base, ".vibeflow", "skills", "nested", "SKILL.md"), "status: verified\n");
      const script = join(process.cwd(), "scripts", "scan-anti-patterns.py");
      const result = spawnSync("python3", [script, "--root", base, "--json"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(".vibeflow/skills/nested/SKILL.md");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("reports active regex hits and fails only when requested", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-anti-scan-"));
    try {
      mkdirSync(join(base, ".vibeflow", "knowledge"), { recursive: true });
      mkdirSync(join(base, "e2e"), { recursive: true });
      writeFileSync(join(base, ".vibeflow", "knowledge", "anti-patterns.md"), REGISTRY);
      writeFileSync(join(base, "e2e", "bad.ts"), "const root = '.e2e-workspace';\n");

      const script = join(process.cwd(), "scripts", "scan-anti-patterns.py");
      const result = spawnSync("python3", [script, "--root", base, "--fail-on-active", "--json"], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("AP-001");
      expect(result.stdout).toContain("e2e/bad.ts");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

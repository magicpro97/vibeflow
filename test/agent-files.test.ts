import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFiles } from "../src/adapters/agent-files.js";
import { detectRolesForRepo } from "../src/agents/detect-roles.js";
import type { RoleName } from "../src/agents/role-templates.js";

describe("agentFiles integration", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vf-agent-files-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    writeFileSync(join(repo, "src", "cli.ts"), "// cli entry");
    writeFileSync(join(repo, "src", "server.ts"), "// web server");
    writeFileSync(join(repo, "README.md"), "# test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("detectRolesForRepo returns cli-engine, web-ui, doc-writer for a typical project", () => {
    const roles = detectRolesForRepo(repo);
    expect(roles).toContain("cli-engine");
    expect(roles).toContain("web-ui");
    expect(roles).toContain("doc-writer");
  });

  test("agentFiles emits 3 files per role (claude/codex/copilot)", () => {
    const profile = {
      name: "x",
      summary: "test",
      languages: ["TypeScript"],
      frameworks: [],
      buildCommand: "bun run build",
      testCommand: "bun test",
      lintCommand: "bun run lint",
      packageManager: "bun",
      hasCI: false,
      manifests: [],
      findings: [
        {
          component: "language",
          value: "TypeScript",
          evidence: ["package.json"],
          confidence: "high" as const,
        },
        {
          component: "runtime",
          value: "Bun",
          evidence: ["bun.lockb"],
          confidence: "high" as const,
        },
      ],
    };
    const roles: RoleName[] = ["cli-engine", "web-ui", "doc-writer"];
    const files = agentFiles(profile, roles, false);
    for (const role of roles) {
      expect(files[`.claude/agents/${role}.md`]).toBeDefined();
      expect(files[`.codex/agents/${role}.toml`]).toBeDefined();
      expect(files[`.github/agents/${role}.md`]).toBeDefined();
    }
  });

  test("Claude agent file is valid YAML frontmatter", () => {
    const profile = {
      name: "x",
      summary: "test",
      languages: ["TypeScript"],
      frameworks: [],
      buildCommand: "x",
      testCommand: "x",
      lintCommand: "x",
      packageManager: "bun",
      hasCI: false,
      manifests: [],
      findings: [],
    };
    const out = agentFiles(profile, ["doc-writer"], false)[".claude/agents/doc-writer.md"];
    expect(out).toBeDefined();
    // Valid frontmatter must have exactly 2 `---` fences at line start.
    const fences = [...(out ?? "").matchAll(/^---$/gm)];
    expect(fences.length).toBe(2);
  });

  test("Codex agent file has developer_instructions triple-string body", () => {
    const profile = {
      name: "x",
      summary: "test",
      languages: ["TypeScript"],
      frameworks: [],
      buildCommand: "x",
      testCommand: "x",
      lintCommand: "x",
      packageManager: "bun",
      hasCI: false,
      manifests: [],
      findings: [],
    };
    const out = agentFiles(profile, ["doc-writer"], false)[".codex/agents/doc-writer.toml"];
    if (!out) throw new Error("missing toml output");
    // Opening fence at line start. The TOML parser auto-trims the
    // newline after the opener (per spec), so the body is preserved exactly.
    expect(out).toMatch(/^developer_instructions = """$/m);
    // Closing fence appears on its own line.
    // Closing fence appears on its own line in the new convention.
    expect(out).toMatch(/^"""$/m);
    // Body content is between the fences.
    const openerIdx = out.indexOf('developer_instructions = """');
    const closerIdx = out.indexOf('"""\nmodel = ');
    const body = out.slice(openerIdx, closerIdx);
    // Body contains the role name + role-specific content.
    expect(body).toContain("# doc-writer");
    expect(body.toLowerCase()).toContain("documentation");
  });
});

describe("agentFiles AI enrichment", () => {
  const profile = {
    name: "x",
    summary: "test",
    languages: ["TypeScript"],
    frameworks: [],
    buildCommand: "x",
    testCommand: "x",
    lintCommand: "x",
    packageManager: "bun",
    hasCI: false,
    manifests: [],
    findings: [],
  };

  test("useAi=false skips the spawnSync call entirely", () => {
    // ensure no VIBEFLOW_AI is set
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "echo BODY-MARKER-SHOULD-NOT-APPEAR";
    try {
      const files = agentFiles(profile, ["doc-writer"], false);
      const out = files[".claude/agents/doc-writer.md"];
      expect(out).toBeDefined();
      // The hard-coded template is used; AI echo body is NOT injected.
      expect(out).not.toContain("BODY-MARKER-SHOULD-NOT-APPEAR");
    } finally {
      if (orig === undefined) process.env.VIBEFLOW_AI = "";
      else process.env.VIBEFLOW_AI = orig;
    }
  });

  test("useAi=true (default) honours VIBEFLOW_AI to enrich body", () => {
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "echo AI-ENRICHED-BODY-CONTENT";
    try {
      const files = agentFiles(profile, ["doc-writer"], true);
      const out = files[".claude/agents/doc-writer.md"];
      expect(out).toBeDefined();
      expect(out).toContain("AI-ENRICHED-BODY-CONTENT");
    } finally {
      if (orig === undefined) process.env.VIBEFLOW_AI = "";
      else process.env.VIBEFLOW_AI = orig;
    }
  });

  test("useAi=true with VIBEFLOW_AI unset falls back to hard-coded template", () => {
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "";
    try {
      const files = agentFiles(profile, ["doc-writer"], true);
      const out = files[".claude/agents/doc-writer.md"];
      expect(out).toBeDefined();
      // Should be the template body, not an empty body.
      expect(out).toContain("# doc-writer");
    } finally {
      if (orig !== undefined) process.env.VIBEFLOW_AI = orig;
    }
  });
});

describe("detectRolesForRepo: doc-writer safety-net (line 67)", () => {
  test("a project with README.md but no other role signals still gets doc-writer", () => {
    // An empty project (no src/server.ts, no .claude, no ci dir) but
    // WITH a README.md triggers the doc-writer safety-net branch (line 67).
    const dir = mkdtempSync(join(tmpdir(), "vf-roles-doc-"));
    try {
      writeFileSync(join(dir, "README.md"), "# My Project");
      const roles = detectRolesForRepo(dir);
      expect(roles).toContain("doc-writer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

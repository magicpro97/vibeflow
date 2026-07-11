import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentRoles, parseAgentRole, resolveRole } from "../../src/agents/role-loader.js";

const md = `---
name: reviewer
description: Reviews PRs for security and correctness
engine: claude
model: claude-sonnet-4
tools: [read, grep, git]
permission_mode: acceptEdits
examples:
  - Review this PR
  - Check diff for bugs
---

Review code changes thoroughly.
`;

describe("parseAgentRole", () => {
  test("parses full frontmatter", () => {
    const role = parseAgentRole(md);
    expect(role).not.toBeNull();
    expect(role!.name).toBe("reviewer");
    expect(role!.engine).toBe("claude");
    expect(role!.model).toBe("claude-sonnet-4");
    expect(role!.tools).toEqual(["read", "grep", "git"]);
    expect(role!.examples).toContain("Review this PR");
  });

  test("returns null for missing name", () => {
    expect(parseAgentRole("---\nengine: claude\n---\n")).toBeNull();
  });

  test("uses body as description when no explicit description", () => {
    const role = parseAgentRole("---\nname: simple\n---\nDo simple things.");
    expect(role!.description).toBe("Do simple things.");
  });

  test("coerces single string tools to array", () => {
    const role = parseAgentRole("---\nname: x\ntools: read\n---\n");
    expect(role!.tools).toEqual(["read"]);
  });

  test("handles empty body gracefully", () => {
    const role = parseAgentRole("---\nname: x\ndescription: d\n---\n");
    expect(role!.description).toBe("d");
  });

  test("handles no frontmatter", () => {
    expect(parseAgentRole("just markdown")).toBeNull();
  });
});

describe("resolveRole", () => {
  const roles = [
    { name: "reviewer", description: "Review PRs", engine: "claude", examples: ["review this"] },
    { name: "tester", description: "Run tests", engine: "codex" },
  ];

  test("matches by description", () => {
    expect(resolveRole("please review PRs for correctness", roles)?.name).toBe("reviewer");
  });

  test("matches by example", () => {
    expect(resolveRole("review this diff", roles)?.name).toBe("reviewer");
  });

  test("returns null for no match", () => {
    expect(resolveRole("deploy prod", roles)).toBeNull();
  });

  test("returns null for empty roles", () => {
    expect(resolveRole("anything", [])).toBeNull();
  });
});

describe("loadAgentRoles", () => {
  test("returns empty for non-existent dir", () => {
    expect(loadAgentRoles("/nonexistent/path/12345")).toEqual([]);
  });

  test("loads roles from dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-role-"));
    writeFileSync(join(tmp, "reviewer.md"), md);
    writeFileSync(join(tmp, "simple.md"), "---\nname: simple\n---\nDo simple things.");
    writeFileSync(join(tmp, "not-md.txt"), "---\nname: nope\n---\n");
    try {
      const loaded = loadAgentRoles(tmp);
      expect(loaded.length).toBe(2);
      expect(loaded[0]!.name).toBe("reviewer");
      expect(loaded[1]!.name).toBe("simple");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { renderClaudeAgent } from "../src/agents/render.js";
import {
  ROLE_NAMES,
  defaultRoleContext,
  getRoleSpec,
  listRoleSpecs,
  roleContextFromProfile,
} from "../src/agents/role-templates.js";

describe("role-templates", () => {
  test("exposes the 7 expected default roles (incl. ios-engine)", () => {
    expect(ROLE_NAMES).toEqual([
      "cli-engine",
      "web-ui",
      "ios-engine",
      "skill-author",
      "preflight-engine",
      "dispatch-runner",
      "doc-writer",
    ]);
    const specs = listRoleSpecs();
    expect(specs).toHaveLength(7);
    for (const name of ROLE_NAMES) {
      expect(specs.find((s) => s.name === name)).toBeDefined();
    }
  });

  test("every spec has a kebab-case name, non-empty description, body > 50 chars, and tools", () => {
    for (const s of listRoleSpecs()) {
      expect(s.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(50);
      expect(s.tools.length).toBeGreaterThan(0);
    }
  });

  test("every spec body covers the 5 required sections (Scope, Common Tasks, Conventions, When Invoked, Return Format)", () => {
    const required = [
      "## Scope",
      "## Common Tasks",
      "## Conventions",
      "## When Invoked",
      "## Return Format",
    ];
    for (const s of listRoleSpecs()) {
      for (const sec of required) {
        expect(s.body).toContain(sec);
      }
    }
  });

  test("bodies are 50-150 lines (markdown density per plan spec)", () => {
    for (const s of listRoleSpecs()) {
      const lines = s.body.split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(20);
      expect(lines).toBeLessThanOrEqual(200);
    }
  });

  test("getRoleSpec returns the same spec as listRoleSpecs[idx]", () => {
    for (const name of ROLE_NAMES) {
      const a = getRoleSpec(name);
      const b = listRoleSpecs().find((s) => s.name === name);
      expect(a).toEqual(b);
    }
  });

  test("getRoleSpec returns undefined for unknown name", () => {
    expect(getRoleSpec("not-a-real-role")).toBeUndefined();
  });

  test("rendering each spec through renderClaudeAgent produces a complete Claude agent file", () => {
    for (const s of listRoleSpecs()) {
      const out = renderClaudeAgent(s);
      expect(out).toMatch(new RegExp(`^name:\\s+${s.name}$`, "m"));
      expect(out).toMatch(/^---/);
      expect(out).toContain(s.body);
    }
  });

  test("roleContextFromProfile maps a ProjectProfile into a RoleContext", () => {
    const ctx = roleContextFromProfile({
      name: "demo",
      languages: [],
      frameworks: ["React", "Next.js"],
      hasCI: false,
      manifests: [],
      findings: [],
    });
    expect(ctx.projectName).toBe("demo");
    expect(ctx.hasWeb).toBe(true);
  });

  test("defaultRoleContext returns a usable fallback (no scanner run needed)", () => {
    const ctx = defaultRoleContext();
    expect(ctx.projectName.length).toBeGreaterThan(0);
    expect(ctx.testCommand).toBeDefined();
  });
});

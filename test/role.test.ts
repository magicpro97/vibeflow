import { describe, expect, test } from "bun:test";
import type { RoleSpec } from "../src/agents/role.js";

const SPEC: RoleSpec = {
  name: "cli-engine",
  description: "CLI specialist. Use proactively for any CLI flag or subcommand work.",
  body: "# CLI Engine\n\nYou own the command-line surface of the project. You handle flag parsing,\nsubcommand dispatch, and adapter wiring. You never modify engine binaries.",
  tools: ["read", "write", "edit", "bash", "grep", "glob"],
  model: "sonnet",
  sandbox: "workspace-write",
};

describe("RoleSpec", () => {
  test("cli-engine fixture has kebab-case name, non-empty description, and body > 50 chars", () => {
    expect(SPEC.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(SPEC.description.length).toBeGreaterThan(0);
    expect(SPEC.body.length).toBeGreaterThan(50);
    expect(SPEC.tools.length).toBeGreaterThan(0);
  });

  // src/agents/role.ts has only type exports (RoleSpec interface, ToolIntent,
  // RoleModel, RoleSandbox) — no executable code. The "real" role fixture
  // constants (cliEngineSpec, webUiSpec, etc.) live in src/agents/role-templates.ts
  // and are tested in test/role-templates.test.ts. There's nothing executable to
  // hit in role.ts, so 0% branch/line coverage is the correct measurement.
  test("RoleSpec interface is assignable to a const with the documented shape", () => {
    const s: RoleSpec = {
      name: "a-b-c",
      description: "d",
      body: "e".repeat(60),
      tools: ["read", "write"],
      model: "sonnet",
      sandbox: "read-only",
    };
    expect(s.name).toBe("a-b-c");
    expect(s.sandbox).toBe("read-only");
  });
});

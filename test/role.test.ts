import { describe, expect, test } from "bun:test";
import { type ResolvedRole, type RoleSpec, isReadOnlyRole } from "../src/agents/role.js";

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

  test("read-only authority requires both sandbox and non-mutating tool intents", () => {
    const resolved: ResolvedRole = {
      spec: { ...SPEC, tools: ["read", "grep"], sandbox: "read-only" },
      source: "builtin",
      resolved_hash: "a".repeat(64),
      metadata: {},
    };
    expect(isReadOnlyRole(resolved.spec)).toBe(true);
    expect(isReadOnlyRole({ ...resolved.spec, tools: ["read", "bash"] })).toBe(false);
    expect(isReadOnlyRole({ ...resolved.spec, sandbox: "workspace-write" })).toBe(false);
  });
});

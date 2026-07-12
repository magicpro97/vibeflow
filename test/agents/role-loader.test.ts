import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleModel, RoleSandbox, RoleSpec } from "../../src/agents/role";
import {
  loadAgentRoles,
  parseAgentRole,
  resolveRole,
  toRoleSpec,
} from "../../src/agents/role-loader";

function validData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-agent",
    description: "test description",
    body: "some body text",
    tools: ["read", "write"],
    model: "sonnet",
    ...overrides,
  };
}

function roleFile(name = "test-agent", model = "sonnet"): string {
  return `---\nname: ${name}\ndescription: test description\ntools:\n  - read\n  - write\nmodel: ${model}\n---\nbody content\n`;
}

function expectSpec(r: ReturnType<typeof toRoleSpec>): RoleSpec {
  expect(r).not.toBeNull();
  return r as RoleSpec;
}

describe("toRoleSpec", () => {
  test("valid data returns spec", () => {
    const r = expectSpec(toRoleSpec(validData()));
    expect(r.name).toBe("test-agent");
  });

  test("name not-string => null", () => expect(toRoleSpec(validData({ name: 123 }))).toBeNull());
  test("name empty => null", () => expect(toRoleSpec(validData({ name: "" }))).toBeNull());
  test("description not-string => null", () =>
    expect(toRoleSpec(validData({ description: 123 }))).toBeNull());
  test("description empty => null", () =>
    expect(toRoleSpec(validData({ description: "" }))).toBeNull());

  test("body non-string and defined => null", () => {
    expect(toRoleSpec(validData({ body: 123 }))).toBeNull();
  });

  test("body undefined passes through (defaults to '')", () => {
    const { body: _b, ...rest } = validData();
    const r = expectSpec(toRoleSpec(rest));
    expect(r.body).toBe("");
  });

  test("body valid string passes through", () => {
    const r = expectSpec(toRoleSpec(validData({ body: "custom body" })));
    expect(r.body).toBe("custom body");
  });

  test("tools not-array => null", () => {
    expect(toRoleSpec(validData({ tools: "read" }))).toBeNull();
  });

  test("tools array all-invalid => null", () => {
    expect(toRoleSpec(validData({ tools: ["invalid1", "invalid2"] }))).toBeNull();
  });

  test("tools mix valid+invalid => keeps only valid", () => {
    const r = expectSpec(toRoleSpec(validData({ tools: ["read", "invalid", "bash", "bogus"] })));
    expect(r.tools).toEqual(["read", "bash"]);
  });

  test("model not-string => null", () => expect(toRoleSpec(validData({ model: 123 }))).toBeNull());
  test("model invalid string => null", () =>
    expect(toRoleSpec(validData({ model: "unknown-model" }))).toBeNull());

  const VALID_MODELS = [
    "haiku",
    "sonnet",
    "opus",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "gpt-5.4-codex",
  ] as const;
  for (const m of VALID_MODELS) {
    test(`model "${m}" accepted`, () => {
      const r = expectSpec(toRoleSpec(validData({ model: m })));
      expect(r.model).toBe(m);
    });
  }

  test('sandbox "read-only" kept', () => {
    const r = expectSpec(toRoleSpec(validData({ sandbox: "read-only" })));
    expect(r.sandbox).toBe("read-only");
  });

  test('sandbox "workspace-write" kept', () => {
    const r = expectSpec(toRoleSpec(validData({ sandbox: "workspace-write" })));
    expect(r.sandbox).toBe("workspace-write");
  });

  test('sandbox "danger-full-access" kept', () => {
    const r = expectSpec(toRoleSpec(validData({ sandbox: "danger-full-access" })));
    expect(r.sandbox).toBe("danger-full-access");
  });

  test('sandbox "danger" (non-whitelisted) => undefined', () => {
    const r = expectSpec(toRoleSpec(validData({ sandbox: "danger" })));
    expect(r.sandbox).toBeUndefined();
  });

  test("sandbox non-whitelisted string => undefined", () => {
    const r = expectSpec(toRoleSpec(validData({ sandbox: "something-else" })));
    expect(r.sandbox).toBeUndefined();
  });

  test("sandbox absent => undefined", () => {
    const { sandbox: _s, ...rest } = validData();
    const r = expectSpec(toRoleSpec(rest));
    expect(r.sandbox).toBeUndefined();
  });
});

describe("parseAgentRole", () => {
  test("valid role returns role and empty errors", () => {
    const p = parseAgentRole(roleFile());
    expect(p.role).not.toBeNull();
    expect(p.errors).toEqual([]);
  });

  test("missing name => role null, errors", () => {
    const p = parseAgentRole(
      "---\ndescription: test\ntools:\n  - read\nmodel: sonnet\n---\nbody\n",
    );
    expect(p.role).toBeNull();
    expect(p.errors).toEqual(["missing 'name' in frontmatter"]);
  });

  test("missing description => role null, errors", () => {
    const p = parseAgentRole("---\nname: test-agent\ntools:\n  - read\nmodel: sonnet\n---\nbody\n");
    expect(p.role).toBeNull();
    expect(p.errors).toEqual(["missing 'description' in frontmatter"]);
  });

  test("valid frontmatter but toRoleSpec rejects (invalid model) => errors", () => {
    const p = parseAgentRole(
      "---\nname: test-agent\ndescription: test\ntools:\n  - read\nmodel: invalid-model\n---\nbody\n",
    );
    expect(p.role).toBeNull();
    expect(p.errors).toEqual([
      "invalid role: missing tools, invalid model, or other required fields",
    ]);
  });
});

describe("resolveRole", () => {
  let dir: string;
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  test("rolesDir undefined => null", () => {
    expect(resolveRole("test-agent", undefined)).toBeNull();
  });

  test("rolesDir not-exist => null", () => {
    expect(resolveRole("test-agent", "/no/such/path")).toBeNull();
  });

  test("dir with matching role file returns it", () => {
    dir = mkdtempSync(join(tmpdir(), "rl-resolve-"));
    writeFileSync(join(dir, "test-agent.md"), roleFile("test-agent"));
    const r = resolveRole("test-agent", dir);
    expect(r).not.toBeNull();
    expect((r as RoleSpec).name).toBe("test-agent");
  });

  test("dir with no match returns null", () => {
    const d = mkdtempSync(join(tmpdir(), "rl-nomatch-"));
    writeFileSync(join(d, "other-agent.md"), roleFile("other-agent"));
    expect(resolveRole("test-agent", d)).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });

  test("readdir/readFile throws caught => null", () => {
    expect(resolveRole("test-agent", "/dev/fd/0")).toBeNull();
  });
});

describe("loadAgentRoles", () => {
  test("dir not-exist => []", () => {
    expect(loadAgentRoles("/no/such/path")).toEqual([]);
  });

  test("readdir throws (file instead of dir) => []", () => {
    const f = mkdtempSync(join(tmpdir(), "rl-notdir-"));
    const fp = join(f, "roles.txt");
    writeFileSync(fp, "not a dir");
    expect(loadAgentRoles(fp)).toEqual([]);
    rmSync(f, { recursive: true, force: true });
  });

  test("dir with mix of valid + invalid .md => returns only valid", () => {
    const d = mkdtempSync(join(tmpdir(), "rl-mix-"));
    writeFileSync(join(d, "valid.md"), roleFile("valid-agent"));
    writeFileSync(join(d, "invalid.md"), roleFile("", "invalid-model"));
    writeFileSync(join(d, "notes.txt"), "not a role file");
    const roles = loadAgentRoles(d);
    expect(roles.length).toBe(1);
    expect(roles[0]?.name).toBe("valid-agent");
    rmSync(d, { recursive: true, force: true });
  });

  test("readFileSync throws on unreadable file => skipped", () => {
    const d = mkdtempSync(join(tmpdir(), "rl-unreadable-"));
    writeFileSync(join(d, "good.md"), roleFile("good"));
    mkdirSync(join(d, "bad.md"));
    const roles = loadAgentRoles(d);
    expect(roles.length).toBe(1);
    expect(roles[0]?.name).toBe("good");
    rmSync(d, { recursive: true, force: true });
  });
});

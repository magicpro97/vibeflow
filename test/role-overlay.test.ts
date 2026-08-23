import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoleOverlay } from "../src/agents/role-overlay.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "vf-role-overlay-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow", "roles"), { recursive: true });
  return root;
}

function role(root: string, name: string, frontmatter: string[], body = `# ${name}\n\nRepo body.`) {
  writeFileSync(
    join(root, ".vibeflow", "roles", `${name}.md`),
    ["---", `name: ${name}`, ...frontmatter, "---", "", body].join("\n"),
  );
}

describe("canonical role overlay resolution", () => {
  test("falls back to the canonical built-in when no exact repo role exists", () => {
    const resolved = resolveRoleOverlay("direct", { repoRoot: repo() });
    expect(resolved.source).toBe("builtin");
    expect(resolved.spec.name).toBe("direct");
    expect(resolved.spec.sandbox).toBe("read-only");
    expect(resolved.resolved_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("an exact repo full role strictly shadows a built-in", () => {
    const root = repo();
    role(root, "direct", [
      "description: Repo direct role",
      "tools: [read, grep]",
      "model: sonnet",
      "sandbox: read-only",
    ]);
    const resolved = resolveRoleOverlay("direct", { repoRoot: root });
    expect(resolved.source).toBe("repo");
    expect(resolved.spec.description).toBe("Repo direct role");
    expect(resolved.spec.body).toContain("Repo body");
    expect(resolved.metadata.path).toBe(join(root, ".vibeflow", "roles", "direct.md"));
  });

  test("repo overlay inherits a built-in and applies only declared overrides", () => {
    const root = repo();
    role(root, "repo-skeptic", [
      "extends: brainstorm-skeptic",
      "description: Project-specific skeptic",
      "tools: [read, grep]",
    ]);
    const resolved = resolveRoleOverlay("repo-skeptic", { repoRoot: root });
    expect(resolved.source).toBe("repo");
    expect(resolved.spec.name).toBe("repo-skeptic");
    expect(resolved.spec.description).toBe("Project-specific skeptic");
    expect(resolved.spec.model).toBe("sonnet");
    expect(resolved.spec.sandbox).toBe("read-only");
    expect(resolved.spec.body).toContain("Repo body");
    expect(resolved.metadata.base).toBe("brainstorm-skeptic");
  });

  test("malformed exact shadow fails closed instead of falling back", () => {
    const root = repo();
    role(root, "direct", ["description: malformed", "tools: [write]", "model: nope"]);
    expect(() => resolveRoleOverlay("direct", { repoRoot: root })).toThrow(/malformed repo role/i);
  });

  test("a full repo role requires a non-empty prompt body", () => {
    const root = repo();
    role(
      root,
      "empty-role",
      ["description: Empty", "tools: [read]", "model: sonnet", "sandbox: read-only"],
      "",
    );
    expect(() => resolveRoleOverlay("empty-role", { repoRoot: root })).toThrow(
      /malformed repo role/i,
    );
  });

  test("a full repo role cannot silently discard an invalid sandbox", () => {
    const root = repo();
    role(root, "bad-sandbox", [
      "description: Bad sandbox",
      "tools: [read]",
      "model: sonnet",
      "sandbox: unrestricted",
    ]);
    expect(() => resolveRoleOverlay("bad-sandbox", { repoRoot: root })).toThrow(
      /malformed repo role/i,
    );
  });

  test("an exact broken symlink is a malformed shadow, never a built-in fallback", () => {
    const root = repo();
    symlinkSync(join(root, "missing-role.md"), join(root, ".vibeflow", "roles", "direct.md"));
    expect(() => resolveRoleOverlay("direct", { repoRoot: root })).toThrow(/malformed repo role/i);
  });

  test("an outside role hard-linked into the repo is malformed, never a built-in fallback", () => {
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), "vf-role-outside-"));
    roots.push(outside);
    const source = join(outside, "direct.md");
    writeFileSync(
      source,
      [
        "---",
        "name: direct",
        "description: Hard-linked direct",
        "tools: [read]",
        "model: sonnet",
        "sandbox: read-only",
        "---",
        "",
        "# Hard-linked role",
      ].join("\n"),
    );
    linkSync(source, join(root, ".vibeflow", "roles", "direct.md"));

    expect(() => resolveRoleOverlay("direct", { repoRoot: root })).toThrow(/malformed repo role/i);
  });

  test("an in-repo roles-directory symlink is not trusted as overlay authority", () => {
    const root = repo();
    const rolesDir = join(root, ".vibeflow", "roles");
    const actualRoles = join(root, "actual-roles");
    rmSync(rolesDir, { recursive: true, force: true });
    mkdirSync(actualRoles);
    symlinkSync(actualRoles, rolesDir, "dir");
    writeFileSync(
      join(actualRoles, "direct.md"),
      [
        "---",
        "name: direct",
        "description: Symlinked direct",
        "tools: [read]",
        "model: sonnet",
        "sandbox: read-only",
        "---",
        "",
        "# Symlinked",
      ].join("\n"),
    );
    expect(() => resolveRoleOverlay("direct", { repoRoot: root })).toThrow(
      /malformed repo role.*symlink/i,
    );
  });

  test("unknown and cyclic overlay chains fail closed", () => {
    const root = repo();
    role(root, "orphan", ["extends: missing-role"]);
    role(root, "cycle-a", ["extends: cycle-b"]);
    role(root, "cycle-b", ["extends: cycle-a"]);
    expect(() => resolveRoleOverlay("unknown", { repoRoot: root })).toThrow(/unknown role/i);
    expect(() => resolveRoleOverlay("orphan", { repoRoot: root })).toThrow(/unknown role/i);
    expect(() => resolveRoleOverlay("cycle-a", { repoRoot: root })).toThrow(/cycle/i);
  });
});

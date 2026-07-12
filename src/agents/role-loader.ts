// src/agents/role-loader.ts
//
// Role file parser + resolver (#550). Reads agent role YAML/MD files from
// .vibeflow/roles/*.md and .claude/agents/*.md, parses their frontmatter
// via the existing parseFrontmatter, validates, and returns typed RoleSpec[].
//
// parseAgentRole — parse a single role file text → RoleSpec | null (invalid returns null)
// resolveRole — resolve a role name from the repo's registered roles + built-in defaults
// loadAgentRoles — recursively load all role files from a directory, return RoleSpec[]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import type { RoleSpec } from "./role.js";

/** Re-export parseFrontmatter so role-loader consumers don't need a separate import. */
export { parseFrontmatter } from "../frontmatter.js";

export interface ParsedAgentRole {
  role: RoleSpec | null;
  errors: string[];
}

/** Validate a frontmatter data block as a RoleSpec. Returns null on invalid.
 *  Exported as a test seam: `parseAgentRole` always passes a string `body`, so
 *  the non-string-body branch is only reachable via a direct call. */
export function toRoleSpec(data: Record<string, unknown>): RoleSpec | null {
  const name = data.name;
  const description = data.description;
  const body = data.body;
  const tools = data.tools;
  const model = data.model;

  if (typeof name !== "string" || !name) return null;
  if (typeof description !== "string" || !description) return null;
  if (typeof body !== "string" && typeof data.body !== "undefined") return null;

  const roleTools: Array<"read" | "write" | "edit" | "bash" | "grep" | "glob" | "web"> = [];
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (
        typeof t === "string" &&
        ["read", "write", "edit", "bash", "grep", "glob", "web"].includes(t)
      ) {
        roleTools.push(t as "read" | "write" | "edit" | "bash" | "grep" | "glob" | "web");
      }
    }
  }
  if (roleTools.length === 0) return null;

  const validModels = [
    "haiku",
    "sonnet",
    "opus",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "gpt-5.4-codex",
  ];
  if (typeof model !== "string" || !validModels.includes(model)) return null;

  return {
    name,
    description,
    body: typeof body === "string" ? body : "",
    tools: roleTools,
    model: model as RoleSpec["model"],
    sandbox:
      data.sandbox === "read-only" ||
      data.sandbox === "workspace-write" ||
      data.sandbox === "danger-full-access"
        ? (data.sandbox as RoleSpec["sandbox"])
        : undefined,
  };
}

/**
 * Parse a single role file's text content into a ParsedAgentRole.
 * Invalid roles return { role: null, errors: [...] } — callers decide whether to skip or warn.
 */
export function parseAgentRole(text: string): ParsedAgentRole {
  const errors: string[] = [];
  const { data, body } = parseFrontmatter(text);

  if (!data.name) {
    errors.push("missing 'name' in frontmatter");
    return { role: null, errors };
  }
  if (!data.description) {
    errors.push("missing 'description' in frontmatter");
    return { role: null, errors };
  }

  // Merge body into data so toRoleSpec can validate uniformly
  const merged = { ...data, body };
  const role = toRoleSpec(merged);
  if (!role) {
    errors.push("invalid role: missing tools, invalid model, or other required fields");
    return { role: null, errors };
  }
  return { role, errors };
}

/**
 * Resolve a role by name from the repo's registered roles.
 * Falls back to null when no match found.
 * @param name Role name to resolve
 * @param rolesDir Directory containing role .md files (e.g. .vibeflow/roles/)
 */
export function resolveRole(name: string, rolesDir?: string): RoleSpec | null {
  if (!rolesDir || !existsSync(rolesDir)) return null;

  try {
    const files = readdirSync(rolesDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const text = readFileSync(join(rolesDir, file), "utf8");
      const parsed = parseAgentRole(text);
      if (parsed.role && parsed.role.name === name) return parsed.role;
    }
  } catch {
    /* directory read failure → no roles */
  }
  return null;
}

/**
 * Load all valid agent roles from a directory of .md files.
 * Invalid files are silently skipped; the caller can iterate errors via parseAgentRole directly.
 */
export function loadAgentRoles(dir: string): RoleSpec[] {
  const roles: RoleSpec[] = [];
  if (!existsSync(dir)) return roles;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return roles;
  }

  for (const file of files) {
    try {
      const text = readFileSync(join(dir, file), "utf8");
      const parsed = parseAgentRole(text);
      if (parsed.role) roles.push(parsed.role);
    } catch {
      /* skip unreadable files */
    }
  }
  return roles;
}

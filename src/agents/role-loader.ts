import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";

export interface AgentRole {
  name: string;
  description?: string;
  engine?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  permission_mode?: string;
  examples?: string[];
}

function coerceArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return undefined;
}

export function parseAgentRole(markdown: string): AgentRole | null {
  const fm = parseFrontmatter(markdown);
  const data = fm.data;
  if (!data.name) return null;
  return {
    name: String(data.name),
    description:
      typeof data.description === "string" ? data.description : fm.body.trim() || undefined,
    engine: typeof data.engine === "string" ? data.engine : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    tools: coerceArray(data.tools),
    skills: coerceArray(data.skills),
    permission_mode: typeof data.permission_mode === "string" ? data.permission_mode : undefined,
    examples: coerceArray(data.examples),
  };
}

// ponytail: match unit text against role descriptions + examples.
// No fuzzy/semantic matching — exact substring. Add NLP when users hit false negatives.
export function resolveRole(unitText: string, roles: AgentRole[]): AgentRole | null {
  const lower = unitText.toLowerCase();
  for (const role of roles) {
    if (role.description && lower.includes(role.description.toLowerCase())) return role;
    if (role.examples) {
      for (const ex of role.examples) {
        if (lower.includes(ex.toLowerCase())) return role;
      }
    }
  }
  return null;
}

export function loadAgentRoles(dir: string): AgentRole[] {
  if (!existsSync(dir)) return [];
  const roles: AgentRole[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    try {
      const md = readFileSync(join(dir, entry), "utf8");
      const role = parseAgentRole(md);
      if (role) roles.push(role);
    } catch {
      /* skip unreadable files */
    }
  }
  return roles;
}

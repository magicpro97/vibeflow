// #660: lifecycle parse helpers + renderSkillDetail
import type { Skill } from "../core.js";
import { c } from "../core.js";
import { SKILL_STATUS } from "../core/skill-contract.js";
import { out } from "../logbus.js";

export function parseLifecycleOwners(data: Record<string, unknown>): string[] | undefined {
  const raw = data.owners;
  const parsed = Array.isArray(raw)
    ? raw
        .map(String)
        .filter((s: string) => s.trim())
        .filter((o: string) => /^[\w.@+-]+$/.test(o))
    : undefined;
  return parsed?.length ? parsed : undefined;
}

export function parseLifecycleChangelog(data: Record<string, unknown>): string[] | undefined {
  const raw = data.changelog;
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .filter((x: unknown): x is string => typeof x === "string" && !!x.trim())
    .map((x: string) => x.trim());
  return parsed.length ? parsed : undefined;
}

export function parseLifecycleSupersedes(data: Record<string, unknown>): string | undefined {
  const raw = typeof data.supersedes === "string" ? data.supersedes.trim() : undefined;
  return raw && /^[a-z0-9][a-z0-9-]*$/.test(raw) ? raw : undefined;
}

export function renderSkillDetail(s: Skill): string {
  const L: string[] = [];
  const add = (k: string, v: unknown) => {
    if (v != null && v !== "") L.push(`  ${k} ${v}`);
  };
  add("name:", s.name);
  add("description:", s.description);
  add("status:", s.status);
  add("version:", s.version);
  add("scope:", s.scope);
  add("type:", s.type);
  add("dir:", s.dir);
  if (s.owners?.length) add("owners:", s.owners.join(", "));
  if (s.changelog?.length) {
    L.push("  changelog:");
    for (const e of s.changelog.slice(0, 3)) L.push(`    - ${e}`);
    if (s.changelog.length > 3) L.push(`    (${s.changelog.length - 3} more entries)`);
  }
  if (s.supersedes) add("supersedes:", s.supersedes);
  if (s.capabilities?.length) add("capabilities:", s.capabilities.join(", "));
  if (s.triggers?.length) add("triggers:", s.triggers.join(", "));
  if (s.extends?.length) add("extends:", s.extends.join(", "));
  if (s.owns?.length) add("owns:", s.owns.join(", "));
  if (s.dependsOn?.length) add("dependsOn:", s.dependsOn.join(", "));
  if (s.status === SKILL_STATUS.DEPRECATED) {
    L.push("", `  ⚠ DEPRECATED${s.supersedes ? ` — replaced by \`${s.supersedes}\`` : ""}`);
  }
  return `${L.join("\n")}\n`;
}

export function showSkill(found: Skill[], rest: string[]): number {
  const name = rest.join(" ").trim().toLowerCase();
  if (!name) {
    out("vf", c.red("Usage: vf skills show <name>"), { level: "error" });
    return 2;
  }
  const skill = found.find((s) => s.name === name);
  if (!skill) {
    out("vf", c.dim(`No skill named "${name}" found.`));
    return 0;
  }
  process.stdout.write(renderSkillDetail(skill));
  return 0;
}

import type { Skill } from "../core.js";

export interface SafeSkill {
  name: string;
  description: string;
  version?: string;
  status: string;
  origin: "project-local" | "shared";
  securityScan: "not-scanned" | "pass" | "warn" | "blocked";
}

export function toSafeSkills(skills: Skill[], sharedDir: string): SafeSkill[] {
  const prefix = `${sharedDir.replace(/\/+$/, "")}/`;
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    version: s.version,
    status: s.status,
    origin: s.dir.startsWith(prefix) ? "shared" : "project-local",
    securityScan: "not-scanned" as const,
  }));
}

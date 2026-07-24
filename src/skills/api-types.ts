import type { Skill } from "../core.js";
import type { RegistryLock } from "./registry-types.js";

export interface SafeSkill {
  name: string;
  description: string;
  version?: string;
  status: string;
  scope?: string;
  projectId?: string;
  extends?: string[];
  origin: "project-local" | "shared";
  securityScan: "not-scanned" | "pass" | "warn" | "blocked";
  /** Only set for installed pinned registry skills. */
  registry?: { id: string; version: string; pinned: boolean };
}

export function toSafeSkills(skills: Skill[], sharedDir: string, lock?: RegistryLock): SafeSkill[] {
  const prefix = `${sharedDir.replace(/\/+$/, "")}/`;

  // Build name → {id, version, pinned} map from lock installed skills
  const registryMap = new Map<string, { id: string; version: string; pinned: boolean }>();
  if (lock) {
    for (const entry of lock.registries) {
      const installed = entry.installed ?? [];
      for (const s of installed) {
        if (!registryMap.has(s.name)) {
          registryMap.set(s.name, {
            id: entry.name,
            version: s.version,
            pinned: true,
          });
        }
      }
    }
  }

  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    version: s.version,
    status: s.status,
    scope: s.scope,
    projectId: s.projectId,
    extends: s.extends?.length ? s.extends : undefined,
    origin: s.dir.startsWith(prefix) ? "shared" : "project-local",
    securityScan: "not-scanned" as const,
    registry: registryMap.get(s.name) ?? undefined,
  }));
}

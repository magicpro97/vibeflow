import type { Skill, SkillScope } from "../core.js";
import type { RegistryLock } from "./registry-types.js";

export interface SafeSkill {
  name: string;
  description: string;
  version?: string;
  status: string;
  scope?: SkillScope;
  projectId?: string;
  extends?: string[];
  origin: "project-local" | "shared";
  securityScan: "not-scanned" | "pass" | "warn" | "blocked";
  /** Only set for installed pinned registry skills. */
  registry?: { id: string; version: string; pinned: boolean };
  /** #690: domain ownership metadata (id, role). */
  domain?: { id?: string; role?: "canonical" | "child" };
  /** #690: lifecycle owners (names/emails). */
  owners?: string[];
  /** #690: true when source anchors are stale. */
  stale?: boolean;
  /** #690: reason when stale. */
  staleReason?: string;
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
    domain: s.domain,
    owners: s.owners?.length ? s.owners : undefined,
    stale: s.freshness === "stale" || undefined,
    staleReason: s.freshness === "stale" ? s.freshnessReason : undefined,
  }));
}

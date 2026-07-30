// #670: resolve draft skill name against domain registry before creating.
// Reuses analyzeSkillImpact (#667) — no new graph system.

import { relative } from "node:path";
import { analyzeSkillImpact } from "./impact.js";
import { matchPolicyPaths, readSkillPolicy } from "./policy.js";
import { discoverSkills } from "./registry.js";

export type ResolutionKind = "use-existing" | "update-existing" | "create-new";

export interface DraftResolution {
  kind: ResolutionKind;
  existingSkill?: string;
  existingPath?: string;
  details: string;
}

export function resolveDraftDomain(
  repo: string,
  name: string,
  inject?: {
    discoverSkills?: typeof discoverSkills;
    readSkillPolicy?: typeof readSkillPolicy;
    matchPolicyPaths?: typeof matchPolicyPaths;
  },
): DraftResolution {
  const _ds = inject?.discoverSkills ?? discoverSkills;
  const impact = analyzeSkillImpact(repo, name, {
    readSkillPolicy: inject?.readSkillPolicy ?? readSkillPolicy,
    matchPolicyPaths: inject?.matchPolicyPaths ?? matchPolicyPaths,
    discoverSkills: _ds,
  });

  const skills = _ds(repo);
  const domainMatch = skills.find((s) => s.domain?.id === name);
  if (domainMatch) {
    return {
      kind: "use-existing",
      existingSkill: domainMatch.name,
      existingPath: domainMatch.path ? relative(repo, domainMatch.path) : undefined,
      details: `Domain "${name}" already owned by "${domainMatch.name}". Edit that skill instead.`,
    };
  }

  const exact = skills.find((s) => impact.skills.includes(s.name));
  if (exact) {
    return {
      kind: "update-existing",
      existingSkill: exact.name,
      existingPath: exact.path ? relative(repo, exact.path) : undefined,
      details: `"${name}" matches facts owned by "${exact.name}". Update existing skill or use --new.`,
    };
  }

  return { kind: "create-new", details: `No domain match for "${name}".` };
}

// #667: determine affected skills from fact keys, repo-relative paths, or domain IDs.
// Deterministic metadata only. No semantic detection, no LLM, no network.

import { c } from "../core.js";
import { out } from "../logbus.js";
import { type DomainFactsFile, readDomainFacts } from "./facts.js";
import { type SkillPolicy, matchPolicyPaths, readSkillPolicy } from "./policy.js";
import { discoverSkills } from "./registry.js";

function isUnsafePath(p: string): boolean {
  return p.startsWith("/") || p.includes("..") || p.includes("\\") || p.includes("\0");
}

export interface ImpactResult {
  facts: string[];
  skills: string[];
  evalCommands: string[];
}

function matchExactKey(facts: DomainFactsFile["facts"], query: string): string[] {
  return facts.filter((f) => f.key === query).map((f) => f.key);
}

function matchByPath(facts: DomainFactsFile["facts"], query: string): string[] {
  const nq = query.replace(/\\/g, "/");
  return facts
    .filter((f) => {
      if (nq.startsWith(f.key) || f.key.startsWith(nq)) return true;
      return (f.paths ?? []).some((p) => nq.startsWith(p) || p.startsWith(nq));
    })
    .map((f) => f.key);
}

function matchByDomain(facts: DomainFactsFile["facts"], query: string): string[] {
  const matched = facts.filter((f) => f.owner === query).map((f) => f.key);
  if (matched.length > 0) return matched;
  return facts.filter((f) => f.key === query).map((f) => f.key);
}

function matchPolicyDomainFacts(
  facts: DomainFactsFile["facts"],
  query: string,
  policy: SkillPolicy,
  mpp: typeof matchPolicyPaths,
): string[] {
  const nq = query.replace(/\\/g, "/");
  const pm = mpp(policy, [nq]);
  const keys: string[] = [];
  for (const rule of pm.rules) {
    if (!rule.domain) continue;
    for (const f of facts) {
      if (f.owner === rule.domain && !keys.includes(f.key)) keys.push(f.key);
    }
  }
  return keys;
}

export function analyzeSkillImpact(
  repo: string,
  query: string,
  inject?: {
    readSkillPolicy?: typeof readSkillPolicy;
    matchPolicyPaths?: typeof matchPolicyPaths;
    discoverSkills?: typeof discoverSkills;
  },
): ImpactResult {
  let file: DomainFactsFile | null;
  if (isUnsafePath(query)) return { facts: [], skills: [], evalCommands: [] };
  try {
    file = readDomainFacts(repo);
  } catch {
    return { facts: [], skills: [], evalCommands: [] };
  }
  if (!file) return { facts: [], skills: [], evalCommands: [] };

  const isPath = query.includes("/") || query.includes(".");
  let matchedFactKeys: string[] = [];

  if (isPath) {
    matchedFactKeys = matchByPath(file.facts, query);
    if (matchedFactKeys.length === 0) matchedFactKeys = matchExactKey(file.facts, query);

    if (matchedFactKeys.length === 0 && inject?.readSkillPolicy && inject?.matchPolicyPaths) {
      const { policy } = inject.readSkillPolicy(repo);
      matchedFactKeys = matchPolicyDomainFacts(file.facts, query, policy, inject.matchPolicyPaths);
    }
  } else {
    matchedFactKeys = matchExactKey(file.facts, query);
    if (matchedFactKeys.length === 0) matchedFactKeys = matchByDomain(file.facts, query);
  }

  if (matchedFactKeys.length === 0) return { facts: [], skills: [], evalCommands: [] };

  const factKeys = new Set(matchedFactKeys);
  const names = new Set(
    file.facts
      .filter((f) => factKeys.has(f.key))
      .flatMap((f) => [f.owner, ...(f.dependents ?? [])]),
  );
  const skills = inject?.discoverSkills?.(repo) ?? discoverSkills(repo);
  let changed = true;
  while (changed) {
    changed = false;
    for (const skill of skills) {
      const ownsFact = (skill.owns ?? []).some((k) => factKeys.has(k));
      const dependsOnKnown = (skill.dependsOn ?? []).some(
        (dep) => names.has(dep) || skills.some((s) => names.has(s.name) && s.domain?.id === dep),
      );
      if ((ownsFact || dependsOnKnown) && !names.has(skill.name)) {
        names.add(skill.name);
        changed = true;
      }
    }
  }

  const affected = [...names].sort();
  return {
    facts: [...factKeys].sort(),
    skills: affected,
    evalCommands: affected.map((name) => `vf skills eval ${name}`),
  };
}

export function handleImpactSubcommand(
  repo: string,
  rest: string[],
  inject?: {
    readSkillPolicy?: typeof readSkillPolicy;
    matchPolicyPaths?: typeof matchPolicyPaths;
  },
): number {
  const query = rest.join(" ").trim();
  if (!query) {
    out("vf", c.red("Usage: vf skills impact <fact-or-path>"), { level: "error" });
    return 2;
  }

  const _readPolicy = inject?.readSkillPolicy ?? readSkillPolicy;
  const _mpp = inject?.matchPolicyPaths ?? matchPolicyPaths;

  const result = analyzeSkillImpact(repo, query, {
    readSkillPolicy: _readPolicy,
    matchPolicyPaths: _mpp,
  });
  if (result.facts.length === 0) {
    out("vf", c.yellow(`No domain facts matched "${query}".`));
    return 3;
  }
  out("vf", `Facts: ${result.facts.join(", ")}`);
  out("vf", `Affected skills: ${result.skills.join(", ")}`);
  out("vf", c.bold("Required re-evaluation:"));
  for (const command of result.evalCommands) out("vf", `  ${command}`);
  return 0;
}

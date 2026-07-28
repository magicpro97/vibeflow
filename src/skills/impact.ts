// #667: determine affected skills from domain facts.

import { c } from "../core.js";
import { out } from "../logbus.js";
import { type DomainFactsFile, readDomainFacts } from "./facts.js";
import { discoverSkills } from "./registry.js";

export interface ImpactResult {
  facts: string[];
  skills: string[];
  evalCommands: string[];
}

export function analyzeSkillImpact(repo: string, query: string): ImpactResult {
  let file: DomainFactsFile | null;
  try {
    file = readDomainFacts(repo);
  } catch {
    return { facts: [], skills: [], evalCommands: [] };
  }
  if (!file) return { facts: [], skills: [], evalCommands: [] };

  const needle = query.toLowerCase();
  const facts = file.facts.filter(
    (fact) =>
      fact.key.toLowerCase() === needle ||
      fact.key.toLowerCase().includes(needle) ||
      fact.statement.toLowerCase().includes(needle),
  );
  if (facts.length === 0) return { facts: [], skills: [], evalCommands: [] };

  const factKeys = new Set(facts.map((fact) => fact.key));
  const names = new Set(facts.flatMap((fact) => [fact.owner, ...(fact.dependents ?? [])]));
  const skills = discoverSkills(repo);
  let changed = true;
  while (changed) {
    changed = false;
    for (const skill of skills) {
      const ownsFact = skill.owns?.some((fact) => factKeys.has(fact));
      const dependsOnKnown = skill.dependsOn?.some(
        (dependency) =>
          names.has(dependency) ||
          skills.some((s) => names.has(s.name) && s.domain?.id === dependency),
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

export function handleImpactSubcommand(repo: string, rest: string[]): number {
  const query = rest.join(" ").trim();
  if (!query) {
    out("vf", c.red("Usage: vf skills impact <fact-or-path>"), { level: "error" });
    return 2;
  }
  const result = analyzeSkillImpact(repo, query);
  if (result.facts.length === 0) {
    out("vf", c.dim(`No domain facts matched "${query}".`));
    return 0;
  }
  out("vf", `Facts: ${result.facts.join(", ")}`);
  out("vf", `Affected skills: ${result.skills.join(", ")}`);
  out("vf", c.bold("Required re-evaluation:"));
  for (const command of result.evalCommands) out("vf", `  ${command}`);
  return 0;
}

// #659: optimize skill descriptions with trigger precision/recall.
// Deterministic, network-free heuristic only — no LLM calls.

import type { Skill } from "../core.js";
import { c } from "../core.js";
import { out } from "../logbus.js";
import { discoverSkills, matchSkillsForTask } from "./registry.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "up",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "you",
  "your",
  "use",
  "using",
  "used",
  "when",
  "what",
  "which",
  "who",
  "whom",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function buildPositiveQueries(name: string, description: string): string[] {
  const tokens = tokenize(`${name} ${description}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

function buildNegativeQueries(skillName: string, allSkills: Skill[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of allSkills) {
    if (s.name === skillName) continue;
    const tokens = tokenize(`${s.name} ${s.description}`);
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 10) break;
    }
    if (out.length >= 10) break;
  }
  return out;
}

export function buildTriggerEvalSet(
  skill: Skill,
  allSkills: Skill[],
): { positives: string[]; negatives: string[] } {
  return {
    positives: buildPositiveQueries(skill.name, skill.description),
    negatives: buildNegativeQueries(skill.name, allSkills),
  };
}

export function scoreTriggering(
  skill: Skill,
  allSkills: Skill[],
  evalSet: { positives: string[]; negatives: string[] },
): { precision: number; recall: number; f1: number } {
  let correctPositiveTriggers = 0;
  let falsePositives = 0;

  for (const q of evalSet.positives) {
    const matches = matchSkillsForTask(allSkills, q);
    if (matches.some((m) => m.skill.name === skill.name)) {
      correctPositiveTriggers++;
    }
  }

  for (const q of evalSet.negatives) {
    const matches = matchSkillsForTask(allSkills, q);
    if (matches.some((m) => m.skill.name === skill.name)) {
      falsePositives++;
    }
  }

  const totalTriggers = correctPositiveTriggers + falsePositives;
  const totalPositives = evalSet.positives.length;

  const precision = totalTriggers === 0 ? 1 : correctPositiveTriggers / totalTriggers;
  const recall = totalPositives === 0 ? 1 : correctPositiveTriggers / totalPositives;
  // A degenerate eval set with no positive queries is unscoreable: recall is
  // vacuously 1, but f1 must be 0 so proposeDescription never reports such a
  // skill as "perfect, no change needed".
  const f1 =
    totalPositives === 0 || precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

export function proposeDescription(
  skill: Skill,
  allSkills: Skill[],
): { candidate: string; f1: number } | null {
  const evalSet = buildTriggerEvalSet(skill, allSkills);
  const current = scoreTriggering(skill, allSkills, evalSet);
  if (current.f1 >= 1) return null;

  const tokens = buildPositiveQueries(skill.name, skill.description);
  const topPhrase = tokens.length > 0 ? tokens[0] : null;
  if (!topPhrase) return null;

  const firstSentence = skill.description.split(/[.!]/)[0]?.trim() || skill.description;
  const candidateDesc = `Use when ${topPhrase}. ${firstSentence}`;

  const candidate: Skill = {
    ...skill,
    description: candidateDesc,
    triggers: [...(skill.triggers ?? []), topPhrase],
  };

  // Score the candidate against a pool with the OLD skill swapped out for the
  // candidate — matchSkillsForTask iterates the pool, so the candidate's new
  // trigger only takes effect if it (not the original) is the one being matched.
  const candidatePool = allSkills.map((s) => (s.name === skill.name ? candidate : s));
  const candidateScore = scoreTriggering(candidate, candidatePool, evalSet);
  if (candidateScore.f1 > current.f1) return { candidate: candidateDesc, f1: candidateScore.f1 };
  return null;
}

export function handleOptimizeDescription(repo: string, rest: string[]): number {
  const name = rest[0]?.trim();
  if (!name) {
    out("vf", c.red("Usage: vf skills optimize-description <skill-name>"), {
      level: "error",
    });
    return 2;
  }

  const allSkills = discoverSkills(repo);
  const skill = allSkills.find((s) => s.name === name);
  if (!skill) {
    out("vf", c.red(`Unknown skill: "${name}".`), { level: "error" });
    return 2;
  }

  const evalSet = buildTriggerEvalSet(skill, allSkills);
  const metrics = scoreTriggering(skill, allSkills, evalSet);

  out("vf", `skill: ${c.bold(skill.name)}`);
  out("vf", `description: ${skill.description}`);
  out("vf", `positives: ${evalSet.positives.length}, negatives: ${evalSet.negatives.length}`);
  out(
    "vf",
    `precision: ${(metrics.precision * 100).toFixed(1)}%  recall: ${(metrics.recall * 100).toFixed(1)}%  f1: ${(metrics.f1 * 100).toFixed(1)}%`,
  );

  const proposal = proposeDescription(skill, allSkills);
  if (proposal) {
    out("vf", c.green(`proposed description (f1 ${(proposal.f1 * 100).toFixed(1)}%):`));
    out("vf", `  ${proposal.candidate}`);
    out("vf", c.dim("(report only — not written to disk)"));
  }

  return 0;
}

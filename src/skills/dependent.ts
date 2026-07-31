// src/skills/dependent.ts — #671
//
// Resolve transitive dependent skills (dependsOn children), detect version
// changes, persist version state under .vibeflow. No skill source mutation.
// No LLM, no network, no shell.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, writeFileSafe } from "../core.js";
import type { Skill } from "../core/types.js";
import { parseFrontmatter } from "../frontmatter.js";
import { findEvalFile, loadEvalFile, runSkillEval } from "./eval.js";

// ── State model ─────────────────────────────────────────────────────

export interface ReviewEntry {
  canonical: string;
  reason: string;
  markedAt: string;
}

export interface DependentVersionState {
  schemaVersion: number;
  versions: Record<string, string>;
  needsReview: Record<string, ReviewEntry>;
}

export const STATE_SCHEMA_VERSION = 1;

export function statePath(repo: string): string {
  return join(repo, CTX_DIR, "skills", "dependent-versions.json");
}

export function defaultState(): DependentVersionState {
  return { schemaVersion: STATE_SCHEMA_VERSION, versions: {}, needsReview: {} };
}

export function readDependentVersions(repo: string): DependentVersionState {
  const p = statePath(repo);
  if (!existsSync(p)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as DependentVersionState;
    if (raw.schemaVersion !== STATE_SCHEMA_VERSION) return defaultState();
    return raw;
  } catch {
    return defaultState();
  }
}

export function writeDependentVersions(repo: string, state: DependentVersionState): void {
  writeFileSafe(statePath(repo), JSON.stringify(state, null, 2));
}

// ── Dependency resolution ───────────────────────────────────────────

export interface DependentResult {
  dependents: string[];
  versionChanged: boolean;
  oldVersion: string | undefined;
  newVersion: string | undefined;
}

/**
 * Resolve all transitive dependents of a canonical skill.
 * Dependents are skills whose `dependsOn` includes the canonical skill's
 * `domain.id` (or the skill name as fallback). Transitive closure via
 * iterative fixpoint.
 */
export function resolveDependentSkills(skills: Skill[], canonicalName: string): string[] {
  const canonical = skills.find((s) => s.name === canonicalName);
  if (!canonical) return [];

  const domainId = canonical.domain?.id ?? canonical.name;
  const direct: string[] = [];

  for (const s of skills) {
    if (s.name === canonicalName) continue;
    if (s.dependsOn?.includes(domainId) || s.dependsOn?.includes(canonical.name)) {
      direct.push(s.name);
    }
  }

  return resolveTransitiveDependents(skills, direct);
}

/**
 * Compute transitive closure of dependents via iterative fixpoint.
 * A skill is a transitive dependent if any skill in the current set
 * has a `domain.id` that appears in another skill's `dependsOn`.
 */
export function resolveTransitiveDependents(skills: Skill[], seeds: string[]): string[] {
  const result = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of skills) {
      if (result.has(s.name)) continue;
      const domainId = s.domain?.id;
      if (!domainId) continue;
      const dependsOn = (s.dependsOn ?? []).filter(Boolean);
      for (const dep of dependsOn) {
        const parent = skills.find(
          (p) => result.has(p.name) && (p.domain?.id === dep || p.name === dep),
        );
        if (parent) {
          result.add(s.name);
          changed = true;
          break;
        }
      }
    }
  }
  return [...result].sort();
}

/**
 * Detect version change for a canonical skill. Returns the old/new
 * version and whether the version changed.
 */
export function detectVersionChange(
  state: DependentVersionState,
  canonicalName: string,
  currentVersion: string | undefined,
): DependentResult {
  const oldVersion = state.versions[canonicalName];
  const newVersion = currentVersion ?? "0.0.0";
  const versionChanged = oldVersion !== undefined && oldVersion !== newVersion;
  return { dependents: [], versionChanged, oldVersion, newVersion };
}

/**
 * Mark a dependent skill as needs-review in the state.
 */
export function markNeedsReview(
  state: DependentVersionState,
  dependent: string,
  canonical: string,
  reason: string,
): void {
  state.needsReview[dependent] = { canonical, reason, markedAt: new Date().toISOString() };
}

/**
 * Clear needs-review for a dependent skill.
 */
export function clearNeedsReview(state: DependentVersionState, dependent: string): void {
  delete state.needsReview[dependent];
}

// ── Eval execution for dependents ──────────────────────────────────

export interface DependentEvalResult {
  name: string;
  status: "pass" | "fail" | "no-evals" | "error";
  triggerAccuracy: number;
  detail: string;
}

/**
 * Run eval for a single dependent skill. Uses existing eval mechanics
 * — no shell, no LLM, no network. Returns pass/fail/no-evals/error.
 */
export function evalDependentSkill(skill: Skill): DependentEvalResult {
  const evalPath = findEvalFile(skill.dir);
  if (!evalPath) {
    return {
      name: skill.name,
      status: "no-evals",
      triggerAccuracy: 0,
      detail: "no evals.json found",
    };
  }
  try {
    const evals = loadEvalFile(evalPath);
    const result = runSkillEval(skill, evals);
    const pass = !result.summary.regression && result.summary.triggerAccuracy >= 1;
    return {
      name: skill.name,
      status: pass ? "pass" : "fail",
      triggerAccuracy: result.summary.triggerAccuracy,
      detail: `trigger accuracy: ${(result.summary.triggerAccuracy * 100).toFixed(1)}%`,
    };
  } catch (err) {
    return {
      name: skill.name,
      status: "error",
      triggerAccuracy: 0,
      detail: (err as Error).message,
    };
  }
}

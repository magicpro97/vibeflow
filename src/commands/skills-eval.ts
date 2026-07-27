// src/commands/skills-eval.ts — #658
//
// `vf skills eval <skill-path>` subcommand. Reads evals.json from the
// skill directory, runs deterministic trigger matching, scores, flags
// regression. Reuses matchSkillsForTask from registry.
//
// ponytail: no live LLM eval — deterministic trigger-accuracy + schema
// validation only. Add task-completion LLM eval when needed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c, writeFileSafe } from "../core.js";
import type { Skill } from "../core/types.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { type EvalResult, findEvalFile, loadEvalFile, runSkillEval } from "../skills/eval.js";

// ── Skill loading ───────────────────────────────────────────────────

function loadSingleSkill(skillDir: string): Skill {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`no SKILL.md found in ${skillDir}`);
  }
  const text = readFileSync(skillMd, "utf8");
  const { data } = parseFrontmatter(text);
  const name = typeof data.name === "string" ? data.name.trim().toLowerCase() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`skill name "${name}" is not valid kebab-case`);
  }
  if (!description) throw new Error("skill has no description");

  return {
    name,
    description,
    version: typeof data.version === "string" ? data.version : undefined,
    status: "unverified",
    capabilities: asStrArr(data.capabilities),
    triggers: asStrArr(data.triggers),
    type: data.type === "repo" ? "repo" : undefined,
    dir: skillDir,
    path: skillMd,
  } as Skill;
}

function asStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

// ── Formatting ──────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatSummary(result: EvalResult): string {
  const s = result.summary;
  const lines: string[] = [];
  lines.push(
    `  positive trigger accuracy:  ${pct(s.positive.triggerAccuracy)}  (${s.positive.passed}/${s.positive.total})`,
  );
  lines.push(
    `  negative trigger accuracy:  ${pct(s.negative.triggerAccuracy)}  (${s.negative.passed}/${s.negative.total})`,
  );
  if (s.baseline.total > 0) {
    lines.push(
      `  baseline trigger accuracy:  ${pct(s.baseline.triggerAccuracy)}  (${s.baseline.passed}/${s.baseline.total})`,
    );
  }
  const allPassed = s.positive.passed + s.negative.passed + s.baseline.passed;
  const allTotal = s.positive.total + s.negative.total + s.baseline.total;
  lines.push(`  task pass rate:             ${pct(s.taskPassRate)}  (${allPassed}/${allTotal})`);

  if (result.previousSummary !== undefined) {
    const prev = result.previousSummary;
    const delta = s.taskPassRate - prev.taskPassRate;
    const deltaStr = delta >= 0 ? `+${pct(delta)}` : `-${pct(Math.abs(delta))}`;
    lines.push(`  vs previous:                ${deltaStr}`);
    if (s.regression) {
      lines.push(c.red(`  regression: ${pct(s.taskPassRate)} < ${pct(prev.taskPassRate)}`));
    }
  }

  return lines.join("\n");
}

// ── Main entry ──────────────────────────────────────────────────────
//
// Signature matches skills.ts pattern: (repo, rest) → number
// where rest includes the skill dir and optional flags.

export function skillsEvalCmd(_repo: string, rest: string[] = []): number {
  let jsonFlag = false;
  let outFile = "";
  let previousFile = "";
  const clean: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === "--json") {
      jsonFlag = true;
      continue;
    }
    if (tok === "--out") {
      outFile = (rest[++i] as string) ?? "";
      continue;
    }
    if (tok === "--previous") {
      previousFile = (rest[++i] as string) ?? "";
      continue;
    }
    clean.push(tok);
  }
  const skillDir = clean.join(" ").trim();
  if (!skillDir) {
    out(
      "vf",
      c.red("Usage: vf skills eval <skill-dir-path> [--json] [--out <file>] [--previous <file>]"),
      { level: "error" },
    );
    return 2;
  }

  const absDir = join(_repo, skillDir);

  try {
    const skill = loadSingleSkill(absDir);

    const evalPath = findEvalFile(absDir);
    if (!evalPath) {
      out("vf", c.red(`no evals.json found for skill at ${absDir}`), { level: "error" });
      return 1;
    }
    const evalsFile = loadEvalFile(evalPath);

    if (skill.name !== evalsFile.skill) {
      out(
        "vf",
        c.yellow(
          `! SKILL.md name "${skill.name}" differs from evals.json skill "${evalsFile.skill}"`,
        ),
      );
    }

    let previous: { taskPassRate: number } | undefined;
    if (previousFile) {
      if (existsSync(previousFile)) {
        const prev = JSON.parse(readFileSync(previousFile, "utf8")) as EvalResult;
        if (typeof prev.summary?.taskPassRate === "number") {
          previous = { taskPassRate: prev.summary.taskPassRate };
        }
      }
    }

    const result = runSkillEval(skill, evalsFile, previous);

    if (jsonFlag) {
      out("vf", JSON.stringify(result, null, 2));
    } else {
      out("vf", c.bold(`Skill eval: ${skill.name}`));
      out("vf", `  ${skill.description}`);
      out("vf", "");
      for (const caze of result.cases) {
        const icon = caze.pass ? c.green("✔") : c.red("✗");
        const expected = caze.expectedTrigger ? "trigger" : "no-trigger";
        const actual = caze.actualTrigger ? "trigger" : "no-trigger";
        const extra = caze.pass ? "" : ` (expected ${expected}, got ${actual})`;
        out("vf", `  ${icon} ${caze.id} [${caze.type}]${extra}`);
      }
      out("vf", "");
      out("vf", formatSummary(result));
    }

    if (outFile) {
      writeFileSafe(outFile, `${JSON.stringify(result, null, 2)}\n`);
      out("vf", c.dim(`  result written to ${outFile}`));
    }

    return result.summary.regression ? 1 : 0;
  } catch (err) {
    out("vf", c.red(`eval error: ${(err as Error).message}`), { level: "error" });
    return 1;
  }
}

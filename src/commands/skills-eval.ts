// src/commands/skills-eval.ts — #658
//
// `vf skills eval <skill-path>` subcommand. Reads evals.json from the
// skill directory, measures trigger matching, and compares objective task
// output with and without the skill through the existing dispatch runner.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { ENGINES, type Engine, type Skill } from "../core/types.js";
import { type AsyncSpawner, runDispatchAsync } from "../dispatch.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import {
  type EvalResult,
  findEvalFile,
  loadEvalFile,
  runSkillEval,
  runTaskEval,
} from "../skills/eval.js";

// ── Skill loading ───────────────────────────────────────────────────

function loadSingleSkill(skillDir: string): { skill: Skill; text: string } {
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
    text,
    skill: {
      name,
      description,
      version: typeof data.version === "string" ? data.version : undefined,
      status: "unverified",
      capabilities: asStrArr(data.capabilities),
      triggers: asStrArr(data.triggers),
      type: data.type === "repo" ? "repo" : undefined,
      dir: skillDir,
      path: skillMd,
    } as Skill,
  };
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

function engineText(raw: string): string {
  const texts: string[] = [];
  for (const chunk of [raw.trim(), ...raw.split(/\r?\n/)]) {
    try {
      const event = JSON.parse(chunk) as {
        result?: unknown;
        type?: string;
        item?: Record<string, unknown>;
        part?: Record<string, unknown>;
      };
      if (typeof event.result === "string") return event.result;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") return event.item.text;
      }
      if (event.type === "text" && typeof event.part?.text === "string") {
        texts.push(event.part.text);
      }
    } catch {
      // Plain output and incomplete JSONL chunks fall back below.
    }
  }
  return texts.length ? texts.join("\n") : raw;
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
  lines.push(`  trigger accuracy:           ${pct(s.triggerAccuracy)}  (${allPassed}/${allTotal})`);

  if (result.task) {
    lines.push(`  baseline task pass rate:    ${pct(result.task.baselinePassRate)}`);
    lines.push(`  with-skill task pass rate:  ${pct(result.task.skillPassRate)}`);
    lines.push(`  task delta:                 ${pct(result.task.delta)}`);
  }

  if (result.previousSummary !== undefined) {
    const prev = result.previousSummary;
    if (prev.triggerAccuracy !== undefined) {
      const delta = s.triggerAccuracy - prev.triggerAccuracy;
      lines.push(`  trigger vs previous:        ${delta >= 0 ? "+" : "-"}${pct(Math.abs(delta))}`);
      if (s.regression) {
        lines.push(
          c.red(`  trigger regression: ${pct(s.triggerAccuracy)} < ${pct(prev.triggerAccuracy)}`),
        );
      }
    }
    if (result.task && prev.taskPassRate !== undefined) {
      const delta = result.task.taskPassRate - prev.taskPassRate;
      lines.push(`  task vs previous:           ${delta >= 0 ? "+" : "-"}${pct(Math.abs(delta))}`);
      if (result.task.regression) {
        lines.push(
          c.red(`  task regression: ${pct(result.task.taskPassRate)} < ${pct(prev.taskPassRate)}`),
        );
      }
    }
  }

  return lines.join("\n");
}

// ── Main entry ──────────────────────────────────────────────────────
//
// Signature matches skills.ts pattern: (repo, rest) → number
// where rest includes the skill dir and optional flags.

export async function skillsEvalCmd(
  _repo: string,
  rest: string[] = [],
  inject: {
    runner?: (prompt: string, skillContext?: string) => string | Promise<string>;
    spawner?: AsyncSpawner;
  } = {},
): Promise<number> {
  let jsonFlag = false;
  let outFile = "";
  let previousFile = "";
  let engine: Engine = "opencode";
  const clean: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === "--json") {
      jsonFlag = true;
      continue;
    }
    if (tok === "--out") {
      outFile = rest[++i] ?? "";
      if (!outFile) {
        out("vf", c.red("--out requires a file"), { level: "error" });
        return 2;
      }
      continue;
    }
    if (tok === "--previous") {
      previousFile = rest[++i] ?? "";
      if (!previousFile) {
        out("vf", c.red("--previous requires a file"), { level: "error" });
        return 2;
      }
      continue;
    }
    if (tok === "--engine") {
      const value = rest[++i] ?? "";
      if (!(ENGINES as string[]).includes(value)) {
        out("vf", c.red(`invalid --engine: ${value}`), { level: "error" });
        return 2;
      }
      engine = value as Engine;
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

  const absDir = resolve(_repo, skillDir);

  try {
    const { skill, text } = loadSingleSkill(absDir);

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

    let previous: { triggerAccuracy?: number; taskPassRate?: number } | undefined;
    if (previousFile) {
      if (!existsSync(previousFile)) throw new Error(`previous result not found: ${previousFile}`);
      const prev = JSON.parse(readFileSync(previousFile, "utf8")) as EvalResult & {
        summary: EvalResult["summary"] & { taskPassRate?: number };
      };
      previous = {
        triggerAccuracy: prev.summary?.triggerAccuracy ?? prev.summary?.taskPassRate,
        taskPassRate: prev.task?.taskPassRate,
      };
      for (const value of Object.values(previous))
        if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))
          throw new Error("previous rates must be finite numbers from 0 to 1");
    }

    const result = runSkillEval(
      skill,
      evalsFile,
      previous?.triggerAccuracy === undefined
        ? undefined
        : { triggerAccuracy: previous.triggerAccuracy },
    );
    const runner =
      inject.runner ??
      (async (prompt: string, skillContext?: string) => {
        const fullPrompt = skillContext
          ? `${prompt}\n\nFollow this skill for the task:\n${skillContext}`
          : prompt;
        const dispatched = await runDispatchAsync({
          engine,
          prompt: fullPrompt,
          mode: "cli",
          spawner: inject.spawner,
          base: _repo,
        });
        if (!dispatched.ok) throw new Error(dispatched.reason ?? `${engine} eval failed`);
        return engineText(dispatched.raw);
      });
    result.task = await runTaskEval(evalsFile, text, runner, previous?.taskPassRate);
    if (previous) result.previousSummary = previous;

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

    return result.summary.regression || result.task?.regression ? 1 : 0;
  } catch (err) {
    out("vf", c.red(`eval error: ${(err as Error).message}`), { level: "error" });
    return 1;
  }
}

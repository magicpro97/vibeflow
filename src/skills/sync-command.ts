import {
  CTX_DIR,
  c,
  existsSync,
  join,
  out,
  syncSkillMirrors,
  verifySkillSync,
} from "../commands/_shared.js";
import { guardLegacyWriter } from "../commands/capability/legacy-fence.js";
import { AGENT_ENGINE, type Engine, isAgentEngine } from "../core/agent-contract.js";

const CANONICAL_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_SYNC_ENGINES = Object.values(AGENT_ENGINE) as readonly Engine[];

function parseRepeatableFlagValues(
  rest: readonly string[],
  flagName: string,
): { ok: true; values: string[] } | { ok: false; code: 2 } {
  const values: string[] = [];
  const flag = `--${flagName}`;
  const prefix = `${flag}=`;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === flag) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        out("vf", c.red(`✗ ${flag} requires a value`), { level: "error" });
        return { ok: false, code: 2 };
      }
      values.push(value);
      i += 1;
      continue;
    }
    if (typeof tok === "string" && tok.startsWith(prefix)) {
      const value = tok.slice(prefix.length);
      if (!value) {
        out("vf", c.red(`✗ ${flag} requires a value`), { level: "error" });
        return { ok: false, code: 2 };
      }
      values.push(value);
    }
  }
  return { ok: true, values };
}

function parseSkillMirrorEngines(
  rest: readonly string[],
): { ok: true; engines?: Engine[] } | { ok: false; code: 2 } {
  const parsed = parseRepeatableFlagValues(rest, "engine");
  if (!parsed.ok) return parsed;
  const engines: Engine[] = [];
  for (const value of parsed.values) {
    if (!isAgentEngine(value)) {
      out(
        "vf",
        c.red(`✗ --engine must be one of ${SKILL_SYNC_ENGINES.join(", ")}, got '${value}'`),
        {
          level: "error",
        },
      );
      return { ok: false, code: 2 };
    }
    if (!engines.includes(value)) engines.push(value);
  }
  return { ok: true, engines: engines.length > 0 ? engines : undefined };
}

function parseSyncSkillTargets(
  repo: string,
  rest: readonly string[],
): { ok: true; skills?: string[] } | { ok: false; code: 2 } {
  const parsed = parseRepeatableFlagValues(rest, "skill");
  if (!parsed.ok) return parsed;
  const skills: string[] = [];
  for (const value of parsed.values) {
    if (!CANONICAL_SKILL_NAME.test(value)) {
      out("vf", c.red(`✗ --skill must be lowercase-hyphen, got '${value}'`), {
        level: "error",
      });
      return { ok: false, code: 2 };
    }
    const skillPath = join(repo, CTX_DIR, "skills", value, "SKILL.md");
    if (!existsSync(skillPath)) {
      out("vf", c.red(`✗ --skill '${value}' not found at ${CTX_DIR}/skills/${value}/SKILL.md`), {
        level: "error",
      });
      return { ok: false, code: 2 };
    }
    if (!skills.includes(value)) skills.push(value);
  }
  return { ok: true, skills: skills.length > 0 ? skills : undefined };
}

export function handleSkillsSyncSubcommand(repo: string, rest: readonly string[]): number {
  const fence = guardLegacyWriter(repo, "vf skills sync");
  if (fence !== null) return fence;
  const parsedEngines = parseSkillMirrorEngines(rest);
  if (!parsedEngines.ok) return parsedEngines.code;
  const parsedSkills = parseSyncSkillTargets(repo, rest);
  if (!parsedSkills.ok) return parsedSkills.code;
  let mode: "pointer" | "full" = "pointer";
  let fromRegistry = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--mode") {
      const v = rest[i + 1];
      if (v !== "full" && v !== "pointer") {
        out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v ?? "(missing)"}'`), {
          level: "error",
        });
        return 2;
      }
      mode = v;
    }
    if (typeof tok === "string" && tok.startsWith("--mode=")) {
      const v = tok.slice("--mode=".length);
      if (v !== "full" && v !== "pointer") {
        out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v}'`), {
          level: "error",
        });
        return 2;
      }
      mode = v;
    }
    if (tok === "--from-registry") fromRegistry = true;
  }
  const result = syncSkillMirrors(repo, {
    mode,
    fromRegistry,
    engines: parsedEngines.engines,
    skills: parsedSkills.skills,
  });
  for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
  for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
  if (result.ok) {
    out(
      "vf",
      c.green(
        `✔ synced ${result.synced.length} skill mirror(s) (mode=${result.mode})${result.synced.length > 0 ? ` → ${result.synced.slice(0, 3).join(", ")}${result.synced.length > 3 ? "…" : ""}` : ""}`,
      ),
    );
    return 0;
  }
  out("vf", c.red(`✗ ${result.errors.length} sync error(s)`), { level: "error" });
  return 1;
}

export function handleSkillsVerifySyncSubcommand(repo: string, rest: readonly string[]): number {
  const parsedEngines = parseSkillMirrorEngines(rest);
  if (!parsedEngines.ok) return parsedEngines.code;
  let fromRegistry = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--from-registry") fromRegistry = true;
  }
  const result = verifySkillSync(repo, parsedEngines.engines, {
    fromRegistry,
  });
  for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
  if (result.ok) {
    out("vf", c.green(`✔ all ${result.synced.length} mirror(s) in sync`));
    return 0;
  }
  out("vf", c.red(`✗ ${result.errors.length} mirror(s) out of sync`), { level: "error" });
  return 1;
}

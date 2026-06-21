// `vf skills` subcommand extracted from src/commands.ts (issue #80, phase 7/14).
// Pure byte-equivalent move: body preserved verbatim, only the import
// path changed from `./commands/_shared.js` to `../commands/_shared.js`
// (sibling module now consumes the barrel from one level up).
//
// Subcommands: list, validate, search, resolve, sync, verify-sync,
// import, init. Each is a small dispatch on the `sub` argument; the
// `init` subcommand is the only one that writes to disk (via
// writeFileSafe under .vibeflow/skills/<name>/SKILL.md).
//
// Fail-closed posture preserved: every error path returns 1 (failure)
// or 2 (usage error); success returns 0. The `init` subcommand
// refuses to overwrite an existing SKILL.md (line 776).

import {
  CTX_DIR,
  c,
  cwd,
  discoverSkills,
  existsSync,
  importSkillFromDir,
  importSkillsFromParent,
  join,
  matchSkillsForTask,
  out,
  readState,
  renderSkillIndex,
  renderSkillNeeds,
  resolveSkillNeeds,
  scanRepo,
  syncSkillMirrors,
  validateSkillRoots,
  verifySkillSync,
  writeFileSafe,
} from "./_shared.js";

export function skills(sub: string | undefined, rest: string[] = []): number {
  const repo = cwd();
  const found = discoverSkills(repo);
  if (sub === undefined || sub === "list") {
    if (!found.length) {
      out(
        "vf",
        c.dim(`No skills discovered under ${CTX_DIR}/skills, .kiro/skills, or .claude/skills.`),
      );
      return 0;
    }
    process.stdout.write(renderSkillIndex(found));
    return 0;
  }
  if (sub === "validate") {
    const result = validateSkillRoots(repo);
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ ${result.skills.length} skill(s) valid`));
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} validation error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "search") {
    const term = rest.join(" ").trim();
    if (!term) {
      out("vf", c.red("Usage: vf skills search <term>"), {
        level: "error",
      });
      return 2;
    }
    const matches = matchSkillsForTask(found, term);
    if (!matches.length) {
      out("vf", c.dim(`No skill matched "${term}".`));
      return 0;
    }
    for (const m of matches) {
      out("vf", `${c.bold(m.skill.name)} ${c.dim(`(${m.score.toFixed(2)})`)} — ${m.reason}`);
    }
    return 0;
  }
  if (sub === "resolve") {
    // Demand-driven: derive skill NEEDS from the repo scan + saved intake, then report
    // which are satisfied locally and which must be acquired on demand (never pre-installed).
    const state = readState(repo);
    const profile = scanRepo(repo);
    const attachments = (state?.attachments ?? []).map((a) => a.name);
    const needs = resolveSkillNeeds({
      repo,
      attachments,
      task: state?.goal,
      profile,
    });
    process.stdout.write(renderSkillNeeds(needs));
    return 0;
  }
  if (sub === "sync") {
    // Parse `--mode pointer|full` (or `--mode=pointer|full`) and
    // `--engine claude|codex|copilot` from `rest`.
    // Default mode is "pointer". When --engine is omitted, sync only to the
    // copilot mirror (the default engine). Use --engine <name> for other engines.
    let mode: "pointer" | "full" = "pointer";
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
    }
    const result = syncSkillMirrors(repo, { mode });
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out(
        "vf",
        c.green(
          `✔ synced ${result.synced.length} skill mirror(s) (mode=${result.mode}) → ${result.synced.slice(0, 3).join(", ")}${result.synced.length > 3 ? "…" : ""}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} sync error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "verify-sync") {
    // Parse --engine flag to filter which mirror to verify (defaults to copilot).
    const result = verifySkillSync(repo);
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ all ${result.synced.length} mirror(s) in sync`));
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} mirror(s) out of sync`), { level: "error" });
    return 1;
  }
  if (sub === "import") {
    const target = rest.join(" ").trim();
    if (!target) {
      out("vf", c.red("Usage: vf skills import <dir>   (a directory containing SKILL.md)"), {
        level: "error",
      });
      return 2;
    }
    // Heuristic: if target is an existing directory with a SKILL.md child,
    // treat as a single-skill import; otherwise treat as a parent dir of
    // multiple skills. `context7:<query>` is a network lookup and is not
    // auto-executed — surface a hint to the user.
    if (target.startsWith("context7:")) {
      out(
        "vf",
        c.yellow(
          `! context7 lookup not auto-executed. Run \`vf discover skills ${target.slice("context7:".length)} --yes\` first, then \`vf skills import <download-dir>\`.`,
        ),
      );
      return 2;
    }
    const result = importSkillFromDir(repo, target);
    // If single-skill import found nothing, try parent-dir import.
    const finalResult = result.imported.length > 0 ? result : importSkillsFromParent(repo, target);
    for (const w of finalResult.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of finalResult.errors) out("vf", c.red(`✗ ${e}`));
    if (finalResult.ok) {
      out(
        "vf",
        c.green(
          `✔ imported ${finalResult.imported.length} skill(s): ${finalResult.imported.join(", ")}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ import failed: ${finalResult.errors.join("; ")}`), { level: "error" });
    return 1;
  }
  if (sub === "init") {
    const name = rest[0]?.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      out("vf", c.red("Usage: vf skills init <name>  (lowercase-hyphen, e.g. compose-screen-ux)"), {
        level: "error",
      });
      return 2;
    }
    const dir = join(repo, CTX_DIR, "skills", name);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      out("vf", c.red(`Skill "${name}" already exists at ${skillMd}.`), {
        level: "error",
      });
      return 1;
    }
    writeFileSafe(skillMd, skillTemplate(name));
    out("vf", c.green(`+ scaffolded skill ${c.bold(name)} → ${skillMd}`));
    out(
      "vf",
      c.dim(
        "Edit triggers/capabilities so `vf skills search <task>` matches it, then fill the steps.",
      ),
    );
    return 0;
  }
  out(
    "vf",
    c.dim(`vf skills ${sub} — registry operations are configured via providers (see docs).`),
  );
  return 0;
}

/** A starter SKILL.md: valid frontmatter (so discoverSkills/parseSkill accept it) + a steps stub. */
function skillTemplate(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: One-line summary of what this skill does and when to apply it.",
    "status: draft",
    "capabilities:",
    "  - capability-keyword",
    "triggers:",
    "  - trigger-keyword",
    "requires:",
    "  filesystem: read",
    "  network: false",
    "  shell: false",
    "---",
    "",
    `# ${name}`,
    "",
    "## When to use",
    "Describe the task shape that should invoke this skill.",
    "",
    "## Steps",
    "1. First concrete step.",
    "2. Next step.",
    "",
    "## Verification",
    "How to prove the skill was applied correctly (command output, file check, test).",
    "",
  ].join("\n");
}

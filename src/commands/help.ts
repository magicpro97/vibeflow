// `vf help` cluster extracted from src/commands.ts (issue #80, phase 8/14).
// Pure byte-equivalent move: body preserved verbatim. All imports come through
// `./_shared.js` per the ESM cycle rule (no sibling imports).
//
// Exported public surface (also re-exported by src/commands.ts facade):
//   - printHelp
//   - hasCommandHelp
//   - printCommandHelp
//
// Private data (file-scoped, not re-exported):
//   - COMMAND_HELP: per-subcommand help text registry

import { VERSION, c, out } from "./_shared.js";
import { COMMAND_HELP } from "./help-commands.js";

export function printHelp(): number {
  out(
    "vf",
    `${c.bold("VibeFlow")} v${VERSION} — orchestrate Claude Code, Codex & Copilot CLI

  ${c.bold("Usage:")} vf [command] [options]

  ${c.bold("Commands:")}
    ${c.cyan("(none)")}            open the local web UI
    ${c.cyan("ui")}                open the local web UI
    ${c.cyan("doctor")}            check required and optional tools (--probe for live engine readiness)
    ${c.cyan("init")}              generate canonical context + engine files (--engine, --no-ask, --no-ai, --dry-run)
    ${c.cyan("run <engine>")}      dispatch claude | codex | copilot | opencode | antigravity (--yes to launch)
    ${c.cyan("ask <f>:<lines>")}   inline code Q&A: stream an engine's answer about a snippet (--engine)
    ${c.cyan("orchestrate")}       plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency, --focus)
    ${c.cyan("review evidence|check")}   create local commit-anchored evidence (--base <full-SHA> --result <JSON>) or validate it (--base <full-SHA>)
    ${c.cyan("demo")}              run a fixed file corpus through orchestrate --dry --focus (no engine spend, repeatable)
    ${c.cyan("workflow [sub]")}    delete [--all] | delete-unit <name> | import <src> [--on-collision] (--yes to apply)
    ${c.cyan("canary [sub]")}      list | link <unit> <file> | check — human-authored canary tests (ADR-005)
    ${c.cyan("units [sub]")}       status | show <name> | resources | evidence <name> | add <name> | update <name> [--status s] [--confidence n] | delete <name>
    ${c.cyan("status")}             crash-recovery view of per-unit markers after a crash (--timeline <unit> | --json)
    ${c.cyan("config [sub]")}      memory <builtin|claude-mem|off|status> — read/toggle per-repo settings
    ${c.cyan("skills [sub]")}      list | search <term> | resolve | validate | sync | verify-sync | verify-lock | import | semantic-filter | registry <add|list|update>
    ${c.cyan("superpowers sync")}  install exact registry-locked Superpowers into installed engine CLIs (--yes)
    ${c.cyan("tools [sub]")}       status | enable <tool> | disable <tool> | install <tool> (--yes)
    ${c.cyan("discover <kind>")}   docs|skills <query> via Context7 (--yes approves network)
    ${c.cyan("hook")}              evaluate a JSON hook event from stdin (allow/warn/require_approval/block)
    ${c.cyan("hooks [sub]")}       status | install | emit (write engine hook configs)
    ${c.cyan("pr [sub]")}          create | queue | merge-when-green — open/queue GitHub PRs (--yes to push)
    ${c.cyan("decision [sub]")}    add | list — record durable architecture decisions (ADR-lite)
    ${c.cyan("state [sub]")}       brief [--consult] — read the coordinator brief
    ${c.cyan("coord")}             consult brief + enforce freshness gate before non-trivial actions
    ${c.cyan("verify")}            typecheck / lint / test + confidence / evidence / scope gates
    ${c.cyan("eval")}              success-rate + gate breakdown from real telemetry; exit 1 below --min-pass-rate (CI gate)
    ${c.cyan("update-check")}      check npm for a newer VibeFlow release
    ${c.cyan("help, --version")}   show help / version

  ${c.dim("Run `vf <command> --help` for command-specific usage.")}
  `,
  );
  return 0;
}

/** Per-subcommand help blocks. Keys mirror the routing switch in cli.ts. Each entry is a short
 * usage/description/flags block; derived from the actual command implementations above. */

/** True when `cmd` is a known subcommand that carries its own help block. */
export function hasCommandHelp(cmd: string | undefined): boolean {
  return cmd !== undefined && cmd in COMMAND_HELP;
}

/** Print the help block for a single subcommand. Falls back to global help when unknown. */
export function printCommandHelp(cmd: string): number {
  const render = COMMAND_HELP[cmd];
  if (!render) return printHelp();
  out("vf", render());
  return 0;
}

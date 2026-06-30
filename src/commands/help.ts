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
    ${c.cyan("run <engine>")}      dispatch claude | codex | copilot (--yes to launch)
    ${c.cyan("orchestrate")}       plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency, --focus)
    ${c.cyan("demo")}              run a fixed file corpus through orchestrate --dry --focus (no engine spend, repeatable)
    ${c.cyan("workflow [sub]")}    delete [--all] | delete-unit <name> | import <src> [--on-collision] (--yes to apply)
    ${c.cyan("units [sub]")}       status | show <name> | resources | evidence <name> | add <name> | update <name> [--status s] [--confidence n] | delete <name>
    ${c.cyan("config [sub]")}      memory <on|off|status> — read/toggle per-repo settings
    ${c.cyan("skills [sub]")}      list | search <term> | resolve | validate | sync | verify-sync | import
    ${c.cyan("tools [sub]")}       status | enable <tool> | disable <tool> | install <tool> (--yes)
    ${c.cyan("discover <kind>")}   docs|skills <query> via Context7 (--yes approves network)
    ${c.cyan("hook")}              evaluate a JSON hook event from stdin (allow/warn/require_approval/block)
    ${c.cyan("hooks [sub]")}       status | install | emit (write engine hook configs)
    ${c.cyan("pr [sub]")}           create | queue | merge-when-green — open/queue GitHub PRs (--yes to push)
    ${c.cyan("decision [sub]")}    add | list — record durable architecture decisions (ADR-lite)
    ${c.cyan("state [sub]")}        brief [--consult] — read the coordinator brief
    ${c.cyan("coord")}             consult brief + enforce freshness gate before non-trivial actions
    ${c.cyan("verify")}            typecheck / lint / test + confidence / evidence / scope gates
    ${c.cyan("help, --version")}   show help / version

  ${c.dim("Run `vf <command> --help` for command-specific usage.")}
  `,
  );
  return 0;
}

/** Per-subcommand help blocks. Keys mirror the routing switch in cli.ts. Each entry is a short
 * usage/description/flags block; derived from the actual command implementations above. */
const COMMAND_HELP: Record<string, () => string> = {
  ui: () => `${c.bold("vf ui")} ${c.dim("[--port <n>] [--no-open]")}
Open the local web UI (intake wizard + workflow console). This is also the default
command when you run \`vf\` with no arguments.

${c.bold("Options:")}
  --port <n>    bind to a specific port (default: an ephemeral free port)
  --no-open     start the server without launching a browser

${c.bold("Examples:")}
  vf
  vf ui --port 4173 --no-open`,

  doctor: () => `${c.bold("vf doctor")} ${c.dim("[--probe]")}
Check required (node, git) and optional (bun, engine CLIs, docker) tools, plus
per-engine readiness.

${c.bold("Options:")}
  --probe       run a live engine round-trip instead of a presence/auth check

${c.bold("Examples:")}
  vf doctor
  vf doctor --probe`,

  init: () => `${c.bold("vf init")} ${c.dim("[--engine <claude|codex|copilot>] [--no-ask] [--no-ai] [--no-hooks] [--dry-run]")}
Generate the canonical context + engine instruction files and a workflow ledger.
By default a hard creation gate refuses when no engine is ready; --dry-run previews
offline (writes nothing). When --engine is omitted, init targets the centralized
DEFAULT_ENGINE (currently "copilot"; both init and orchestrate share this default).
AI enrichment is ON by default — pass --no-ai to skip the headless engine dispatch.

${c.bold("Options:")}
  --engine <e>   generate for a single engine (default: copilot)
  --no-ask       skip the intake questionnaire in TTY mode
  --no-ai        skip AI enrichment (deterministic context files only)
  --no-hooks     skip the interactive guardrail-hooks setup (keeps all-on default)
  --dry-run      read-only preview — print what would be written, change nothing

${c.bold("Examples:")}
  vf init --engine claude
  vf init --no-ask
  vf init --no-ai
  vf init --no-hooks
  vf init --dry-run`,

  run: () => `${c.bold("vf run")} ${c.dim("<claude|codex|copilot> [--yes]")}
Write the dispatch prompt for one engine. Without --yes it is a read-only dry run;
--yes launches the engine CLI behind the source-protection gate.

${c.bold("Options:")}
  --yes               launch the engine (otherwise dry-run only)
  --auto-wip          snapshot a dirty tree before launching instead of refusing
  --require-git       refuse to launch outside a git repo
  --rollback-on-fail  reset the tree to the pre-dispatch checkpoint on failure

${c.bold("Examples:")}
  vf run claude
  vf run codex --yes`,

  orchestrate:
    () => `${c.bold("vf orchestrate")} ${c.dim("[--engine <e>] [--yes] [--concurrency <n>] [--risk <class>] [--focus]")}
Dispatch every saved work unit (bounded-parallel), run an independent reviewer,
record evidence, then evaluate the goal. Default mode is a read-only dry run.

${c.bold("Options:")}
  --engine <e>        target engine (default: copilot)
  --yes               real run — launch the engine (otherwise dry preview)
  --concurrency <n>   max units dispatched in parallel
  --risk <class>      docs | simple-code | feature | architecture | security | deploy
  --auto-wip / --require-git / --rollback-on-fail   source-protection toggles
  --security-check    opt-in to the post-coding security checkpoint (PR #160)
  --isolate           dispatch each unit in its own git worktree (cli only; off by default)
  --no-unit-gate      skip the per-unit typecheck+biome gate (final bun run check still runs)
  --pr                after a unit's review passes, open a QUEUED PR for it (needs --isolate; never merges)

${c.bold("Examples:")}
  vf orchestrate
  vf orchestrate --engine codex --yes --concurrency 2
  vf orchestrate --engine codex --yes --concurrency 3 --isolate --pr`,

  demo: () => `${c.bold("vf demo")} ${c.dim("[--engine <e>] [--concurrency <n>]")}
Stage a fixed file corpus as work units and run them through the orchestrate
path in dry + focus mode. No engine spend — deterministic and repeatable.
Useful for screen recording the phase timeline or verifying orchestrate works.

${c.bold("Examples:")}
  vf demo
  vf demo --engine claude`,

  workflow: () => `${c.bold("vf workflow")} ${c.dim("<delete | delete-unit | import> …")}
Manage a saved workflow. Destructive paths are dry by default and print exactly what
they will touch before --yes applies them.

${c.bold("Subcommands:")}
  delete [--all] [--yes]                          remove the workflow (or everything with --all)
  delete-unit <name> [--repo <path>]              remove a single work unit
  import <src> [--on-collision rename|skip|replace] [--yes]   merge another workflow

${c.bold("Examples:")}
  vf workflow delete
  vf workflow import ../other-repo --yes`,

  units:
    () => `${c.bold("vf units")} ${c.dim("[status | show <name> | resources | evidence <name> | add <name> | update <name> | delete <name>]")}
Inspect and mutate work units in the workflow ledger.

${c.bold("Subcommands:")}
  status                                  list every unit and its gates (default)
  show <name>                             print one unit as JSON
  resources                               totals: units / tokens / cost / wall-seconds
  evidence <name>                         list a unit's recorded evidence
  evidence <name> --add "<text>"          append an evidence record to a unit
  add <name>                              add a new (pending) unit
  update <name> [--status s] [--confidence n]   patch a unit
  delete <name>                           remove a unit

${c.bold("Examples:")}
  vf units status
  vf units update auth --status done --confidence 1`,

  config: () => `${c.bold("vf config")} ${c.dim("memory <on|off|status>")}
Read or toggle per-repo settings in .vibeflow/SETTINGS.json.

${c.bold("Subcommands:")}
  memory status        print the current memory setting (default)
  memory on            enable the claude-mem memory feature
  memory off           disable the claude-mem memory feature

${c.dim("The memory setting records your claude-mem opt-in; it does not gate the `vf init` prompt.")}

${c.bold("Examples:")}
  vf config memory status
  vf config memory on`,

  skills: () =>
    `${c.bold("vf skills")} ${c.dim("[list | search <term> | resolve | validate | sync | verify-sync | import | init <name> | draft <name> | crystallize <run-id>]")}
Inspect locally discovered skills, validate the store, sync to engine mirrors,
import external skills, and capture new skills from real work.

${c.bold("Subcommands:")}
  list                       list discovered skills (default)
  search <term>              rank skills matching a task description
  resolve                    report which skill needs are satisfied locally vs. on demand
  validate                   validate skill format per Anthropic standard (errors, warnings)
  sync [--mode pointer|full] [--engine <name>] sync .vibeflow/skills → engine mirror (--engine can repeat; default copilot)
  verify-sync                verify engine mirror has every canonical skill (defaults to selected engine)
  import <dir-or-query>      import a local skill dir (or context7 query) into the canonical store
  init <name>                scaffold an empty SKILL.md stub
  draft <name>               capture a reusable procedure as a status:draft skill (never auto-installed)
  crystallize <run-id>       mechanically draft a skill from a run's recurring patterns

${c.bold("Examples:")}
  vf skills list
  vf skills search "read a pdf"
  vf skills validate
  vf skills sync --mode pointer
  vf skills draft fix-flaky-db-test
  vf skills import .vibeflow/skills/external-skill
  vf skills import context7:react-hooks`,

  tools:
    () => `${c.bold("vf tools")} ${c.dim("[status | enable <tool> | disable <tool> | install <tool> [--yes]]")}
Manage the optional code-navigation tools (codegraph, lsp).

${c.bold("Subcommands:")}
  status                  show enabled/installed/priority for each tool (default)
  enable <tool>           enable a tool and wire its MCP config
  disable <tool>          disable a tool and remove its MCP config
  install <tool> [--yes]  print the install plan; --yes executes it

${c.dim("tool = codegraph | lsp")}

${c.bold("Examples:")}
  vf tools status
  vf tools enable codegraph`,

  discover: () => `${c.bold("vf discover")} ${c.dim("<docs|skills> <query> [--yes]")}
Look up external docs or skills via Context7. The network is only touched with
explicit approval.

${c.bold("Options:")}
  --yes         approve the network lookup (otherwise prints an approval prompt)

${c.bold("Examples:")}
  vf discover docs react --yes
  vf discover skills "pdf reader" --yes`,

  hook: () => `${c.bold("vf hook")} ${c.dim("[--selftest]")}
Read a JSON hook event from stdin, score its risk, and print a decision
(allow / warn / require_approval / block) with the matching exit code.

${c.bold("Options:")}
  --selftest    run the fixed attack+benign corpus and write an audit report

${c.bold("Examples:")}
  echo '{"tool":"Bash","input":"rm -rf /"}' | vf hook
  vf hook --selftest`,

  hooks: () => `${c.bold("vf hooks")} ${c.dim("[status | install | emit [--yes] [--dry-run]]")}
Manage git/engine hook wiring (all hooks delegate to \`vf hook\`).

${c.bold("Subcommands:")}
  status     show the configured core.hooksPath (default)
  install    point git core.hooksPath at .githooks
  emit       write per-engine hook config files into the repo
             (dry-run by default; pass --yes to actually write)

${c.bold("Examples:")}
  vf hooks status
  vf hooks install
  vf hooks emit           ${c.dim("# dry-run: show what would be written")}
  vf hooks emit --yes`,

  verify: () => `${c.bold("vf verify")}
Run the project's toolchain gates (typecheck / lint / test, auto-detected for
npm/Gradle/monorepo) plus the policy gates (confidence / evidence / scope) over the
workflow ledger. Returns nonzero if any gate fails.

${c.bold("Examples:")}
  vf verify`,

  pr: () => `${c.bold("vf pr")} ${c.dim("<create|queue|merge-when-green> [options]")}
Open, queue, or auto-merge GitHub pull requests from the active branch.

${c.bold("Subcommands:")}
  create <issue>       open a PR linked to the given issue reference (e.g. #173)
  queue                add the current branch to the merge queue
  merge-when-green     set auto-merge once all checks pass

${c.bold("Examples:")}
  vf pr create #173
  vf pr create #173 --yes
  vf pr queue
  vf pr merge-when-green`,

  state: () => `${c.bold("vf state")} ${c.dim("[brief] [--consult]")}
Read the coordinator brief — the durable cross-session memory the coordinator
consults before any non-trivial action.

${c.bold("Subcommands:")}
  brief          print the brief + "what changed since last consult"
  brief --consult  same, and write the current timestamp as .last-consult

${c.bold("Examples:")}
  vf state brief
  vf state brief --consult`,

  coord: () => `${c.bold("vf coord")} ${c.dim("[--no-coord]")}
Enforce the coordinator brief freshness gate. Refuses when the brief is
missing, malformed, or older than 10 minutes. Used by \`vf init\` automatically.

${c.bold("Examples:")}
  vf coord`,

  decision:
    () => `${c.bold("vf decision")} ${c.dim('[add --title "<t>" --context "<c>" --decision "<d>" [--consequences "<x>"] | list]')}
Record durable architecture/process decisions (ADR-lite) in
.vibeflow/knowledge/decisions.md — separate from the noisy work journal.

${c.bold("Subcommands:")}
  add   record a decision; --title, --context, --decision required (--consequences optional)
  list  print the decision log (default)

${c.bold("Examples:")}
  vf decision add --title "Use YAML frontmatter" --context "Anthropic spec" --decision "Keep YAML"
  vf decision list`,
};

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

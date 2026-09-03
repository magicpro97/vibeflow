import { skillsCommandHelp } from "../help/skills-command-help.js";
import {
  ASK_HELP,
  BRAINSTORM_HELP,
  CHAT_HELP,
  DEFAULT_UI_PORT,
  EPHEMERAL_UI_PORT,
  SUPERPOWERS_HELP,
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY,
  UI_LAN_TOKEN_HEADER,
  authorityCommandHelp,
  c,
  capabilityCommandHelp,
} from "./_shared.js";
export const COMMAND_HELP: Record<string, () => string> = {
  superpowers: SUPERPOWERS_HELP,
  chat: CHAT_HELP,
  brainstorm: BRAINSTORM_HELP,
  ui: () => `${c.bold("vf ui")} ${c.dim("[--port <n>] [--host <addr>] [--no-open]")}
Open AI-first Home: the searchable session rail, central chat, durable queue,
participant details, capabilities, settings, and trace. Repository intake is the
TTY questionnaire in \`vf init\`; it is not a \`vf ui\` mode.

Bare \`vf\` and explicit \`vf ui\` both use stable port ${DEFAULT_UI_PORT}. Pass
\`--port ${EPHEMERAL_UI_PORT}\` when you explicitly want an OS-selected free port.

${c.bold("Options:")}
  --port <n>    bind to a specific port (default: ${DEFAULT_UI_PORT}; ${EPHEMERAL_UI_PORT} selects a free port)
  --host <addr> bind to a specific host (default: 127.0.0.1)
  --no-open     start the server without launching a browser

${c.bold("LAN boundary:")}
  Any non-loopback --host exposes the server. The owner browser receives a single-use
  bootstrap URL; unauthenticated root loads return 401, and --no-open prints that URL once.
  Legacy fetch/API CSRF checks require the ${UI_LAN_TOKEN_HEADER} header. Browser EventSource
  cannot set custom headers, so non-conversation streams use the
  ${UI_LAN_EVENT_SOURCE_TOKEN_QUERY} query parameter. Page authority never authenticates
  Conversation Home: its JSON and stream routes return 401. Hook approval uses a separate
  loopback-only listener discovered without storing a bearer. Use loopback for conversations.

${c.bold("Examples:")}
  vf                    # port ${DEFAULT_UI_PORT}
  vf ui                 # same stable default
  vf ui --port ${EPHEMERAL_UI_PORT}        # ephemeral free port
  vf ui --port 4173 --no-open
  vf ui --host 0.0.0.0 --port ${DEFAULT_UI_PORT}`,
  doctor: () => `${c.bold("vf doctor")} ${c.dim("[--probe] [--refresh] [--fix]")}
Check required (node, git) and optional (bun, engine CLIs, docker) tools, plus
per-engine readiness and owned CLI process records.
PID alone is never ownership proof; repair requires an exact dead-or-mismatched identity.

${c.bold("Options:")}
  --probe       run a live engine round-trip instead of a presence/auth check
  --refresh     invalidate cached readiness and probe again
  --fix         repair only exact proved orphan records; uncertain/live owners fail closed

${c.bold("Examples:")}
  vf doctor
  vf doctor --probe
  vf doctor --refresh
  vf doctor --fix`,

  init: () => `${c.bold("vf init")} ${c.dim("[--engine <claude|codex|copilot|opencode|antigravity>] [--no-ask] [--no-ai] [--no-hooks] [--dry-run]")}
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

  run: () => `${c.bold("vf run")} ${c.dim("<claude|codex|copilot|opencode|antigravity> [--yes]")}
Write the dispatch prompt for one engine. Without --yes it is a read-only dry run;
--yes launches the engine CLI behind the source-protection gate.

${c.bold("Options:")}
  --yes               launch and auto-approve installable pinned-registry skill acquisitions; scan blocks still apply
  --auto-wip          snapshot a dirty tree before launching instead of refusing
  --require-git       refuse to launch outside a git repo
  --rollback-on-fail  reset the tree to the pre-dispatch checkpoint on failure

${c.bold("Examples:")}
  vf run claude
  vf run codex --yes
  vf run opencode --yes
  vf run antigravity --yes`,

  ask: ASK_HELP,

  orchestrate:
    () => `${c.bold("vf orchestrate")} ${c.dim("[--engine <e>] [--yes] [--concurrency <n>] [--risk <class>] [--focus]")}
Dispatch every saved work unit (bounded-parallel), run an independent reviewer,
record evidence, then evaluate the goal. Blocked units are skipped and logged.
Default mode is a read-only dry run.

${c.bold("Options:")}
  --engine <e>        target engine (default: copilot)
  --yes               real run; auto-approve installable pinned-registry skill acquisitions; scan blocks still apply
  --concurrency <n>   max units dispatched in parallel
  --risk <class>      docs | simple-code | feature | architecture | security | deploy
  --auto-wip / --require-git / --rollback-on-fail   source-protection toggles
  --security-check    opt-in to the post-coding security checkpoint (PR #160)
  --isolate           dispatch each unit in its own git worktree (cli only; off by default)
  --no-unit-gate      skip the per-unit typecheck+biome gate (final bun run check still runs)
  --pr                after a unit's review passes, open a QUEUED PR for it (needs --isolate; never merges)
  --resume            resume crashed units by validated native id for claude, codex, or opencode; other engines never claim exact resume

${c.bold("Examples:")}
  vf orchestrate
  vf orchestrate --engine codex --yes --concurrency 2
  vf orchestrate --engine codex --yes --concurrency 3 --isolate --pr`,

  review:
    () => `${c.bold("vf review")} ${c.dim("<evidence --base <full-SHA> --result <file> | check --base <full-SHA>>")}
Create or validate current-HEAD review evidence. The producer accepts only a bound
reviewer result for the exact base SHA, head SHA, sorted name-status manifest, and
SHA-256 digest observed by the recorder; stale or generic pass JSON fails closed.

${c.bold("Subcommands:")}
  evidence --base <sha> --result <file>   validate the bound reviewer JSON and record evidence
  check --base <sha>                     validate current-HEAD evidence (docs-only fallback applies)

${c.bold("Reviewer result fields:")}
  schemaVersion, baseSha, headSha, changed, changedDigest,
  status, exitCode, timedOut, findings

${c.bold("Examples:")}
  vf review evidence --base <full-SHA> --result review-result.json
  vf review check --base <full-SHA>`,

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

  canary: () => `${c.bold("vf canary")} ${c.dim("<list | link <unit> <file> | check>")}
Manage human-authored canary tests (ADR-005). A knowledge-heavy unit cannot close
without a linked canary whose author differs from the dispatch engine — the
human-in-the-loop escape hatch for the confident-wrongness ceiling.

${c.bold("Subcommands:")}
  list                     list every test/**/*.canary.test.ts + which unit it covers (default)
  link <unit> <file>       link a canary to a unit (records git-blame author; refuses self-authored)
  check                    report knowledge-heavy done units missing a human canary

${c.bold("Convention:")} canary files live at test/**/*.canary.test.ts and declare a
  \`// canary-scope: <path>,<path>\` header so \`list\` can match them to a unit.

${c.bold("Examples:")}
  vf canary list
  vf canary link auth test/auth.canary.test.ts
  vf canary check`,

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

  status: () =>
    `${c.bold("vf status")} ${c.dim("[--timeline <unit>] [--json]")}
Crash-recovery view of per-unit progress. Reads the persisted markers under
~/.vibeflow/markers (no re-run) to show which units were running at a crash and
which claimed done but never published evidence.

${c.bold("Options:")}
  --timeline <unit>   dump a unit's append-only status-transition ledger
  --json              emit the raw marker array (machine-readable)`,

  config: () => `${c.bold("vf config")} ${c.dim("<memory|env-policy> ...")}
Read or toggle per-repo settings in .vibeflow/SETTINGS.json.

${c.bold("Subcommands:")}
  memory status        print the current memory mode (default)
  memory builtin       enable built-in memory (vibeflow native)
  memory claude-mem    enable claude-mem integration
  memory on            alias for builtin (backward compat)
  memory off           disable memory
  env-policy status    print the effective env-scrub policy for spawned engines
  env-policy deny <g>  add a glob to drop from the spawned engine env (e.g. FOO_*)
  env-policy allow <g> add a glob to an allowlist (switches to strict pass-only mode)
  env-policy reset     clear the configured policy (back to conservative default)

${c.dim("memory picks the backend; env-policy (#556) scrubs host secrets from the env handed to spawned agent CLIs.")}

${c.bold("Examples:")}
  vf config memory status
  vf config memory builtin
  vf config env-policy status
  vf config env-policy deny 'MY_APP_*'`,

  capability: capabilityCommandHelp,

  authority: authorityCommandHelp,

  skills: skillsCommandHelp,

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
  status     show core.hooksPath plus live guardrail status (default)
  install    install fail-closed pre-commit + pre-push hooks and point core.hooksPath at .githooks
  emit       write per-engine hook configs (dry-run; --yes writes)

${c.bold("Examples:")}
  vf hooks status
  vf hooks install
  vf hooks emit           ${c.dim("# dry-run: show what would be written")}
  vf hooks emit --yes`,

  verify:
    () => `${c.bold("vf verify")} ${c.dim("[--coverage] [--review-base <full-SHA>] [--journal] [--sandbox docker --sandbox-image <digest> --sandbox-volume <name>]")}
Run auto-detected toolchain + policy gates; nonzero when any gate fails.
Sandbox runs offline over a disposable copy, without host env/network. Image must be local
and digest-pinned; dependency volume must be labeled with lockfile SHA-256. Fails closed.

${c.bold("Options:")}
  --coverage                require coverage/lcov.info and run scripts/coverage-gate.cjs
  --review-base <full-SHA>  bind the pushed range used by review-evidence validation
  --journal                 append this verification result to the work journal
  --sandbox docker          run gates in the configured disposable Docker sandbox

${c.bold("Examples:")}
  vf verify --coverage --review-base <full-SHA>
  vf verify --sandbox docker --sandbox-image registry/vf@sha256:<digest> --sandbox-volume vf-deps-<lock-sha>`,

  eval: () => `${c.bold("vf eval")} ${c.dim("[--min-pass-rate <0..1>] [--min-samples <n>] [--json] [--out <file>]")}
Read the verdict/verify telemetry vf already writes during normal use, aggregate a
real success-rate + gate breakdown + cost, and (with a threshold) exit 1 when the
pass-rate is below it. This is a PASSIVE regression gate over dogfood telemetry — NOT
a fixed benchmark. Wire it into pre-push/CI. Thin samples (< --min-samples) warn
instead of failing, so a handful of hard tasks never trips a false regression.

${c.bold("Options:")}
  --min-pass-rate <0..1>   fail (exit 1) when the verdict pass-rate is below this
                           (else read from settings.eval.minPassRate; absent = report only)
  --min-samples <n>        floor below which eval warns instead of failing (default 10)
  --json                   print the report as JSON to stdout
  --out <file>             also write the JSON report to a file

${c.bold("Exit codes:")} 0 = ok / no threshold / thin samples · 1 = below threshold with enough samples

${c.bold("Examples:")}
  vf eval
  vf eval --min-pass-rate 0.9
  vf eval --json --out eval-report.json`,

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

  "update-check": () => `${c.bold("vf update-check")}
Check the npm registry for a newer VibeFlow release and print how to upgrade.
Set ${c.cyan("VIBEFLOW_NO_UPDATE_CHECK=1")} to silence daily interactive-shell nudges.

${c.bold("Examples:")}
  vf update-check`,
};

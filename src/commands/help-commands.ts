import { c } from "./_shared.js";

export const COMMAND_HELP: Record<string, () => string> = {
  ui: () => `${c.bold("vf ui")} ${c.dim("[--port <n>] [--host <addr>] [--no-open]")}
Open the local web UI (intake wizard + workflow console). This is also the default
command when you run \`vf\` with no arguments.

${c.bold("Options:")}
  --port <n>    bind to a specific port (default: an ephemeral free port)
  --host <addr> bind to a specific host (default: 127.0.0.1; use 0.0.0.0 for LAN access)
  --no-open     start the server without launching a browser

${c.bold("Examples:")}
  vf
  vf ui --port 4173 --no-open
  vf ui --host 0.0.0.0 --port 7799`,

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

  ask: () => `${c.bold("vf ask")} ${c.dim('<path>:<start>[-<end>] "<question>" [--engine <e>] [--resume]')}
Inline code Q&A: read a line range, frame it (file + language-fenced snippet +
your question), and stream a ready engine's answer straight to the terminal.
Reuses vf's engine-readiness selection; no chat app, no copy-paste.

${c.bold("Options:")}
  --engine <name>   force claude | codex | copilot | opencode | antigravity (must be ready); else the
                    first ready engine in priority order is used
  --resume          continue the engine's MOST RECENT conversation with a
                    follow-up question (no target needed) — claude/codex/opencode/antigravity

${c.bold("Examples:")}
  vf ask src/cli.ts:210-267 "what does this switch do?"
  vf ask src/dispatch.ts:172 "why the json output format?" --engine claude
  vf ask --resume "ok, and is that thread-safe?"`,

  orchestrate:
    () => `${c.bold("vf orchestrate")} ${c.dim("[--engine <e>] [--yes] [--concurrency <n>] [--risk <class>] [--focus]")}
Dispatch every saved work unit (bounded-parallel), run an independent reviewer,
record evidence, then evaluate the goal. Default mode is a read-only dry run.

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
  --resume            resume crashed units from their persisted engine session (claude + codex) instead of re-running fresh

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

  skills: () =>
    `${c.bold("vf skills")} ${c.dim("[list | search <term> | resolve | validate | sync | verify-sync | verify-freshness | verify-lock | import | init <name> | draft <name> | crystallize <run-id> | curator scan [--scope=local|repo] | eval <skill-dir> | update-dependent <canonical-skill> | semantic-filter [--max-reviews N] [--reviewer ID] | registry <add|list|update|install>]")}
Inspect locally discovered skills, validate the store, sync to engine mirrors,
import external skills, capture new skills from real work, manage remote
skill registries via git-backed lock files, and run skill trigger/task evals.

${c.bold("Subcommands:")}
  list                       list discovered skills (default)
  search <term>              rank skills matching a task description
  resolve                    report which skill needs are satisfied locally vs. on demand
  validate                   validate skill format per Anthropic standard (errors, warnings)
  sync [--mode pointer|full] [--engine <name>] sync .vibeflow/skills → engine mirror (--engine can repeat; default copilot)
  verify-sync                verify engine mirror has every canonical skill (defaults to selected engine)
  verify-freshness           check sourceAnchors against current disk content (SHA-256)
  verify-lock                verify registry lock integrity, marketplace schema, and mirror completeness
  import <dir-or-query>      import a local skill dir (or context7 query) into the canonical store
  init <name>                scaffold an empty SKILL.md stub
  draft <name>               capture a reusable procedure as a status:draft skill (never auto-installed)
  curator scan [--scope=local|repo] [--sync] [--yes]  scan: local default is private; repo anchors clean HEAD; --sync previews notes sharing; --yes syncs origin notes
  eval <skill-dir>           eval cases; semantic-filter [--max-reviews N] [--reviewer ID] finds pairs (reviews execute only when BOTH flags set, N>0; opt-in/no network)
  registry <add|list|update|install> manage remote skill registries (git-backed) — see below

${c.bold("Registry subcommands:")}
  registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]
                             clone a remote skill registry and pin to a commit
  registry list              list pinned skill registries from the lock file
  registry update [<id>] [--yes]
                             re-fetch and re-pin every registry (or a single one);
                             on failure the prior commit is preserved in the lock
  registry install <registry-id>/<skill-name> [--version <v>] [--on-collision skip|replace|rename] [--yes]
                              install a verified skill from a cached registry into the shared catalog
  propose-merge <skill-a> <skill-b>
                              produce a non-destructive merge proposal (stdout, no files written)
  propose-split <skill-name>
                              produce a non-destructive split proposal (stdout, no files written)

${c.bold("Registry options:")}
  --yes                      approve the network call (git clone/fetch) — dry-run without it
  --on-collision skip|replace|rename
                             collision policy when skill already installed (default: skip)

${c.bold("Registry install options:")}
  --version <v>              require a specific marketplace version (error on mismatch)
  --on-collision skip        leave existing skill untouched (default)
  --on-collision replace     backup existing to .backup/<ts>/, then overwrite
  --on-collision rename      copy with a new slug, rewrite SKILL.md name: frontmatter

${c.bold("Security scan:")}
  Before catalog copy runs an optional SkillSpector scan (static, --no-llm).
  Absent scanner → proceed (scan_summary: {scanned:false} in lock);
  HIGH/CRITICAL → blocked before copy, lock unchanged;
  MEDIUM → warn, install continues. See docs/SKILL_SECURITY_SCAN.md.

${c.bold("Examples:")}
  vf skills list
  vf skills search "read a pdf"
  vf skills validate
  vf skills sync --mode pointer
  vf skills draft fix-flaky-db-test
  vf skills import .vibeflow/skills/external-skill
  vf skills import context7:react-hooks
  vf skills eval .vibeflow/skills/pdf-reader
  vf skills eval .vibeflow/skills/pdf-reader --engine opencode --json --out eval-result.json
  vf skills eval .vibeflow/skills/pdf-reader --previous eval-result.json
  vf skills registry add https://github.com/x/skills.git --name platform --ref v1.0
  vf skills registry add https://github.com/x/skills.git --name platform --ref v1.0 --yes
  vf skills registry list
  vf skills registry update --yes
  vf skills registry update platform --yes
  vf skills registry install platform/my-skill
  vf skills registry install platform/my-skill --version 1.0.0 --on-collision replace --yes`,

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
    () => `${c.bold("vf verify")} ${c.dim("[--sandbox docker --sandbox-image <digest> --sandbox-volume <name>]")}
Run auto-detected toolchain + policy gates; nonzero when any gate fails.
Sandbox runs offline over a disposable copy, without host env/network. Image must be local
and digest-pinned; dependency volume must be labeled with lockfile SHA-256. Fails closed.

${c.bold("Examples:")} vf verify
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

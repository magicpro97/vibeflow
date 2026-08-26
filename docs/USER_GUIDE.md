---
title: User Guide
description: Verifiable end-to-end user guide for the AI-first Home, workflows, traced conversations, the web UI, CLI, generated files, and troubleshooting.
category: tutorial
last_updated: 2026-08-26
---

# VibeFlow User Guide

## Contents

- [1. Install](#1-install)
- [2. Mental Model](#2-mental-model)
- [3. The Web UI (Recommended)](#3-the-web-ui-recommended)
- [4. The CLI](#4-the-cli)
- [5. End-to-End Walkthrough (Verifiable)](#5-end-to-end-walkthrough-verifiable)
- [6. Generated Files](#6-generated-files)
- [7. Troubleshooting](#7-troubleshooting)

VibeFlow is a local-first CLI (`vf`) that opens a web UI and coordinates Claude Code,
Codex CLI, GitHub Copilot CLI, OpenCode, and Antigravity CLI (`agy`) through shared context,
Anthropic-style skills, hooks, and verification. It never lets an engine work blindly: it
scans your repo, resolves the skills a task needs **on demand**, plans non-overlapping work
units, dispatches them in parallel, and refuses to "complete" anything without recorded
evidence.

This guide is verifiable end to end — every section ends with a command whose output you
can check.

## Engine matrix

The runtime names in this tree are Claude, Codex, Copilot, OpenCode, and Antigravity. The
conversation/runtime matrix is:

| Engine | Fresh execution | Tool/sandbox enforcement | Exact native resume | History reconciliation | Phase/admission |
|--------|-----------------|--------------------------|---------------------|------------------------|-----------------|
| Claude | yes | full | yes | supported | Phase 1 built-in read-only yes; phase 2+ yes |
| Codex | yes | partial: sandbox yes, rendered tools denied | yes | supported | Phase 1 built-in read-only yes; phase 2+ yes |
| Copilot | yes | full | unavailable; no native resume path | unavailable | Phase 1 no; phase 2+ yes when ready/admitted |
| OpenCode | yes | no: conversation launches reject requested tools or sandbox | no exact-id resume; most-recent `--continue` only | unavailable | Phase 1 no; phase 2+ only when the binding does not need tool/sandbox enforcement |
| Antigravity | yes | no: conversation launches reject requested tools or sandbox | yes (`--conversation <conversation_id>`) | unavailable | Phase 1 no; phase 2+ only when the binding does not need tool/sandbox enforcement |

---

## 1. Install

```bash
npx @magicpro97/vibeflow            # run without installing
npm install -g @magicpro97/vibeflow # or install globally, then use `vf`
```

Requirements: Node ≥ 18 and git. Engines (Claude Code / Codex / Copilot CLI / OpenCode / Antigravity `agy`) are optional
— VibeFlow detects what you have and degrades gracefully. Context7 discovery needs no
extra install (it rides the built-in `fetch`); an optional `CONTEXT7_API_KEY` raises the
rate limit.

Verify:

```bash
vf doctor            # presence/auth check
vf doctor --probe    # also run a live "reply READY" round-trip per engine
vf doctor --refresh  # discard the probe-result cache and re-probe immediately
```

You should see ✓/• marks for node, git, bun, claude, codex, copilot, agy, docker, plus an
"Engine readiness" block. With `--probe` each engine is launched once with a trivial
prompt and must reply `READY` — proving auth and a working CLI end to end.

---

## 2. Mental model

```text
intake + scan  →  resolve skill NEEDS  →  plan work units  →  dispatch (parallel)
                                                                   ↓
                       goal-eval  ←  verify gates  ←  reviewer  ←  evidence
```

- **Orchestrator** — the main agent. Plans, splits, judges. Never writes code itself.
- **Work unit** — a scoped slice of the task (`.vibeflow/workunits/<name>/`) with its own
  gates, evidence, and resource counters. Scopes must not overlap so units run in parallel.
- **Skill** — an Anthropic skill-creator folder (`SKILL.md` + optional `scripts/`,
  `references/`). VibeFlow **discovers, validates, and matches** skills; the engine runs
  them. Nothing is pre-installed — skills are acquired on demand and start `unverified`.
- **Confidence gate** — any decision below `1.0` triggers bounded investigation/debate;
  no merge or close on a guess.

---

## 3. The web UI (recommended)

```bash
vf            # or: vf ui
```

Opens `http://127.0.0.1:<port>` (loopback only). The default surface is AI-first Home:

1. **Searchable session rail** — recent conversations, search, and **New conversation**.
2. **Central conversation pane** — topic, lifecycle state, participant avatars, and live stream status.
3. **Composer** — durable FIFO queue, ArrowUp edit of the latest queued human message, private file range, and capability chooser.
4. **Details inspector** — participants, continuity, lineage, and health.
5. **Trace / capabilities drawers** — ordered public trace, evidence, and typed CLI capability actions.
6. **Intake wizard** — when you run `vf init --interactive`, the UI switches to repo setup: path, goal, engines, sources, attachments, and Definition of Done.

Security: the server binds to `127.0.0.1`, every write carries a per-process CSRF token,
the Host/Origin must be loopback, uploads are sanitized and size-capped, and the page ships
no third-party JavaScript under a strict CSP.

### Conversation workspace

Choose a session in the rail and use it immediately, or select **New conversation**. Search
filters the rail without changing the active session. The center timeline remains the source
of truth while details, trace, and capability drawers open alongside it.

The composer keeps collaboration inside the conversation:

1. Send another message while agents are working; it joins the durable FIFO queue instead of
   interrupting or replacing an earlier send.
2. Press ArrowUp with an empty composer to edit the latest queued human message. Press Escape
   to cancel. If dispatch wins the race before the edit commits, the draft is preserved and
   the UI offers an explicit send-as-new action.
3. Select **Agent** to add a participant. Select **Remove** or the `−` action beside a
   participant in **Details** to prepare `-@participant`; submit it in chat so the removal is
   visible and auditable. `@` mentions target participants without leaving the composer.
4. Quote one through eight visible messages, including messages from different sources.
   Quote chips preserve order and can be moved, removed, or used to jump to their source.
5. React with the small supported set: 👍, 👎, ❤️, 🎉, 👀, 🤔, ✅, or ❗. Reactions are
   typed conversation data, not prompt text; agents are capped at three distinct non-self
   reactions so the social layer stays useful.
6. Resolve approval, cancellation, installation, repair, and other capability cards inline.
   A `409` means another operation won the race; reload the current state instead of retrying
   blindly.

If a stream disconnects, Home renews its short-lived token and resumes after its last
confirmed sequence. Duplicate replay/live events are ignored by `seq`. Sending to an active
conversation steers it; sending to a completed conversation creates a child revision and
shows the parent link. **Trace** exposes sanitized public correlation fields. Public result
and approval `artifact_refs` remain distinct from the opaque `ref` used to preview bytes.

Conversation credentials have separate jobs. The browser receives an `HttpOnly`,
`SameSite=Strict` session cookie for JSON and artifact requests; loopback writes also carry
the page's per-process CSRF token. SSE uses a different, 15-minute token scoped to one
conversation. Neither token is stored in `localStorage` or `sessionStorage`, and provider
credentials, native session ids, internal/provider prompts, environment values, and local
artifact paths are not public DTO fields. The conversation workspace fails closed on LAN-bound
`vf ui --host 0.0.0.0`; use the loopback UI for conversations.

The public trace does contain the user's topic and messages plus engine responses after
redaction. “Prompts are private” refers specifically to internal role/provider templates and
the rendered provider prompt; those implementation inputs never become public trace fields.

### Typed evidence

Each work unit's recorded evidence is classified and rendered by type:

- **File** (`path` or `path:line`) — shown as a 📄 click-to-open link. Clicking fetches the
  file through a token-guarded, loopback-only route that is **sandboxed to the repo root**:
  `..` traversal, absolute paths, `~`, and symlinks escaping the repo are all rejected, files
  over 256 KB and binaries are refused, and the content is always returned as JSON and
  rendered as inert text (never executed).
- **Command** (`$ …`, `vf …`, `bun …`, `npm …`, `git …`) — shown with a `$` badge.
- **Test** (`12 pass`, `3 fail`, acceptance tails) — shown with a ✓/✗ badge.
- **Text** — anything else falls back to plain monospace.

### Status timeline

Each unit records an **append-only transition ledger** at
`~/.vibeflow/markers/<unit>.timeline.jsonl` — one JSONL line per status change, derived from
vf's own marker updates (status, timestamp, confidence, evidence count). Expand a work unit's
row and the ledger is surfaced beneath its evidence as an ordered list — a status dot, the
status, and a relative timestamp (`2m ago`), oldest first. The read route is token-guarded and
loopback-only, and the unit name is sanitized (no `/`, `\`, `..`, or NUL); a fresh unit with no
transitions yet simply shows nothing.

---

## 4. The CLI

### Generate context

```bash
vf init                       # scan repo + generate canonical context for all engines
vf init --engine claude       # only Claude Code files
vf init --interactive         # ask the intake questions in the terminal
vf init --memory              # force the claude-mem install (skip the prompt)
vf init --no-memory           # skip the claude-mem install (skip the prompt)
vf init --dry-run             # show what would be written
# per-role agent files are written alongside the engine files when a per-role
# renderer is available (see src/agents/render.ts); see AGENT_ORCHESTRATION_POLICY.md
```

On a TTY, `vf init` asks whether to install **claude-mem** so engines can recall
past specs and decisions (`Install claude-mem for spec/plan recall? (Y/n)`, default
yes). On yes it installs claude-mem and appends a usage guide to
`WORKFLOW_POLICY.md`. The answer is saved to `settings.memory`; toggle it later with
`vf config memory <mode>` (a read-only `vf config memory status` prints the current
state). `--memory` / `--no-memory` skip the prompt.

**Memory modes** (default: `false` / off):

| Mode | What it does |
|------|-------------|
| `off` / `false` | No recall — nothing injected into prompts (default) |
| `builtin` | Zero-config BM25/FTS5 recall from `.vibeflow/knowledge/decisions.md` via `bun:sqlite`; lazy-indexed on mtime; generates `.vibeflow/knowledge/memory.db` (gitignored) |
| `claude-mem` | Shells `claude-mem search`; requires `claude-mem` installed separately |

Enable builtin recall:

```bash
vf config memory builtin
```

Enable claude-mem (external):

```bash
vf config memory claude-mem   # requires: npm i -g claude-mem (or vf init --memory)
```

Disable:

```bash
vf config memory off
```

`vf init --ai` runs the AI enrichment phase on top of the deterministic
context. The chosen engine is the first ready one in priority order
(`claude > copilot > codex > opencode > antigravity`), unless `--engine` is set.

```bash
vf init --ai                                # auto-pick the best engine
vf init --ai --engine copilot              # force a specific engine
vf init --ai --autopilot                   # fall back to next-best if engine fails
vf init --ai --engine copilot --autopilot  # ask for copilot, fall back to claude/codex if it errors
```

`--autopilot` retries with the next-best ready engine when the chosen
engine is unavailable or returns a permission error. Capped at 3
fallbacks; never retries the same engine twice. Off by default — the
single-shot failure mode is preserved unless you opt in. See
`docs/COVERAGE.md` for the full reference.

`init` scans the repo (README, manifests, lockfiles, CI) and writes `.vibeflow/*` plus the
engine files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`). It runs a live
readiness probe first and **refuses to create a workflow when no engine is ready** —
engines that fail the probe are skipped, files are written only for ready ones (`--dry-run`
skips the gate). Verify:

```bash
cat .vibeflow/PROJECT_CONTEXT.md     # contains a "## Detected stack" section
```

### Ask, chat, and brainstorm

Use `ask` for a file-range question, `chat` for the canonical persisted conversation, and
`brainstorm` when you explicitly want the debate policy:

```bash
vf ask src/server.ts:130-180 "what protects these routes?"
vf ask --conversation conversation-123 "which failure is fail-closed?"
vf ask --conversation conversation-123 --resume "keep going"
vf ask --conversation conversation-123 src/server.ts:130-180 "revise this explanation"

vf chat "Explain the release flow"
vf chat --policy plan --participant planner@codex --max-rounds 2 "Plan the migration"
vf chat --resume conversation-123 "Revise step two"

vf brainstorm "Compare two storage designs"             # deterministic dry run
vf brainstorm --yes --max-rounds 3 "Compare two storage designs"
vf brainstorm --yes --no-baseline --json "Compare designs"
```

`ask` stages the selected file range as private context and then routes the follow-up through
the durable conversation runtime. Public turns use the canonical `VF-TURN/1` JSON envelope;
private file ranges use a separate `VF-PRIVATE-FILE-RANGES/1` JSON payload that is cleared
after the turn. The private payload is not written into public trace or browser persistence.
`--conversation <id>` is the explicit persisted path and `--resume` is compatibility-only:
it requires `--conversation` and never targets a native latest-session resume path. Claude,
Codex, OpenCode, and Antigravity support native session resume in their own CLI paths;
Copilot reports that path as unavailable.

For an exact proved native resume, the CLI retains its own history and VibeFlow supplies only
new applicable user messages plus peer-agent responses and reactions. The recipient's own
prior output is not repeated. Missing or stale cursor proof falls back to the full applicable
public handoff. Claude, Codex, and OpenCode receive prompts on stdin; Copilot and Antigravity
receive native prompt argv. A large Copilot work-unit prompt may be written to
`.vibeflow/dispatch/<unit>.md` and replaced on argv by a short absolute read pointer. That
prompt file is a transport fallback, not a resumable session or memory store. Antigravity
rejects prompts at or above 30 KiB because its print mode has no supported file/stdin
replacement.

`chat` accepts `--policy`, repeated `--participant <role@engine[:model]>`,
`--max-rounds`, `--resume`, `--no-baseline`, and `--json`. `brainstorm` accepts repeated
participants, `--max-rounds`, `--resume`, `--no-baseline`, `--json`, and `--yes`. A new
brainstorm is dry-run by default; only `--yes` dispatches engines. A resumed brainstorm
continues immediately. `--max-rounds` is bounded to `1..100`.

Resume does not reuse creation settings. `chat --resume` rejects `--policy`, `--participant`,
`--max-rounds`, and `--no-baseline`; `brainstorm --resume` rejects `--participant`,
`--max-rounds`, and `--no-baseline`. This is a validation error, not silent option dropping.

For scripts, `--json` emits exactly one JSON document on stdout and suppresses streamed
deltas. Brainstorm dry runs report resolved participants, whether the evaluator was added,
engine availability, and model validity. Executed brainstorms report every completed round,
consensus, deterministic decision matrix, baseline comparison, and an authenticated opaque
transcript URL derived from `artifact_created.payload.ref`; that URL is fetchable through the
authenticated artifact route. Exit codes are `0` success/dry-run/stopped, `1` validation,
`2` engine start, `3` transport, `4` failed, and `5` aborted. See the
[Command Reference](./COMMAND_REFERENCE.md#conversations) for the exact JSON fields and HTTP
contract.

A plan paused at its approval gate is accepted, not failed: JSON reports
`status: "awaiting_approval"` with its current artifact references and the command exits `0`.
Resolve it from the inline Home action card or HTTP API before the workflow continues.

Those stable codes apply to `chat`, `brainstorm`, and persisted asks. `ask --resume` passes
through the engine process status, while legacy local ask/readiness errors return `2`;
`ask` does not offer JSON output.

### Resolve which skills a task needs (demand-driven)

```bash
vf skills list           # skills discovered under .vibeflow/.claude/.agents/.github skills dirs
vf skills search xlsx    # rank local skills against a term
vf skills resolve        # derive NEEDS from the scan + intake; show satisfied vs missing
vf skills validate       # validate every canonical skill against the Anthropic standard
vf skills sync           # regenerate engine mirrors from .vibeflow/skills/ (default: pointer)
vf skills verify-sync    # check each mirror has a SKILL.md for every canonical skill
```

To pin and install Superpowers into installed native engine CLIs:

```bash
vf skills registry add obra/superpowers --ref <tag-or-commit> --yes
vf superpowers sync            # read-only preview; no model probe or config write
vf superpowers sync --yes      # exact locked commit via Claude/Codex/OpenCode native mechanisms
```

The apply step preserves unrelated engine config, disables optional Superpowers telemetry by
default without overriding an explicit user value, and continues other engines when one fails.

Example `vf skills resolve` output:

```text
• xlsx-reader  (attachment data.xlsx) — missing — vf discover skills xlsx --yes
• Next.js docs (detected framework Next.js) — missing — vf discover docs Next.js --yes
```

### Discover external docs/skills (approval-gated)

```bash
vf discover docs next.js          # prints "approval required"
vf discover docs next.js --yes    # Context7 HTTP lookup; imports are experimental
vf discover skills pdf --yes
```

Discovery uses the Context7 HTTP API via the built-in `fetch` (no `ctx7` binary), only
reaches the network with `--yes`, and fails gracefully when offline.

### Optional code-navigation tools

```bash
vf tools status                  # what's enabled/installed + the priority ladder
vf tools install codegraph --yes # run the install plan (prints it without --yes)
vf tools enable codegraph        # wire it into each engine's MCP config
vf tools disable lsp             # turn off + remove its MCP servers
```

Two opt-in tools (both off by default) give engines better code navigation: **codegraph**
(a local code-graph MCP server) and **lsp** (an MCP↔language-server bridge, one server per
detected language). Enabling a tool flips it in `.vibeflow/SETTINGS.json` and wires MCP
config per engine — it merges `.mcp.json` for Claude, writes `.codex/config.toml` (with
`disabled_tools` gating) for Codex, and prints `copilot mcp add` commands for you to run.
The preference order **codegraph > lsp > native** is injected into the engine instruction
files. Re-run `vf init` after changing tools to regenerate them.

### Dispatch and orchestrate

```bash
vf run claude                 # write .vibeflow/dispatch/claude.md (dry)
vf run claude --yes           # launch the Claude Code CLI

vf orchestrate                # plan + dispatch work units (dry: prompts only)
vf orchestrate --engine codex --concurrency 4
vf orchestrate --yes          # real dispatch through the engine CLI
```

`orchestrate` dispatches every work unit through a bounded parallel pool, runs an
independent reviewer (a unit only passes at confidence `1.0` with evidence), then the
orchestrator-only goal-eval prints `met | partial | blocked`.

Before `run` or `orchestrate` launches an agent, an exact verified match in a configured
pinned registry cache appears as an approval card with security scan status. Card creation
is read-only and offline. `--yes` auto-approves installable cards; TTY/Web UI can decide
explicitly; non-TTY without consent never waits. HIGH/CRITICAL stays blocked. Approved
skills use the normal install and re-scan path without gaining review proof or verified
trust. Rejection, ambiguity, or install failure keeps a skill gap and the agent run continues.

### Inspect the ledger

```bash
vf units status               # board: status, gates, owner, confidence
vf units show <name>          # one unit as JSON
vf units resources            # token / cost / wall-time totals
vf units evidence <name>      # recorded evidence paths
```

### Verify (hard gates)

```bash
vf verify
vf verify --sandbox docker \
  --sandbox-image registry.example/vf@sha256:<digest> \
  --sandbox-volume vf-deps-<lock-sha256>
```

Runs `typecheck`/`lint`/`test` when your `package.json` declares them, **plus** the policy gates:
confidence below its risk threshold fails; every `done` unit needs machine-verifiable evidence and
`gates.test: "pass"`; current-HEAD review evidence is required; overlapping work-unit scopes fail.

Use sandbox mode for untrusted agent-authored tests/build scripts. It runs synchronous CLI
gates with no network or inherited host environment, using a disposable source copy rather
than your active worktree. Prepare a digest-pinned toolchain image and Linux dependency
volume first; label the volume `vibeflow.lock-sha256=<lockfile SHA-256>`. vf never installs,
pulls, or falls back to host execution when sandbox preflight fails.

### Hooks (guardrails)

```bash
vf hooks status               # show git path + live guardrail status
vf hooks install              # install fail-closed pre-commit + pre-push gates
vf hooks emit                 # write engine configs (Claude/Codex/Copilot/OpenCode/Antigravity) + managed git hooks
echo '{"event":"pre-command","command":"rm -rf /"}' | vf hook   # → {"decision":"block",...}
```

All engine hook configs delegate to one entrypoint — `vf hook` — which scores risk and
returns `allow | warn | require_approval | block`.

Before a branch upload, `.githooks/pre-push` runs current-HEAD verification with local
review evidence. It fails closed with a repair command, but skips reviewer records for
docs-only/no-checklist ranges. It makes no network or LLM call. `git push --no-verify`
bypasses only local feedback; GitHub's required `review-thread-gate` remains authoritative.
VibeFlow preserves user-owned hooks instead of overwriting or chaining them.

---

## 5. End-to-end walkthrough (verifiable)

```bash
mkdir demo && cd demo && git init -q
printf '{"name":"demo","scripts":{"build":"tsc","test":"echo ok"},"dependencies":{"express":"^4"}}' > package.json
printf '# Demo\n\nA tiny service.\n' > README.md

vf init --engine claude          # → PROJECT_CONTEXT.md shows Express + npm + build
vf skills resolve                # → Express docs need (acquire on demand)
vf orchestrate                   # → 1 unit dispatched (dry); goal: partial (confidence 0)
vf units status                  # → the unit with its gate strip
vf verify                        # → fails the confidence gate (no completion on a guess)
```

Every step prints evidence you can check. The goal only reaches `met` when each unit is
`done` at confidence `1.0` with recorded evidence — which is exactly the point.

---

## 6. Generated files

```text
CLAUDE.md AGENTS.md .github/copilot-instructions.md   # engine instruction files
.vibeflow/PROJECT_CONTEXT.md REQUIREMENTS.md TASK_CONTEXT.md
.vibeflow/WORKFLOW_POLICY.md SKILL_INDEX.md WORKFLOW_STATE.json
.vibeflow/SETTINGS.json                                 # per-repo tool settings
.vibeflow/dispatch/<engine>.md                          # vf run
.vibeflow/workunits/<name>/CONTEXT.md + <engine>.result.json   # vf orchestrate
.vibeflow/attachments/                                  # uploaded sample files
```

Minimal-footprint principle: VibeFlow generates the fewest files needed, composed from
canonical context. Work units and skills appear only when a task actually needs them.

---

## 7. Troubleshooting

- **"No workflow. Run `vf init` first."** — you ran `orchestrate`/`units` before `init`.
- **`vf discover` says approval required** — re-run with `--yes`; network is never silent.
- **`vf discover` failed / offline** — Context7 runs over HTTP; check connectivity. Set
  `CONTEXT7_API_KEY` to raise the rate limit (keyless works but is throttled).
- **An engine CLI isn't launched on `vf run`** — install it; `vf doctor` shows what's missing.
- **Conversation request returns `401`** — open the loopback page first so it can issue the
  process-local session cookie. Conversation routes intentionally do not work from a
  `--host 0.0.0.0` page.
- **Conversation write returns `403`** — reload the page; its per-process CSRF token no
  longer matches the running server.
- **Conversation control returns `409`** — the lifecycle changed, the approval was already
  resolved, or the route/body operation ids disagree. Resume the latest snapshot and use the
  current control card.
- **The conversation says it is reconnecting** — token renewal and cursor replay are
  automatic. If it persists, verify that the original process is still running; sessions,
  stream-token digests, and the live runtime are process-local.
- **`vf doctor` reports an uncertain or orphaned CLI** — inspect the recorded owner first.
  `vf doctor --fix` repairs only an exact proved orphan; a live or identity-unprovable owner
  stays fail-closed. Every owned launch records supervisor and CLI PIDs plus exact process
  start identity, and terminal release waits for exit/quiescence plus `streams-drained`.
  Windows uses a kill-on-close Job Object (`kernel-contained`); Linux and macOS use an
  isolated process group (`cooperative-lineage`, because descendants can escape it). The
  shipped Windows contract is covered by injected platform tests, not a live Windows canary.
- **An artifact preview is unavailable** — only opaque ids emitted by that conversation's
  public trace can be fetched. Raw paths and ids from a different conversation are rejected.
- **`vf verify` fails on confidence** — raise the unit to `1.0` with evidence, or keep
  investigating; this is the anti-hallucination gate working as designed.

---

**Related:** [Command Reference](./COMMAND_REFERENCE.md) · [Workflow](./WORKFLOW.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/USER_GUIDE.md)

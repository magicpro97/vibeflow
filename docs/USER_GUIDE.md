# VibeFlow User Guide

VibeFlow is a local-first CLI (`vf`) that opens a web UI and orchestrates Claude Code,
Codex CLI, and GitHub Copilot CLI through shared context, Anthropic-style skills, hooks,
and verification. It never lets an engine work blindly: it scans your repo, resolves the
skills a task needs **on demand**, plans non-overlapping work units, dispatches them in
parallel, and refuses to "complete" anything without recorded evidence.

This guide is verifiable end to end — every section ends with a command whose output you
can check.

---

## 1. Install

```bash
npx @magicpro97/vibeflow            # run without installing
npm install -g @magicpro97/vibeflow # or install globally, then use `vf`
```

Requirements: Node ≥ 18 and git. Engines (Claude Code / Codex / Copilot CLI) are optional
— VibeFlow detects what you have and degrades gracefully. Context7 discovery needs no
extra install (it rides the built-in `fetch`); an optional `CONTEXT7_API_KEY` raises the
rate limit.

Verify:

```bash
vf doctor            # presence/auth check
vf doctor --probe    # also run a live "reply READY" round-trip per engine
vf doctor --refresh  # discard the probe-result cache and re-probe immediately
```

You should see ✓/• marks for node, git, bun, claude, codex, copilot, docker, plus an
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
- **Work unit** — a scoped slice of the task (`.viteflow/workunits/<name>/`) with its own
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

Opens `http://127.0.0.1:<port>` (loopback only). The dashboard has:

1. **New workflow** — repository path (with **Detect**), goal, engines, doc/task sources,
   file types, sample attachments, and the Definition of Done. Click **Generate workflow**.
2. **Resource meter** — units done, tokens, estimated cost, elapsed time (live via SSE).
3. **Triage banner** — any blocked unit is surfaced at the top, before everything else.
4. **Dispatch** — pick an engine, **Write dispatch prompt**, or **Orchestrate (dry)** to
   plan + dispatch work units (browser orchestration is always dry — it never shells out).
5. **Work units** — a board you can add/edit/delete; each card shows status, the
   build/lint/test/review gate strip, confidence, resources, and recorded evidence.
6. **Skills** — locally discovered skills and the demand-driven NEEDS (satisfied vs. must
   acquire).
7. **Discovery** — Context7 docs/skill lookup. The network is only touched after you tick
   **approve network**.

Security: the server binds to `127.0.0.1`, every write carries a per-process CSRF token,
the Host/Origin must be loopback, uploads are sanitized and size-capped, and the page ships
no third-party JavaScript under a strict CSP.

---

## 4. The CLI

### Generate context

```bash
vf init                       # scan repo + generate canonical context for all engines
vf init --engine claude       # only Claude Code files
vf init --interactive         # ask the intake questions in the terminal
vf init --dry-run             # show what would be written
# per-role agent files are written alongside the engine files when a per-role
# renderer is available (see src/agents/render.ts); see AGENT_ORCHESTRATION_POLICY.md
```

`vf init --ai` runs the AI enrichment phase on top of the deterministic
context. The chosen engine is the first ready one in priority order
(`claude > copilot > codex`), unless `--engine` is set.

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

`init` scans the repo (README, manifests, lockfiles, CI) and writes `.viteflow/*` plus the
engine files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`). It runs a live
readiness probe first and **refuses to create a workflow when no engine is ready** —
engines that fail the probe are skipped, files are written only for ready ones (`--dry-run`
skips the gate). Verify:

```bash
cat .viteflow/PROJECT_CONTEXT.md     # contains a "## Detected stack" section
```

### Resolve which skills a task needs (demand-driven)

```bash
vf skills list           # skills discovered under .vibeflow/.claude/.agents/.github skills dirs
vf skills search xlsx    # rank local skills against a term
vf skills resolve        # derive NEEDS from the scan + intake; show satisfied vs missing
vf skills validate       # validate every canonical skill against the Anthropic standard
vf skills sync           # regenerate engine mirrors from .vibeflow/skills/ (default: pointer)
vf skills verify-sync    # check each mirror has a SKILL.md for every canonical skill
```

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
detected language). Enabling a tool flips it in `.viteflow/SETTINGS.json` and wires MCP
config per engine — it merges `.mcp.json` for Claude, writes `.codex/config.toml` (with
`disabled_tools` gating) for Codex, and prints `copilot mcp add` commands for you to run.
The preference order **codegraph > lsp > native** is injected into the engine instruction
files. Re-run `vf init` after changing tools to regenerate them.

### Dispatch and orchestrate

```bash
vf run claude                 # write .viteflow/dispatch/claude.md (dry)
vf run claude --yes           # launch the Claude Code CLI

vf orchestrate                # plan + dispatch work units (dry: prompts only)
vf orchestrate --engine codex --concurrency 4
vf orchestrate --yes          # real dispatch through the engine CLI
```

`orchestrate` dispatches every work unit through a bounded parallel pool, runs an
independent reviewer (a unit only passes at confidence `1.0` with evidence), then the
orchestrator-only goal-eval prints `met | partial | blocked`.

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
```

Runs `typecheck`/`lint`/`test` when your `package.json` declares them, **plus** the policy
gates: confidence `< 1` fails, a `done` unit with no evidence fails, and overlapping
work-unit scopes fail.

### Hooks (guardrails)

```bash
vf hooks status               # show core.hooksPath
vf hooks install              # wire core.hooksPath → .githooks
vf hooks emit                 # write engine hook configs (Claude/Codex/Copilot + git)
echo '{"event":"pre-command","command":"rm -rf /"}' | vf hook   # → {"decision":"block",...}
```

All engine hook configs delegate to one entrypoint — `vf hook` — which scores risk and
returns `allow | warn | require_approval | block`.

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
.viteflow/PROJECT_CONTEXT.md REQUIREMENTS.md TASK_CONTEXT.md
.viteflow/WORKFLOW_POLICY.md SKILL_INDEX.md WORKFLOW_STATE.json
.viteflow/SETTINGS.json                                 # per-repo tool settings
.viteflow/dispatch/<engine>.md                          # vf run
.viteflow/workunits/<name>/CONTEXT.md + <engine>.result.json   # vf orchestrate
.viteflow/attachments/                                  # uploaded sample files
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
- **`vf verify` fails on confidence** — raise the unit to `1.0` with evidence, or keep
  investigating; this is the anti-hallucination gate working as designed.

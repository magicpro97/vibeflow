---
title: Hooks and Guardrails
description: How to configure and use hooks for safety guardrails — universal hook design, per-engine enforcement, false positive reduction, and automation.
category: how-to
last_updated: 2026-06-24
---

# Hooks and Guardrails

## Contents

- [Purpose](#purpose)
- [Universal Hook Design](#universal-hook-design)
- [Enforcement Scope per Engine](#enforcement-scope-per-engine-feasibility-constraint)
- [Universal Hook Input](#universal-hook-input)
- [Per-Event Output Shape](#per-event-output-shape)
- [Recommended Hooks](#recommended-hooks)
- [Avoiding False Positives](#avoiding-false-positives)
- [False Positive Reduction Techniques](#false-positive-reduction-techniques)
- [Final Hook Rule](#final-hook-rule)

## Purpose

Hooks provide a common guardrail and automation layer across Claude Code, Codex, and GitHub Copilot CLI.

Hooks should not contain the main reasoning logic. They should enforce safety, validate outputs, collect logs, and reduce risky behavior.

## Universal hook design

There is one shared decision engine behind a single CLI entrypoint — `vf hook` — and
per-engine native config files that all delegate to it. `vf hook` reads a JSON event on
stdin, scores its risk, and prints an `allow | warn | require_approval | block` decision
(see `src/hooks/runner.ts`). One source of truth, three engines plus git.

`vf hooks emit` writes the per-engine native config, each routing the engine's
native hook events to `vf hook`:

```text
.claude/settings.json        → Claude PreToolUse/PostToolUse/Stop hooks → `vf hook` (repo)
~/.codex/hooks.json          → Codex PreToolUse/PostToolUse → `vf hook` (global)
.github/hooks/copilot.json   → Copilot preToolUse (fail-closed) + postToolUse → `vf hook` (repo)
.githooks/pre-commit         → shell hook routing staged files through `vf hook` (repo)
.githooks/pre-push           → current-HEAD verify + local review-evidence gate (repo)
```

These are each engine's own native configuration format (not VibeFlow-invented files), so
no separate executable wrapper is needed: every engine already knows how to invoke a
command for its native hook events, and that command is `vf hook`.

### Git pre-push review gate

`vf hooks install` also installs a fail-closed pre-push hook. For pushed branch refs it
requires the pushed SHA to equal checked-out `HEAD`, derives the merge base of local and
remote SHA (or the remote-default merge base for a new branch), and runs
`vf review check --base <full-SHA>` once. Tags and deletions are
ignored; multi-branch pushes with different bases must be split. Missing verifier, invalid
base, or failed evidence blocks and prints repair commands. No LLM/network/API runs inside
the hook. `git push --no-verify` bypasses local feedback only; remote `review-thread-gate`
remains authoritative. User-owned git hooks are never overwritten or auto-chained.

## Enforcement scope per engine (feasibility constraint)

Blocking pre-action hooks (`pre-command`/`pre-write` that can `require_approval` or
`block` *before* a command runs or a file is written) require the engine to expose a
native, vetoing interception point. This cannot be assumed for every engine:

```text
Claude Code → native blocking hooks available; full pre-action enforcement.
Codex CLI   → native PreToolUse veto for Bash/shell only; Edit/Write/apply_patch/MCP
              calls are not intercepted by this hook.
Copilot CLI → native preToolUse (fail-closed: non-zero exit DENIES the tool call);
              full pre-action enforcement.
```

Because the security guarantees (read-only by default, no silent install, `block` on
destructive commands) depend on pre-action interception, an engine without native blocking
hooks degrades to detection-only. VibeFlow currently implements the fallback:

```text
Option A (future): run the engine under a VibeFlow-imposed process-level enforcement
  layer (sandbox / restricted FS overlay / shell-command proxy / PTY interceptor) that
  applies the same allow|warn|require_approval|block decisions independent of native hooks.
Option B (implemented): Claude Code AND Copilot get full vetoing pre-action hooks
  (PreToolUse / preToolUse). Codex gets a native PreToolUse veto for Bash/shell only;
  its remaining tool calls stay behind the apply-time diff gate and its scope is printed
  before Codex launches.
```

The hook adapter (`src/hooks/adapters.ts`) exposes an enforcement-capability descriptor
(`engineEnforcement` → `native` for Claude/Copilot/opencode, `native-bash-only` for Codex)
so the orchestrator knows, per engine, whether pre-action blocking is full or partial.
The partial-scope banner is surfaced before Codex runs.

### Apply-time gate for incomplete native coverage (issue #547)

Claude and Copilot veto risky actions mid-loop through their native pre-action hooks, so a
dangerous edit or command never reaches disk without a decision. Codex only vetoes Bash/shell,
so its produced non-Bash changes would otherwise land unreviewed. The apply-time gate
(`src/hooks/apply-gate.ts`) closes that one real gap by moving enforcement to the point where
VibeFlow itself controls the flow — after a unit's review passes, before it is marked done:

```text
enforceApplyGate(engine, diff):
  1. Fully native engine (Claude / Copilot / opencode) → pass through. Codex is gated
     because its native hook covers Bash/shell only.
  2. classifyDiff(diff) PER-HUNK: each hunk's added lines + touched path run through the
     SAME scoreRisk classifier (DANGEROUS_COMMAND / PROTECTED_PATH + the optional semantic
     tier, #544). The MAX risk across hunks wins, and each contributing hunk names its file
     so the reviewer sees WHICH change tripped the gate.
  3. At/above the threshold (default `high`, config `applyGate.threshold`), the diff is routed
     to the existing web-UI approval modal (`registerPending` → HookApprovalModal.vue). The
     unit blocks until a human decides allow|block.
  4. FAIL-CLOSED: a classifier throw is treated as `critical` (confirm/block), and a modal
     that cannot be reached resolves to `block`. Safety never silently degrades to allow.
```

This gives every engine the same EFFECTIVE enforcement point: fully native engines block
in-loop; Codex blocks Bash/shell in-loop and its remaining changes at apply time. The gate is
injected (default OFF), so a run with no partial-coverage engine is byte-identical to before.

### Codex hook config is global, not per-repo

Codex reads hooks from `~/.codex/hooks.json`, and the native hook feature requires
`[features] codex_hooks = true` in `~/.codex/config.toml`. Therefore `vf hooks emit --yes`
merges VibeFlow's `PreToolUse` and `PostToolUse` entries into those two **global** files. It
affects every repository run by Codex on this machine; VibeFlow prints this warning both in the
dry run and immediately before writing. Existing unrelated JSON keys and hooks are preserved.

To revert, remove VibeFlow's `PreToolUse` and `PostToolUse` entries from
`~/.codex/hooks.json`, then remove or set `codex_hooks = false` under `[features]` in
`~/.codex/config.toml`.

## Universal hook input

```json
{
  "engine": "claude-code",
  "event": "pre-command",
  "workspace": "/repo",
  "command": "npm install lodash",
  "files": [],
  "agent": "backend-engineer",
  "taskId": "TASK-123",
  "intent": "implement feature"
}
```

## Per-event output shape

`vf hook` emits JSON to stdout and exits 0. The shape depends on the
input event (see `src/hooks/runner.ts:presentDecision`):

### PreToolUse (Claude native)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "ask" | "deny",
    "permissionDecisionReason": "<reasons joined with '; '>"
  }
}
```

Mapping: `block` → `deny`, `require_approval` → `ask`, `allow`/`warn` → `allow`.

### Stop
- Block: top-level `decision:block`
  ```json
  { "decision": "block", "reason": "<reasons joined with '; '>" }
  ```
- Risks but no block: feedback via `additionalContext`
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "Stop",
      "additionalContext": "<reasons joined with '; '>"
    }
  }
  ```
- Clean (no risks): `{}` (silent approval; `suppressOutput` is not valid
  for Stop per the 2026 spec).

### PostToolUse
- No feedback: `{}` (allow to proceed; `suppressOutput` is NOT a no-op
  substitute — Claude still parses it as a meaningful payload).
- Feedback:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "<reasons joined with '; '>"
    }
  }
  ```

### Other events
Top-level fields from the `HookResult` shape (`{decision, risk, reasons}`):
```json
{ "decision": "allow", "risk": "none", "reasons": [] }
```

Allowed `decision` values: `allow | warn | require_approval | block`.
There is **no** `severity` field and **no** `requiresApproval` field;
Claude reads `permissionDecision` for PreToolUse, and `decision` (top-level
or in `hookSpecificOutput`) for other events.

## Recommended hooks

### Pre-command

Used before shell commands.

Responsibilities:

```text
- block destructive commands
- require approval for package installation
- require approval for deployment
- prevent reading secrets
- prevent commands outside workspace
```

### Post-command

Used after shell commands.

Responsibilities:

```text
- capture command output
- detect failures
- suggest bounded retries
- update workflow state
```

### Pre-write

Used before file modification.

Responsibilities:

```text
- block writes outside workspace
- require approval for protected files
- prevent deletion of important files
- enforce scope boundaries
```

### Post-write

Used after file modification.

Responsibilities:

```text
- inspect diff
- check if changed files match task scope
- record files changed
- trigger skill compliance check
```

### Skill compliance

Responsibilities:

```text
- verify matching skills were used
- detect manual processing when verified skill exists
- check skill version and status
- request skill update if repeated workaround appears
```

### Final verify

Responsibilities:

```text
- run configured tests/lint/build if allowed
- summarize diff
- check acceptance criteria
- produce final verification report
```

## Avoiding false positives

Hooks should use risk scoring instead of simple block rules.

```text
Low risk      → allow + log
Medium risk   → warn + continue
High risk     → require approval
Critical risk → block
```

Risk classification compares paths with `path.sep` (never `/` or `\` literals) so
glob/scope rules behave the same on Windows and Unix (`src/agents/role-templates.ts`
also enforces this for all per-role agent templates).

### Semantic risk tier

The regex classifier is the deterministic **floor** — fast, offline, and the source of
truth for a `block`. An OPTIONAL semantic (LLM) tier can be layered on top through the
`VIBEFLOW_AI` bridge (the same bridge used for goal-eval): it scores a command the regex
rated `none`/`low` but that is side-effecting (a sub-shell, an inline `-c` script, or a
network / `base64` / `eval` token) and can only **raise** the final risk —
`finalRisk = max(regex, llm)`. It never lowers a deterministic verdict, so a `critical`
stays `critical`. The tier is **fail-open and off by default**: with no bridge configured
(or on any spawn/parse failure) it contributes nothing and scoring is byte-for-byte the
regex result. The raised level surfaces through the existing `reasons[]` (as
`semantic tier raised risk to <tier>`) — there is no new user surface.

## False positive reduction techniques

### 1. Scope-aware checks

Only escalate for sensitive paths:

```text
auth/**
payments/**
infra/**
.github/workflows/**
terraform/**
k8s/**
.env*
```

### 2. Intent-aware checks

If the task is explicitly about auth, editing auth files is expected. The hook should increase review strictness, not automatically block.

### 3. Diff-aware checks

Evaluate actual change content, not only file names.

### 4. Repo allowlist

Example policy:

```json
{
  "allowedCommands": ["npm test", "pnpm lint", "mvn test"],
  "protectedPaths": [".env", "infra/prod/**"],
  "approvalRequiredPaths": ["auth/**", ".github/workflows/**"]
}
```

### 5. Human override with reason

Allow:

```text
Approve once
Approve for this task
Approve for this repo policy
```

Every override must be logged.

## Final hook rule

```text
Hooks must prevent irreversible or unsafe actions.
Hooks must not prevent normal development work.
When unsure, prefer warn or require approval over block.
Block only when the action is clearly unsafe.
```

---

## Web UI interactive approval (vf orchestrate + web UI)

When `vf orchestrate` is launched from the web UI (`vf ui`), hooks that return
`require_approval` pause the engine and surface an approval modal in the browser
instead of auto-deciding. The engine waits indefinitely for user response.

### How it works
1. `vf hook` detects a running UI server (`.vibeflow/.ui-port` present)
2. Registers the pending approval at `POST /api/hook/pending`
3. Blocks on `GET /api/hook/response/{id}` (no timeout — waits for user)
4. User sees HookApprovalModal: tool, command, risk level, reasons
5. User clicks Allow once / Block → `POST /api/hook/approve {id, decision}`
6. `vf hook` exits with the user decision

If the UI tab is closed and reopened, `GET /api/hook/pending` returns pending
approvals and the modal re-appears automatically.

### Auto-pilot modes

| Flag | Behavior | Audit log |
|------|----------|-----------|
| (default) | Ask user via modal | No |
| `--auto-pilot` | LLM evaluates false positive (confidence ≥ 0.9 → allow) | Yes |
| `--yolo` | Blind allow-all, no evaluation | Yes |
| `--allow-all` | Same as --yolo | Yes |

Audit log: `.vibeflow/knowledge/hook-audit.log` (append-only JSONL).

Logbus stream: every live-gate decision is also emitted onto the durable `hook`
logbus channel (visible via `vf logs` / the SSE endpoint) as
`{ kind: "hook", decision, risk }` with the unit as `unit`. This is additive —
the `hook-audit.log` above is unchanged; the channel gives an ordered stream so a
run's hook decisions interleave with dispatch and verdict events (#542).

### CLI-only fallback
When `.vibeflow/.ui-port` is absent, `require_approval` auto-decides:
medium → allow (warn), high/critical → block.

---

**Related:** [Security Model](./SECURITY_MODEL.md) · [Tool Adapters](./TOOL_ADAPTERS.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/HOOKS_AND_GUARDRAILS.md)

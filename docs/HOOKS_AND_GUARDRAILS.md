# Hooks and Guardrails

## Purpose

Hooks provide a common guardrail and automation layer across Claude Code, Codex, and GitHub Copilot CLI.

Hooks should not contain the main reasoning logic. They should enforce safety, validate outputs, collect logs, and reduce risky behavior.

## Universal hook design

There is one shared decision engine behind a single CLI entrypoint — `vf hook` — and
per-engine native config files that all delegate to it. `vf hook` reads a JSON event on
stdin, scores its risk, and prints an `allow | warn | require_approval | block` decision
(see `src/hooks/runner.ts`). One source of truth, three engines plus git.

`vf hooks emit` writes the per-engine native config into the target repo, each routing the
engine's native hook events to `vf hook`:

```text
.claude/settings.json        → Claude PreToolUse/PostToolUse/Stop hooks → `vf hook`
.codex/hooks.json            → Codex post-command/post-write/verify-result → `vf hook`
.github/hooks/copilot.json   → Copilot preToolUse (fail-closed) + postToolUse → `vf hook`
.githooks/pre-commit         → shell hook routing staged files through `vf hook`
```

These are each engine's own native configuration format (not VibeFlow-invented files), so
no separate executable wrapper is needed: every engine already knows how to invoke a
command for its native hook events, and that command is `vf hook`.

## Enforcement scope per engine (feasibility constraint)

Blocking pre-action hooks (`pre-command`/`pre-write` that can `require_approval` or
`block` *before* a command runs or a file is written) require the engine to expose a
native, vetoing interception point. This cannot be assumed for every engine:

```text
Claude Code → native blocking hooks available; full pre-action enforcement.
Codex CLI   → no equivalent vetoing pre-tool hook today; detection-only.
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
Option B (implemented, issue #79): Claude Code AND Copilot get vetoing pre-action hooks
  (PreToolUse / preToolUse); Codex is wired DETECTION-ONLY (post-command/post-write
  /verify-result events) and a downgrade banner is printed to the user before Codex
  launches.
```

The hook adapter (`src/hooks/adapters.ts`) exposes an enforcement-capability descriptor
(`engineEnforcement` → `native` for Claude and Copilot, `post-hoc-only` for Codex) so the
orchestrator knows, per engine, whether pre-action blocking is real or downgraded. When it
is downgraded, `downgradeBannerText` is surfaced before the run starts.

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

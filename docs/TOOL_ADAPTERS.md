# Tool Adapters

## Purpose

Tool adapters make Claude Code, Codex CLI, and GitHub Copilot CLI work from the same canonical workflow context.

The system should not maintain separate logic for each tool. It should generate tool-specific files from shared context.

## Canonical input

```text
.vibeflow/PROJECT_CONTEXT.md
.vibeflow/REQUIREMENTS.md
.vibeflow/TASK_CONTEXT.md
.vibeflow/WORKFLOW_POLICY.md
.vibeflow/SKILL_INDEX.md
```

## Claude Code adapter

Generated files:

```text
CLAUDE.md
.claude/agents/
.claude/skills/
.claude/settings.json
```

Claude Code should be preferred for:

```text
- skill-native workflows
- subagent workflows
- MCP integrations
- complex planning
- high-risk review
- skill evolution
```

Recommended Claude layout:

```text
.claude/
  agents/
    orchestrator.md
    backend-engineer.md
    frontend-engineer.md
    test-engineer.md
    security-reviewer.md
    devops-engineer.md
    skill-compliance-reviewer.md
  skills/
    repo-onboarding/
      SKILL.md
    skill-maintainer/
      SKILL.md
    xlsx-reader/
      SKILL.md
  settings.json
```

## Codex adapter

Generated files:

```text
AGENTS.md
.codex/config.toml
.vibeflow/dispatch/codex.md
```

Codex does not need to consume Claude-native skills directly. The orchestrator should inject selected `SKILL.md` content into the task prompt or provide `SKILL_INDEX.md`.

Codex dispatch prompt should include:

```text
- task goal
- repo context
- selected skills
- constraints
- allowed files
- verification commands
- expected output format
```

## Copilot CLI adapter

Generated files:

```text
AGENTS.md
.github/copilot-instructions.md
.github/instructions/*.instructions.md
.vibeflow/dispatch/copilot.md
```

Copilot CLI should use:

```text
- repo-wide instructions
- path-specific instructions
- agent instructions through AGENTS.md
- prompt-injected selected skills
```

Copilot dispatch prompt should include:

```text
Use the selected skill instructions below.
Do not invent manual steps when a matching verified skill exists.
Return JSON summary including skills used, files changed, tests run, and uncertainty.
```

## Engine quota adapter

`src/engine-quota.ts` is the adapter that turns each engine's quota probe into a
normalised exhaustion signal. The preflight gate
(`src/preflight-delegate.ts`) consumes it before any dispatch.

```text
claude   → spawn `claude usage --json`         → parse remaining % + reset window
codex    → spawn `codex doctor --usage`       → parse remaining % + reset window
copilot  → spawn `gh api copilot`              → parse remaining % + reset window
```

The adapter is **best-effort**: it never blocks the preflight gate for more than
the per-engine probe timeout, and a non-JSON / non-zero exit returns
`unknown` (the gate then falls back to the next engine if all three layers are
unusable). The Claude JSON variant, the Codex usage line, and the GitHub
Copilot REST shape are all parsed defensively — extra / missing fields are
ignored, only `remaining` + `reset_at` (when present) drive the gate.

## Shared adapter contract

All adapters should expose the same internal interface:

```ts
interface EngineAdapter {
  name: 'claude' | 'codex' | 'copilot'
  detect(): Promise<EngineStatus>
  // Declares whether this engine supports native blocking pre-action hooks or
  // must rely on a process-level enforcement layer / post-hoc verification.
  // See "Enforcement scope per engine" in HOOKS_AND_GUARDRAILS.md.
  enforcement(): EngineEnforcementCapability
  generateInstructions(context: WorkflowContext): Promise<void>
  buildPrompt(task: TaskSpec): Promise<string>
  run(task: TaskSpec): Promise<EngineRunResult>
  parseResult(raw: unknown): Promise<NormalizedResult>
}

interface EngineEnforcementCapability {
  preActionBlocking: 'native' | 'process-layer' | 'post-hoc-only'
  supportedDecisions: Array<'allow' | 'warn' | 'require_approval' | 'block'>
}
```

## Dispatch result schema

```json
{
  "engine": "claude",
  "task_id": "TASK-123",
  "agents_used": [],
  "skills_used": [],
  "files_changed": [],
  "commands_run": [],
  "tests_run": [],
  "confidence": 0.88,
  "verification": {
    "passed": true,
    "details": []
  },
  "uncertainty": [],
  "recommended_next_action": "..."
}
```

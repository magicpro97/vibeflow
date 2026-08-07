---
title: Agent Orchestration Policy
description: Defines the orchestration policy for the main AI agent — confidence thresholds, debate rules, anti-hallucination, and verification.
category: explanation
last_updated: 2026-06-24
---

# Agent Orchestration Policy

## Contents

- [Core Principle](#core-principle)
- [Universal Task Pipeline](#universal-task-pipeline)
- [Confidence Policy](#confidence-policy)
- [Low Confidence Escalation](#low-confidence-escalation)
- [Debate Policy](#debate-policy)
- [Parallel Execution Policy](#parallel-execution-policy)
- [Anti-Hallucination Policy](#anti-hallucination-policy)
- [Verification Policy](#verification-policy)
- [Per-Role Agent Files](#per-role-agent-files)

> This document defines orchestration **policy**. The file-backed **mechanism** that makes
> the policy observable and auditable — scoped work units, quality gates, evidence ledger,
> and resource tracking — is specified in `WORK_UNIT_ORCHESTRATION.md`.

## Core principle

The main AI agent is always the orchestrator, not just an implementer.

```text
Main Agent = Orchestrator / Planner / Judge
Sub Agents = Investigator / Implementer / Reviewer / Verifier
Strongest Model = Final reasoning authority for high-risk decisions
```

## Universal task pipeline

```text
Receive prompt
  ↓
Clarify intent internally
  ↓
Identify assumptions and risks
  ↓
Estimate confidence
  ↓
If confidence < threshold → bounded investigation
  ↓
If still low → recommend next best action with evidence
  ↓
Plan
  ↓
Split tasks
  ↓
Run non-overlapping work in parallel
  ↓
Execute
  ↓
Verify
  ↓
Report result, evidence, uncertainty
```

## Confidence policy

Do not use `confidence < 1` as an infinite loop trigger. Perfect certainty is rare.

Use threshold by risk level:

```text
Formatting / documentation:      0.70
Simple code change:              0.80
Feature implementation:          0.85
Architecture decision:           0.90
Security / auth / payment:       0.95
Production deployment:           0.95+
```

If confidence is below threshold, the orchestrator must investigate within limits.

Recommended limits:

```text
Max investigation rounds: 3
Max debate rounds: 2
Max retry per failed command: 2
Default max parallel agents: 3
```

## Low confidence escalation

The orchestrator must not ask the user an open-ended question such as:

```text
What should I do next?
```

Instead, it must recommend the next best action.

Required format:

```text
Current confidence:
Evidence found:
Evidence missing:
Why confidence is low:
Recommended next action:
Reasoning:
Risk of proceeding:
Risk of not proceeding:
Verification plan:
```

Ask for approval only when the next action has side effects or elevated risk.

Approval is required before:

```text
- installing dependencies
- running unknown scripts
- modifying CI/CD
- changing authentication or authorization
- changing payment, billing, or security logic
- deleting files
- pushing commits
- opening pull requests
- deploying
- enabling a new external skill
- granting network, filesystem, or credential access
```

Missing skills are resolved before agent launch only from a configured pinned registry
cache. The read-only card includes immutable source and security scan status. `--yes`, TTY,
or Web UI approval authorizes the existing install pipeline; HIGH/CRITICAL remains blocked.
Rejecting, missing, or failing acquisition preserves a skill gap and does not cancel agent
dispatch. Approval grants neither review proof nor verified trust.

## Debate policy

For complex or high-risk tasks, run a debate before execution.

Minimum roles:

```text
Planner Agent
Domain Specialist Agent
Skeptic / Risk Reviewer Agent
Verifier Agent
```

Debate questions:

```text
- What are we trying to achieve?
- What evidence do we have?
- What assumptions exist?
- What can go wrong?
- What alternatives exist?
- Which approach is safest and most maintainable?
- How will the result be verified?
```

## Parallel execution policy

Parallel work is allowed only when scopes do not overlap.

Safe examples:

```text
- Backend API analysis
- Frontend UI analysis
- Test coverage review
- Documentation review
```

Unsafe examples:

```text
- Two agents editing the same service
- One agent refactoring while another adds features in the same files
- CI/CD changes without coordination
```

## Anti-hallucination policy

Agents must not invent:

```text
- APIs
- library behavior
- file contents
- business requirements
- user intentions
- test results
- performance results
- security guarantees
```

Every factual claim about the repository must be backed by:

```text
- file path
- code reference
- command output
- test result
- documentation source
```

## Verification policy

Before marking a task complete, verify with appropriate checks:

```text
- read diff
- run tests
- run lint
- run type check
- run build
- inspect generated files
- check acceptance criteria
- ask reviewer agent to inspect
```

Final report must include:

```text
- what changed
- why it changed
- how it was verified
- what remains uncertain
- recommended next action
```

## Per-role agent files

Each engine reads per-role agent files in a different shape, so the orchestrator
renders all three from the same canonical role definition
(`src/agents/role.ts` → `src/agents/render.ts` → `src/agents/role-templates.ts`).
`vf init --agents` writes them all; `vf init --engine <e>` writes only the one
the engine reads.

```text
.claude/agents/<role>.md            # Claude Code  (Markdown body + YAML frontmatter)
.codex/agents/<role>.toml           # Codex CLI     (TOML: name, model, prompt, tools)
.github/agents/<role>.md            # Copilot CLI   (Markdown: frontmatter + body)
```

`render.ts` is the single source of truth for the three formats; it enforces
the role taxonomy (project-fit roles vs tool/tweak roles, see
`src/skills/SKILL_TAXONOMY.md`) and the cross-platform rule (path comparisons
with `path.sep` — see `HOOKS_AND_GUARDRAILS.md`). A role without a matching
render target is reported at `init` time rather than silently dropped. When
`vf init` runs and a per-role renderer is present, the per-role files are
written alongside the engine-level files; `vf init --engine <e>` writes only
the engine's matching format.

---

**Related:** [Work-Unit Orchestration](./WORK_UNIT_ORCHESTRATION.md) · [Security Model](./SECURITY_MODEL.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/AGENT_ORCHESTRATION_POLICY.md)

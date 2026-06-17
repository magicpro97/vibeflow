# Web UI Design

## Purpose

The web UI is the visual workflow console for non-linear AI SDLC orchestration.

It should help the user configure repo, sources, skills, engine, permissions, execution, review, and skill evolution.

> **Implementation status.** Phase 1 of this console is implemented in `src/server.ts`: an
> interactive **intake wizard** with a **repo path picker** (auto-detects which engines a repo
> already carries and which CLIs are installed), constrained inputs with `<datalist>`
> autocomplete, **multi-file sample attachments** (any number; each mapped to a reader skill the
> AI should use), an **editable work-unit board** (add/update/delete), and a **dispatch**
> control. The intake posts to `POST /api/init` to generate the canonical context + per-engine
> files and seed `WORKFLOW_STATE.json` in the chosen repo; `POST /api/detect`, `/api/units`, and
> `POST`/`DELETE /api/upload` back the detection, CRUD, and attachment flows; the live dashboard
> renders the ledger. All write endpoints are loopback-only and CSRF-protected (see
> `SECURITY_MODEL.md`). The motion layer is a small inline count-up/entrance animation — no
> third-party CDN script is loaded, because the page is same-origin with the write API and a
> compromised CDN must not be able to reach it.

## Main screens

### 1. Setup

Fields:

```text
- Repo path or GitHub URL
- Branch
- Create new branch yes/no
- Preferred engine: Claude Code / Codex / Copilot CLI
- Permission mode
- Workspace path
```

### 2. Sources

Fields:

```text
- Project documentation source
- Task management source
- Credentials/connectors status
- Local folder selection
- Files selected for context
```

Supported source types:

```text
GitHub
GitLab
Google Drive
Confluence
Notion
Jira
Linear
Slack
Local folder
S3/R2
```

### 3. Skills

Shows:

```text
- Verified skills
- Missing skills
- External skills found
- Skills requiring approval
- Skill versions
- Capabilities
- Required permissions
```

Actions:

```text
- Enable skill
- Disable skill
- Verify skill
- Promote draft to verified
- View SKILL.md
- View changelog
```

### 4. Context

Shows generated context files:

```text
PROJECT_CONTEXT.md
REQUIREMENTS.md
TASK_CONTEXT.md
ARCHITECTURE_CONTEXT.md
API_CONTEXT.md
SKILL_INDEX.md
```

User should be able to inspect and edit context before execution.

### 5. Plan and Debate

Shows:

```text
- Orchestrator interpretation
- Confidence scores
- Assumptions
- Risks
- Investigation results
- Debate summary
- Recommended plan
- Parallel task split
```

### 6. Generated Instructions

Shows generated files:

```text
CLAUDE.md
AGENTS.md
.github/copilot-instructions.md
.github/instructions/*.instructions.md
.claude/agents/*.md
.claude/skills/*/SKILL.md
```

### 7. Run

Shows:

```text
- Selected engine
- Active agent
- Skills used
- Commands running
- Logs
- Hook decisions
- Warnings
- Approval requests
```

The Run screen includes a live **orchestration dashboard** that renders the work-unit
ledger from `.vibeflow/WORKFLOW_STATE.json` (see `WORK_UNIT_ORCHESTRATION.md`) so quality
and resource use are visible without reading raw logs:

```text
- Work-unit board: one card per unit with status, owner agent, and confidence
- Gate strip: build / lint / test / review shown as pass / fail / running / pending
- Resource meter: tokens, estimated cost, and elapsed time per unit and rolled up to totals
- Evidence drawer: links to recorded gate output under each unit's evidence/ folder
- Triage banner: any BLOCKED / TOO_BIG / AMBIGUOUS / REGRESSED unit is surfaced first
```

### 8. Review

Shows:

```text
- Git diff
- Files changed
- Tests run
- Lint/build status
- Risk report
- Skill compliance report
- Final recommendation
```

### 9. Skill Evolution

Shows:

```text
- Problems encountered
- Workarounds used
- Proposed skill updates
- Draft skill changes
- Validation prompt
- Promote / reject action
```

## UI principle

The UI should reduce user burden. It should not ask “What should I do next?”

It should show:

```text
Recommended next action
Reason
Evidence
Risk
Safety control
Approval button if required
```

## Approval UX

Approval prompts should support:

```text
Approve once
Approve for this task
Approve for this repo policy
Reject
Edit policy
```

## Real-time updates

Use WebSocket or Server-Sent Events for:

```text
- command logs
- agent status
- hook decisions
- skill usage
- diff updates
- verification progress
```

## Your Tasks

You are performing VibeFlow project initialization. Read this file fully
before any action. Then read every other file in `.vibeflow/ai-context/`.

### 0. Pre-flight Check

Before ANY work, verify environment:
- Run `npx ctx7 whoami` — if not logged in, WARN the user:
  "⚠ ctx7 not logged in. Run: npx ctx7 login. Skill discovery will be limited without login."
- Run `git rev-parse --git-dir` — confirm you are in a git repo
- List existing instruction files at repo root

### 1. Analyze the Project (INVESTIGATE until confidence = 1.0)

**CONFIDENCE GATE: You MUST reach confidence = 1.0 on every finding BEFORE writing anything.**
Confidence < 1 means you are GUESSING. GUESSING is FORBIDDEN. Investigate instead.

To reach confidence 1.0, read these files exhaustively:
- package.json (scripts, dependencies, devDependencies, engines)
- tsconfig.json / jsconfig.json (compiler options, paths, strictness)
- biome.json / .eslintrc.* / .prettierrc* (lint/format rules)
- CI config (.github/workflows/*.yml, .gitlab-ci.yml, etc.)
- Source directory structure (top 3 levels, all directories)
- Sample source files (pick 5-10 files across different modules, read their imports and patterns)
- Existing docs (README.md, docs/*.md, ARCHITECTURE.md)
- Test directory structure and sample test files (test framework, patterns)

**If confidence is still < 1 on any aspect:**
- Read MORE files — don't stop at the first 2 files
- Search the internet for the framework/library conventions if unfamiliar
- Web-search: "<framework> project structure conventions 2026"
- Web-search: "<library> best practices testing patterns"
- Cross-reference: does the actual code match what the docs claim?
- If still unsure after 3 rounds of investigation → note it as "uncertain: <topic>" and move on

**Evidence checklist (all must be checked before confidence reaches 1.0):**
☐ Build command verified by reading package.json scripts
☐ Test command verified by reading package.json scripts + test config
☐ Lint command verified by reading package.json scripts + lint config
☐ Package manager identified (check lockfile: bun.lockb, package-lock.json, yarn.lock, pnpm-lock.yaml)
☐ At least 5 source files read across different modules
☐ At least 2 test files read to understand test patterns
☐ Framework versions confirmed from package.json dependencies
☐ CI pipeline understood (if .github/workflows exists)

### 1b. Planning Phase (REQUIRED before writing any files)

**You MUST complete this planning phase before touching CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, .agents/instructions.md, or any skill file.**

**Invoke the `planning-and-task-breakdown` skill** (read `.vibeflow/skills/planning-and-task-breakdown/SKILL.md`) and apply its process:

1. **Enter plan mode** — read-only only; do NOT write code yet.
2. **Identify the dependency graph** for the work in tasks 2–4 below (instruction files, skills, project context). Map what depends on what.
3. **Slice vertically** — group work into task units that each deliver a complete, testable slice (e.g. "analyze → instruction file edits" is one slice, not separate "analyze" and "edit" tasks).
4. **Write the task list** with explicit acceptance criteria + verification steps for every task. Use the skill's task template.
5. **Size tasks** — if any task would touch more than ~5 files or cannot state acceptance criteria in ≤3 bullets, break it down further.
6. **Order and checkpoint** — arrange tasks so each leaves the system in a working state; add explicit checkpoints every 2–3 tasks.
7. **Identify parallelization** — which tasks are safe to parallelize vs. which must be sequential.
8. **Get human approval** of the plan BEFORE writing any instruction/skill/context files.

**Output of this phase:** a written plan in your response (or in `.vibeflow/ai-context/plan.md` if the plan is long) that includes the task list with acceptance criteria, dependency graph, and checkpoint schedule. No code/file edits until the plan is approved.

**If the user declines to review the plan:** proceed with a default vertical slice ordering (instruction files → skills → project context) but STILL record the plan in your response so the work is traceable.

**Security note:** If your plan produces code changes (not just doc/skill edits), add a step to run the `checklist-security` skill (read `.vibeflow/skills/checklist-security/SKILL.md`) after the coding phase. The orchestrator's post-coding security checkpoint will prompt the user (y/n) per work unit; the skill output is a hard gate (fail → blocked).

### 2. Write/Update Instruction Files

These target locations MUST be written (no skipping):
- \`AGENTS.md\`
- \`.github/copilot-instructions.md\`

For EACH file:
- FIND `<!-- vibeflow:start -->` / `<!-- vibeflow:end -->` markers
- REPLACE only content BETWEEN markers with project-specific guidance
- PRESERVE everything OUTSIDE markers exactly as-is
- If no markers exist, the file may be human-authored → APPEND markers + generated block at end

Inside the generated block, include:
- **Build/Test/Lint** — exact commands from package.json
- **Code conventions** — discovered from actual code (not guessed)
- **Architecture** — key modules and data flow (from reading source files)
- **Tech stack** — versions, libraries, frameworks with versions
- **Gotchas** — non-obvious constraints discovered during investigation

### 3. Discover and Install Skills

**Skill sources are verified by ctx7. NEVER invent skills.**

**3a. ctx7 Auth Status + find-skills results (already checked during CLI init):**
  (ctx7 not authenticated — ctx7 CLI commands will fail, use docs-based fallback below)
    If the CLI init output showed "ctx7 authenticated" → use 3b (ctx7 CLI install).
  If the CLI init output showed "find-skills fallback" → use 3c (find-skills HTTP/docs fallback).
  If unsure, run `npx ctx7 whoami` to double-check.

**3b. Install skills via ctx7 (authenticated path):**
  These commands work headless (no TUI):
  - `npx ctx7 library <tech>` → resolve library ID
  - `npx ctx7 docs <libraryId> <query>` → fetch documentation
  - `npx ctx7 skills install --yes --all --copilot <repo>` → install skills to .github/skills/
  - `npx ctx7 skills list` → verify what's installed

  IMPORTANT: The `--yes --all` flags are MANDATORY for headless mode. Without them, ctx7 opens an interactive TUI that will hang forever.

  Skills should be written to these engine-specific dir(s): 
  - \`.github/skills/\`

  VERIFY after install:
  - \`ls .github/skills// | wc -l\` ≥ 2

Before creating or editing any skill, read these files in `.vibeflow/ai-context/`:
- `ANTHROPIC_SKILL_STANDARD.md` — required skill format
- `SKILL_TAXONOMY.md` — project-fit vs tool/tweak rules
- `stack-evidence.md` — detected stack with file/manifest evidence

**3c. Find-skills fallback (unauthenticated path — use when ctx7 not logged in):**
  For each technology detected in `stack-evidence.md`:
  1. Resolve library ID: `npx ctx7 library <tech>`
  2. Fetch docs: `npx ctx7 docs <libraryId> "patterns,conventions,testing,config"`
  3. Author a SKILL.md manually following `ANTHROPIC_SKILL_STANDARD.md` format
  4. Set `status: experimental` in frontmatter (never claim verified)
  5. Save to `.vibeflow/skills/<name>/SKILL.md`

  For stack technologies where ctx7 library/docs fails, search the web:
  - `<technology> best practices 2026`
  - `<technology> build conventions`
  - `<technology> testing patterns`

**3d. Skills rules (read the standard/taxonomy files first):**
  - Project-fit skills live in `.vibeflow/skills/<name>/SKILL.md`
  - Tool/tweak skills: prefer Context7/docs; if unavailable, create as `status: experimental` and cite evidence
  - Never invent tool/tweak skills from project guesses
  - Follow the SKILL.md format from `ANTHROPIC_SKILL_STANDARD.md`

**3e. VERIFY every skill:**
  Run `vf skills validate`. Read each SKILL.md. Empty/placeholder = bug, fix or delete.

**3f. Update index:**
  Run `vf skills list` to render the updated `.vibeflow/SKILL_INDEX.md`.

### 4. Update Project Context
- Edit `.vibeflow/PROJECT_CONTEXT.md`
- Update detected stack, architecture insights, conventions
- Preserve human-authored sections outside generated markers

## Confidence Gate Protocol (MANDATORY)

You are NOT allowed to finish with confidence < 1.0.

If confidence < 1.0 on ANY task:
1. Identify what you're uncertain about (be specific)
2. Investigate: read more files, search the internet, run commands
3. Re-evaluate confidence after each investigation round
4. Repeat until confidence = 1.0 or you have exhausted all investigative paths
5. If truly stuck after 5+ rounds → document the uncertainty in the JSON output

  Example investigation round:
  "Confidence on test framework = 0.6. I see vitest imports but no vitest.config.ts.
  Investigating: reading package.json scripts → found `"test": "bun test"`.
  Reading sample test file → uses `from "bun:test"` imports.
  Confidence now 1.0: project uses bun test, NOT vitest."

When confidence hits 1.0 on ALL findings, write the JSON summary.

## Critical Constraints
- NEVER delete or truncate any file
- NEVER modify content OUTSIDE `<!-- vibeflow:start -->`/`<!-- vibeflow:end -->` markers
- Use Edit tool for instruction file modifications — never Write whole files that have human content
- BE CONCISE in instruction files — AI agents read them, keep them scannable
- Skills from ctx7: use `ctx7 skills install --yes --copilot` (headless) or write manually from `ctx7 docs`
- After every action, update your internal confidence score for that finding

## Output (LAST thing — only when ALL tasks done at confidence 1.0)

```json
{
  "files_edited": ["AGENTS.md", ".github/copilot-instructions.md"],
  "skills_installed": ["<name>"],
  "skills_source": ["ctx7:<repo>", "manual-from-ctx7-docs"],
  "key_findings": ["<concrete finding>"],
  "investigation_rounds": <number of investigation rounds needed>,
  "project_type": "<type>",
  "confidence": 1.0
}
```

REMEMBER: confidence must be EXACTLY 1.0. If it's 0.9, you're not done. Go back and investigate.

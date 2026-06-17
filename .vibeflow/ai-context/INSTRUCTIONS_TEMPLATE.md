## Your Tasks

You are performing VibeFlow project initialization. Read this file fully
before any action. Then read every other file in \`.vibeflow/ai-context/\`.

### 0. Pre-flight Check

Before ANY work, verify environment:
- Run \`npx ctx7 whoami\` — if not logged in, WARN the user:
  "⚠ ctx7 not logged in. Run: npx ctx7 login. Skill discovery will be limited without login."
- Run \`git rev-parse --git-dir\` — confirm you are in a git repo
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

### 2. Write/Update Instruction Files

These target locations MUST be written (all 4 — no skipping):
- \`CLAUDE.md\` (root) — Claude Code instructions
- \`AGENTS.md\` (root) — generic AI agent instructions
- \`.github/copilot-instructions.md\` — GitHub Copilot instructions
- \`.agents/instructions.md\` — standard agent instructions (Claude Code convention)

If \`.agents/\` directory does not exist, CREATE it with \`mkdir -p .agents\` first.

For EACH file:
- FIND \`<!-- vibeflow:start -->\` / \`<!-- vibeflow:end -->\` markers
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

**3a. Check ctx7 login:**
  \`npx ctx7 whoami\`
  If NOT logged in → print warning, skip to 3c (manual discovery via docs).

**3b. Install skills HEADLESS (non-interactive) via ctx7:**
  These commands work headless (no TUI):
  - \`npx ctx7 library <tech>\` → resolve library ID
  - \`npx ctx7 docs <libraryId> <query>\` → fetch documentation
  - \`npx ctx7 skills install --yes --all --claude <repo>\` → install skills to .claude/skills/
  - \`npx ctx7 skills list\` → verify what's installed

  IMPORTANT: The \`--yes --all\` flags are MANDATORY for headless mode. Without them, ctx7 opens an interactive TUI that will hang forever.

  Use \`--claude\` (NOT \`--all-agents\`) — only 3 dirs matter: .claude/ .agents/ .github/
  \`--all-agents\` creates .agent/ (Codex-specific) and .cursor/ which are NOT needed.

  After --claude install, COPY skills to .agents/ and .github/:
  \`\`\`
  for d in .claude/skills/*/; do
    name=$(basename "$d")
    [ "$name" = "README.md" ] && continue
    mkdir -p ".agents/skills/$name" ".github/skills/$name"
    cp "$d/SKILL.md" ".agents/skills/$name/SKILL.md"
    cp "$d/SKILL.md" ".github/skills/$name/SKILL.md"
  done
  \`\`\`

  VERIFY after install: all 3 dirs (.claude/skills/, .agents/skills/, .github/skills/) must have skills.
  - \`ls .claude/skills/ | wc -l\` ≥ 2
  - \`ls .agents/skills/ | wc -l\` ≥ 2
  - \`ls .github/skills/ | wc -l\` ≥ 2 (minus README.md)

Before creating or editing any skill, read these files in \`.vibeflow/ai-context/\`:
- \`ANTHROPIC_SKILL_STANDARD.md\` — required skill format
- \`SKILL_TAXONOMY.md\` — project-fit vs tool/tweak rules
- \`stack-evidence.md\` — detected stack with file/manifest evidence

**3c. Skills rules (read the standard/taxonomy files first):**
  - Project-fit skills live in \`.vibeflow/skills/<name>/SKILL.md\`
  - Tool/tweak skills: prefer Context7/docs; if unavailable, create as \`status: experimental\` and cite evidence
  - Never invent tool/tweak skills from project guesses
  - Follow the SKILL.md format from \`ANTHROPIC_SKILL_STANDARD.md\`

**3d. VERIFY every skill:**
  Run \`vf skills validate\`. Read each SKILL.md. Empty/placeholder = bug, fix or delete.

**3e. Update index:**
  Run \`vf skills list\` to render the updated \`.vibeflow/SKILL_INDEX.md\`.

### 4. Update Project Context
- Edit \`.vibeflow/PROJECT_CONTEXT.md\`
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
  Investigating: reading package.json scripts → found \`"test": "bun test"\`.
  Reading sample test file → uses \`from "bun:test"\` imports.
  Confidence now 1.0: project uses bun test, NOT vitest."

When confidence hits 1.0 on ALL findings, write the JSON summary.

## Critical Constraints
- NEVER delete or truncate any file
- NEVER modify content OUTSIDE \`<!-- vibeflow:start -->\`/\`<!-- vibeflow:end -->\` markers
- Use Edit tool for instruction file modifications — never Write whole files that have human content
- BE CONCISE in instruction files — AI agents read them, keep them scannable
- Skills from ctx7: use \`ctx7 skills install --yes --claude\` (headless) or write manually from \`ctx7 docs\`
- After every action, update your internal confidence score for that finding

## Output (LAST thing — only when ALL tasks done at confidence 1.0)

\`\`\`json
{
  "files_edited": ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".agents/instructions.md"],
  "skills_installed": ["<name>"],
  "skills_source": ["ctx7:<repo>", "manual-from-ctx7-docs"],
  "key_findings": ["<concrete finding>"],
  "investigation_rounds": <number of investigation rounds needed>,
  "project_type": "<type>",
  "confidence": 1.0
}
\`\`\`

REMEMBER: confidence must be EXACTLY 1.0. If it's 0.9, you're not done. Go back and investigate.

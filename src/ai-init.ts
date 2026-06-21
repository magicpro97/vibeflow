// size-waiver: #186 — ai-init.ts split into ai-init/{workflow,runtime,agents}; see issue #186
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectRolesForRepo } from "./agents/detect-roles.js";
import {
  AI_INIT_FINISHER_NAMES,
  type AiInitAdapterName,
  type AiInitIntake,
  type AiInitUnit,
  ENGINE_INSTRUCTION_SCOPE,
  ENGINE_SKILL_DIR,
  aiInitReviewer,
  buildFinisherBatchUnit,
  buildPhaseSkillEnrichmentUnits,
  planAiInitUnits,
} from "./ai-init-workflow.js";
import {
  CTX_DIR,
  ENGINES,
  type Engine,
  type WorkUnit,
  type WorkflowState,
  writeState,
} from "./core.js";
import {
  type AsyncSpawner,
  type EngineCommandResult,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  materializePrompt,
} from "./dispatch.js";
import type { QuotaStatus } from "./engine-quota.js";
import { DEFAULT_CONCURRENCY } from "./orchestrator/run.js";
import { type UnitDispatcher, type UnitOutcome, orchestrateUnits } from "./orchestrator/run.js";
import { type EngineReadiness, preflightAll } from "./preflight.js";
import { backoffPlan, detectQuota } from "./safety/quota.js";
import { type ProjectProfile, renderFindingsTable, scanRepo } from "./scanner.js";
import { curateSkillsFromEvidence } from "./skills/curator.js";

/**
 * Engine priority comes from `ENGINES` in `core.ts` — single source of
 * truth shared by `preflight-delegate.ts` (first-ready picker),
 * `init-intake.ts` (default engines), and this module. The audit (C3)
 * found that this module previously had its own `ENGINE_PRIORITY`
 * constant that disagreed with `core.ts` and with docs/USER_GUIDE.md.
 */

/** Instruction files by selected engine. */
const INSTRUCTION_FILES_BY_ENGINE: Record<Engine, readonly string[]> = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  copilot: ["AGENTS.md", ".github/copilot-instructions.md"],
};
/** When `engines` is empty/absent, default to a single engine's scope
 *  instead of ALL engines. This prevents the instruction-writer from
 *  silently targeting unselected engines (Phase 2 engine-scoping
 *  contract). Copilot matches the INIT_DEFAULT_ENGINE in
 *  ai-init-workflow.ts — the widest single-engine scope so the
 *  reviewer can still pass on either AGENTS.md or copilot-instructions. */
const CONTEXT_FALLBACK_ENGINE: Engine = "copilot";

function instructionFilesFor(engine?: Engine): readonly string[] {
  return engine
    ? INSTRUCTION_FILES_BY_ENGINE[engine]
    : INSTRUCTION_FILES_BY_ENGINE[CONTEXT_FALLBACK_ENGINE];
}

function instructionFilesForEngines(engines?: string[]): readonly string[] {
  const selected = engines?.filter((e): e is Engine => (ENGINES as readonly string[]).includes(e));
  return selected?.length
    ? [...new Set(selected.flatMap((e) => INSTRUCTION_FILES_BY_ENGINE[e]))]
    : INSTRUCTION_FILES_BY_ENGINE[CONTEXT_FALLBACK_ENGINE];
}

/** AI init timeout: 10 minutes for large projects. */
const AI_INIT_TIMEOUT_MS = 600_000;

/** Temp directory for full-file context (no truncation). */
const AI_CONTEXT_DIR = `${CTX_DIR}/ai-context`;

/** Name of the slim-prompt companion file (RAG pattern). */
const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/**
 * RAG-style task instructions written to `.vibeflow/ai-context/INSTRUCTIONS.md`.
 *
 * The engine reads this file with its own `read_file` tool and follows the
 * tasks. The slim prompt just points at the file list and tells the engine
 * to read INSTRUCTIONS.md first.
 *
 * This keeps the argv prompt well under Windows's 32K cmd-line limit
 * (relevant for copilot) regardless of how detailed the tasks become.
 */
function buildInstructionsBody(
  engines?: string[],
  ctx7Auth?: boolean,
  findSkillsResults?: boolean,
): string {
  const selectedEngines = engines?.length
    ? engines.filter((e): e is Engine => (ENGINES as readonly string[]).includes(e))
    : ([CONTEXT_FALLBACK_ENGINE] as Engine[]);
  const instrScope = [...new Set(selectedEngines.flatMap((e) => ENGINE_INSTRUCTION_SCOPE[e]))];
  const skillScope = [...new Set(selectedEngines.map((e) => ENGINE_SKILL_DIR[e]))];
  const instrFiles = instrScope.map((f) => `- \\\`${f}\\\``).join("\n");
  const engineFlag = selectedEngines[0] ?? "copilot";
  const skillDirList = skillScope.map((d) => `  - \\\`${d}\\\``).join("\n");
  const skillVerifyList = skillScope.map((d) => `  - \\\`ls ${d}/ | wc -l\\\` ≥ 2`).join("\n");
  const authPrefix = ctx7Auth
    ? ""
    : "  (ctx7 not authenticated — ctx7 CLI commands will fail, use docs-based fallback below)\n  ";
  const findSkillsRef = findSkillsResults
    ? "  Read `.vibeflow/ai-context/find-skills-results.md` — it contains pre-discovered library/skill candidates from the Context7 HTTP API. Use those as your starting point instead of searching from scratch.\n  "
    : "";

  return `## Your Tasks

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

These target locations MUST be written (no skipping):
${instrFiles}

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

**3a. ctx7 Auth Status + find-skills results (already checked during CLI init):**
${authPrefix}${findSkillsRef}  If the CLI init output showed "ctx7 authenticated" → use 3b (ctx7 CLI install).
  If the CLI init output showed "find-skills fallback" → use 3c (find-skills HTTP/docs fallback).
  If unsure, run \`npx ctx7 whoami\` to double-check.

**3b. Install skills via ctx7 (authenticated path):**
  These commands work headless (no TUI):
  - \`npx ctx7 library <tech>\` → resolve library ID
  - \`npx ctx7 docs <libraryId> <query>\` → fetch documentation
  - \`npx ctx7 skills install --yes --all --${engineFlag} <repo>\` → install skills to ${skillScope[0]}
  - \`npx ctx7 skills list\` → verify what's installed

  IMPORTANT: The \`--yes --all\` flags are MANDATORY for headless mode. Without them, ctx7 opens an interactive TUI that will hang forever.

  Skills should be written to these engine-specific dir(s): 
${skillDirList}

  VERIFY after install:
${skillVerifyList}

Before creating or editing any skill, read these files in \`.vibeflow/ai-context/\`:
- \`ANTHROPIC_SKILL_STANDARD.md\` — required skill format
- \`SKILL_TAXONOMY.md\` — project-fit vs tool/tweak rules
- \`stack-evidence.md\` — detected stack with file/manifest evidence

**3c. Find-skills fallback (unauthenticated path — use when ctx7 not logged in):**
  For each technology detected in \`stack-evidence.md\`:
  1. Resolve library ID: \`npx ctx7 library <tech>\`
  2. Fetch docs: \`npx ctx7 docs <libraryId> "patterns,conventions,testing,config"\`
  3. Author a SKILL.md manually following \`ANTHROPIC_SKILL_STANDARD.md\` format
  4. Set \`status: experimental\` in frontmatter (never claim verified)
  5. Save to \`.vibeflow/skills/<name>/SKILL.md\`

  For stack technologies where ctx7 library/docs fails, search the web:
  - \`<technology> best practices 2026\`
  - \`<technology> build conventions\`
  - \`<technology> testing patterns\`

**3d. Skills rules (read the standard/taxonomy files first):**
  - Project-fit skills live in \`.vibeflow/skills/<name>/SKILL.md\`
  - Tool/tweak skills: prefer Context7/docs; if unavailable, create as \`status: experimental\` and cite evidence
  - Never invent tool/tweak skills from project guesses
  - Follow the SKILL.md format from \`ANTHROPIC_SKILL_STANDARD.md\`

**3e. VERIFY every skill:**
  Run \`vf skills validate\`. Read each SKILL.md. Empty/placeholder = bug, fix or delete.

**3f. Update index:**
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
- Skills from ctx7: use \`ctx7 skills install --yes --${engineFlag}\` (headless) or write manually from \`ctx7 docs\`
- After every action, update your internal confidence score for that finding

## Output (LAST thing — only when ALL tasks done at confidence 1.0)

\`\`\`json
{
  "files_edited": [${instrScope.map((f) => `"${f}"`).join(", ")}],
  "skills_installed": ["<name>"],
  "skills_source": ["ctx7:<repo>", "manual-from-ctx7-docs"],
  "key_findings": ["<concrete finding>"],
  "investigation_rounds": <number of investigation rounds needed>,
  "project_type": "<type>",
  "confidence": 1.0
}
\`\`\`

REMEMBER: confidence must be EXACTLY 1.0. If it's 0.9, you're not done. Go back and investigate.
`;
}

export interface AiInitResult {
  ok: boolean;
  engine?: Engine;
  reason?: string;
  prompt?: string;
  raw?: string;
  /**
   * Autopilot fallback chain. Present only when the caller passed
   * `autopilot: true` AND the originally requested engine was not
   * the one that ultimately ran. Lets the CLI surface a
   * "you asked for copilot, fell back to claude" message.
   * `original` is the engine the caller requested via --engine.
   * `used` is the engine that actually executed the work.
   */
  fallback?: { original: Engine; used: Engine };
}

const PERMISSION_DENIED_RE = /permission[\s_-]*denied|could not request permission|not authorized/i;
const UNAVAILABLE_RE = /not found|unavailable|not installed|cli not found|missing/i;

/**
 * Pick the best available engine from readiness results.
 * Returns the first ready engine in priority order, or null if none are ready.
 */
export function selectBestEngine(readiness: EngineReadiness[]): Engine | null {
  const ready = new Set(readiness.filter((r) => r.level === "ready").map((r) => r.engine));
  for (const e of ENGINES) {
    if (ready.has(e)) return e;
  }
  // Fallback: engine installed but probe failed or auth issue → try it anyway
  const fallback = new Set(
    readiness
      .filter((r) => r.level === "probe-failed" || r.level === "no-auth")
      .map((r) => r.engine),
  );
  for (const e of ENGINES) {
    if (fallback.has(e)) return e;
  }
  return null;
}

/** List directory entries up to `maxDepth` levels, skipping noise dirs. */
// Test seam: exported so unit tests can exercise the FS catch blocks
// (readdirSync and statSync) without refactoring the production
// call-sites (only runAiInit is reachable in production).
export function dirListing(base: string, maxDepth = 2): string {
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    CTX_DIR,
    ".kiro",
    "__pycache__",
    ".gradle",
    "target",
  ]);
  const lines: string[] = [];
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return;
    // readdirSync on a subdir we just descended into should not
    // throw — but we still guard the statSync call below for
    // broken symlinks (ENOENT) which is a real failure mode.
    const entries = readdirSync(dir);
    for (const entry of entries.slice(0, 60)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const marker = isDir ? "/" : "";
      lines.push(`${prefix}${entry}${marker}`);
      if (isDir && depth < maxDepth) {
        walk(full, depth + 1, `${prefix}  `);
      }
    }
    if (entries.length > 60) lines.push(`${prefix}... (${entries.length - 60} more entries)`);
  };
  walk(base, 0, "  ");
  return lines.join("\n");
}

/** Write full file contents to the ai-context temp dir so the AI can read them directly.
 *
 * If `mkdirSync` fails (e.g. permission denied, read-only fs), all subsequent
 * writes are skipped — no orphaned files, no inner writeFileSync errors.
 */
function writeContextFiles(
  base: string,
  profile: ProjectProfile,
  engines?: string[],
  ctx7Auth?: boolean,
): string[] {
  const ctxDir = join(base, AI_CONTEXT_DIR);
  let canWrite = true;
  try {
    mkdirSync(ctxDir, { recursive: true });
  } catch {
    /* best effort — bail out of the rest, see canWrite below */
    canWrite = false;
  }
  const written: string[] = [];
  if (!canWrite) return written;

  // Write existing instruction files (full content)
  for (const f of instructionFilesForEngines(engines)) {
    const src = join(base, f);
    const dst = join(ctxDir, f);
    try {
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, readFileSync(src, "utf8"));
        written.push(`${AI_CONTEXT_DIR}/${f}`);
      }
    } catch {
      /* best effort */
    }
  }

  // Write PROJECT_CONTEXT.md (full content)
  const ctxPath = join(base, CTX_DIR, "PROJECT_CONTEXT.md");
  if (existsSync(ctxPath)) {
    try {
      writeFileSync(join(ctxDir, "PROJECT_CONTEXT.md"), readFileSync(ctxPath, "utf8"));
      written.push(`${AI_CONTEXT_DIR}/PROJECT_CONTEXT.md`);
    } catch {
      /* best effort */
    }
  }

  // Write project-profile.json for structured data
  try {
    writeFileSync(join(ctxDir, "project-profile.json"), JSON.stringify(profile, null, 2));
    written.push(`${AI_CONTEXT_DIR}/project-profile.json`);
  } catch {
    /* best effort */
  }

  // Write directory listing
  try {
    writeFileSync(join(ctxDir, "directory-listing.txt"), dirListing(base));
    written.push(`${AI_CONTEXT_DIR}/directory-listing.txt`);
  } catch {
    /* best effort */
  }

  // Write the slim-prompt companion file: the bulky "Your Tasks" body
  // lives here, not in the argv prompt. The engine reads it with its
  // own read_file tool (RAG pattern). This keeps the prompt under
  // Windows's 32K cmd-line limit even if the task list grows.
  // Write the slim-prompt companion file: the bulky "Your Tasks" body
  // lives here, not in the argv prompt. The engine reads it with its
  // own read_file tool (RAG pattern). This keeps the prompt under
  // Windows's 32K cmd-line limit even if the task list grows.
  const findSkillsResults = existsSync(join(ctxDir, "find-skills-results.md"));
  try {
    writeFileSync(
      join(ctxDir, INSTRUCTIONS_FILE),
      buildInstructionsBody(engines, ctx7Auth, findSkillsResults),
    );
    written.push(`${AI_CONTEXT_DIR}/${INSTRUCTIONS_FILE}`);
  } catch {
    /* best effort */
  }

  // Write skill standard + taxonomy (copied from src/skills/) so AI reads rules
  // instead of receiving them inline in the prompt.
  for (const ref of ["ANTHROPIC_SKILL_STANDARD.md", "SKILL_TAXONOMY.md"]) {
    try {
      const srcPath = new URL(`./skills/${ref}`, import.meta.url);
      const dstPath = join(ctxDir, ref);
      const text = readFileSync(srcPath, "utf8");
      writeFileSync(dstPath, text);
      written.push(`${AI_CONTEXT_DIR}/${ref}`);
    } catch {
      /* best effort */
    }
  }

  // Render evidence-backed stack table from profile findings
  if (profile.findings?.length) {
    try {
      const evidenceTable = renderFindingsTable(profile.findings);
      writeFileSync(join(ctxDir, "stack-evidence.md"), evidenceTable);
      written.push(`${AI_CONTEXT_DIR}/stack-evidence.md`);
    } catch {
      /* best effort */
    }
  }

  return written;
}

/**
 * Build the slim AI analysis prompt (RAG style).
 *
 * Computes the prompt text first (no disk I/O), then writes the bulky
 * "Your Tasks" body and full project context to `.vibeflow/ai-context/`.
 * The prompt itself stays under ~2K chars — just a project summary, the
 * file list, and a "read INSTRUCTIONS.md first" directive. The engine
 * uses its own `read_file` tool to pull the body. This keeps the prompt
 * well below Windows's 32K cmd-line limit (relevant for copilot)
 * regardless of how detailed tasks get.
 *
 * Computing first lets the caller run a length check (e.g. Windows 32K
 * fail-fast) BEFORE `writeContextFiles` touches disk — saving ~35K chars
 * of orphaned writes when the call would just abort.
 */
export function buildAiInitPrompt(profile: ProjectProfile, base: string, engine?: Engine): string {
  // First compute the prompt text (no disk writes yet). The slim prompt
  // is short, so this is cheap and lets the caller run length checks
  // (e.g. Windows 32K fail-fast) before writeContextFiles touches disk.
  const contextFiles = listContextFiles(base, profile, engine);
  const prompt = renderSlimPrompt(profile, base, contextFiles);

  // Only after we know the prompt is shippable, write the bulky context
  // files to disk for the AI to read.
  writeContextFiles(base, profile, engine ? [engine] : undefined);
  return prompt;
}

/** Plan the file paths that would be written to .vibeflow/ai-context/.
 *  Touches the filesystem (existsSync) but does not WRITE — used by
 *  both buildAiInitPrompt (to pass the list to renderSlimPrompt)
 *  and writeContextFiles (which does the actual disk writes). The
 *  split is intentional: list = read-only probe, write =
 *  side-effectful I/O. Exported so unit tests can probe the list
 *  without going through runAiInit. */
export function listContextFiles(base: string, profile: ProjectProfile, engine?: Engine): string[] {
  const written: string[] = [];
  for (const f of instructionFilesFor(engine)) {
    if (existsSync(join(base, f))) written.push(`${AI_CONTEXT_DIR}/${f}`);
  }
  if (existsSync(join(base, CTX_DIR, "PROJECT_CONTEXT.md"))) {
    written.push(`${AI_CONTEXT_DIR}/PROJECT_CONTEXT.md`);
  }
  written.push(`${AI_CONTEXT_DIR}/project-profile.json`);
  written.push(`${AI_CONTEXT_DIR}/directory-listing.txt`);
  written.push(`${AI_CONTEXT_DIR}/${INSTRUCTIONS_FILE}`);
  written.push(`${AI_CONTEXT_DIR}/ANTHROPIC_SKILL_STANDARD.md`);
  written.push(`${AI_CONTEXT_DIR}/SKILL_TAXONOMY.md`);
  if (profile.findings?.length) written.push(`${AI_CONTEXT_DIR}/stack-evidence.md`);
  return written;
}

/** Render the slim prompt body (no disk I/O, no I/O at all). The
 *  engine is told to use its Read tool to pull the bulky task body
 *  from INSTRUCTIONS.md on disk. Exported for unit-test isolation
 *  (so tests can assert prompt structure without going through
 *  runAiInit or writeContextFiles). */
export function renderSlimPrompt(
  profile: ProjectProfile,
  base: string,
  contextFiles: string[],
): string {
  const langList = profile.languages.length ? profile.languages.join(", ") : "unknown";
  const fwList = profile.frameworks.length ? profile.frameworks.join(", ") : "none detected";
  const pkgMgr = profile.packageManager ?? "unknown";
  const build = profile.buildCommand ?? "(not found)";
  const test = profile.testCommand ?? "(not found)";
  const lint = profile.lintCommand ?? "(not found)";
  const hasCI = profile.hasCI ? "yes" : "no";
  const summary = profile.summary ?? "(no README summary)";
  const manifests = profile.manifests.length ? profile.manifests.join(", ") : "none";

  // Put INSTRUCTIONS.md first in the file list so the engine reads it
  // before project-specific data.
  const reordered = [
    `${AI_CONTEXT_DIR}/${INSTRUCTIONS_FILE}`,
    ...contextFiles.filter((f) => f !== `${AI_CONTEXT_DIR}/${INSTRUCTIONS_FILE}`),
  ];
  const contextFileList = reordered.map((f) => `- \`${f}\``).join("\n");

  return [
    "## VibeFlow AI-Powered Project Initialization",
    "",
    "You are an AI agent performing project initialization for VibeFlow (`vf init`).",
    "Your working directory IS the project root. Use your Read/Edit tools to act on the files listed below.",
    "",
    "## Workflow (RAG pattern)",
    `1. Read \`${AI_CONTEXT_DIR}/${INSTRUCTIONS_FILE}\` FIRST — it contains the full task list, confidence gate, and output format.`,
    `2. Read every other file under \`${AI_CONTEXT_DIR}/\` listed below.`,
    "3. Follow the tasks in INSTRUCTIONS.md end-to-end.",
    "",
    "## Project Detection (summary)",
    `- Name: ${profile.name}`,
    `- Summary: ${summary}`,
    `- Languages: ${langList}`,
    `- Frameworks: ${fwList}`,
    `- Package manager: ${pkgMgr}`,
    `- Build: ${build}`,
    `- Test: ${test}`,
    `- Lint: ${lint}`,
    `- CI: ${hasCI}`,
    `- Manifests: ${manifests}`,
    "",
    "## Context Files (read in this order)",
    "Full content of each is on disk — read with your Read tool, do not guess from this summary:",
    "",
    contextFileList,
    "",
    "For existing instruction files (CLAUDE.md, AGENTS.md, etc.), prefer the",
    "copy under `.vibeflow/ai-context/` (exact state at init time) unless",
    "the task says otherwise.",
  ].join("\n");
}

export interface AiInitOpts {
  base: string;
  timeoutMs?: number;
  dryRun?: boolean;
  spawner?: AsyncSpawner;
  /** When set, skip ready check and use this engine directly (for --engine flag). */
  forceEngine?: Engine;
  /**
   * When true, fall back to the next-best ready engine if the chosen
   * engine is unavailable OR returns a permission/unauthorized error.
   * Capped at 3 retries; the fallback engine must be DIFFERENT from
   * the one that just failed (no point retrying the same engine).
   * The result includes `fallback: { original, used }` so the caller
   * can surface "you asked for X, ran on Y".
   */
  autopilot?: boolean;
  /** Inject preflight for tests (avoids live engine probes). */
  preflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
  /** CLI-side ctx7 auth state. false means use fallback without prompting login. */
  ctx7Auth?: boolean;
  /** Streaming callbacks forwarded to internal spawners (shell pipe path). */
  onChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
  // Test seam: lets unit tests inject a custom engineCommand to
  // simulate the copilot-unavailable path (line 492) without
  // depending on the real PATH.
  engineCommandFn?: (engine: Engine) => EngineCommandResult;
  // Test seam: lets unit tests inject a stubbed prompt to keep the
  // runAiInit test fast and decoupled from the real profile/scanner.
  buildPrompt?: (profile: ProjectProfile, base: string) => string;
  // Test seam: lets unit tests inject a custom makeAsyncSpawner
  // to exercise the shell-pipe timedOut branch (line 528-533)
  // without waiting for the real timeout.
  makeAsyncSpawner?: typeof makeAsyncSpawner;
  /**
   * Test seam: lets unit tests inject a custom per-iteration
   * executor. The autopilot loop calls this in place of the real
   * `runAiInitOnce` to simulate unreachable code paths (e.g. the
   * post-loop fallback). Production callers never set this.
   */
  runOnceForTest?: (
    opts: AiInitOpts,
    tried: Set<Engine>,
    cachedPrompt?: string,
    cachedProfile?: ProjectProfile,
  ) => Promise<AiInitResult & { __profile?: ProjectProfile }>;
}

/** Hard cap on autopilot retries. No point looping if all 3 alternatives also fail. */
const AUTOPILOT_MAX_RETRIES = 3;

/**
 * Run the AI-powered init phase.
 *
 * 1. Check engine readiness (or use forced engine)
 * 2. Scan the project
 * 3. Build the analysis prompt (writes full context files, no truncation)
 * 4. Spawn the engine headless with the prompt
 * 5. Return the result
 *
 * The engine writes files directly in the project directory via its own tools.
 * On failure, the caller's Phase 1 deterministic output remains intact.
 *
 * Autopilot mode: when `opts.autopilot === true`, if the chosen engine is
 * unavailable OR returns a permission/unauthorized error, retry with the
 * next-best ready engine (skipping already-tried ones). Capped at
 * {@link AUTOPILOT_MAX_RETRIES} retries. Non-autopilot callers see the
 * pre-existing single-shot behavior — the autopilot loop is opt-in.
 */
export async function runAiInit(opts: AiInitOpts): Promise<AiInitResult> {
  const { autopilot = false } = opts;
  const originalRequested = opts.forceEngine;

  // Autopilot loop. The no-autopilot path is a single iteration (skip the
  // while loop). Each iteration can re-evaluate readiness and pick a
  // different engine. The loop ends on success, on a non-retryable error,
  // or when retries are exhausted.
  const tried = new Set<Engine>();
  let lastResult: AiInitResult | null = null;
  let prompt: string | undefined;
  let profile: ProjectProfile | null = null;

  for (let attempt = 0; attempt <= AUTOPILOT_MAX_RETRIES; attempt++) {
    // Per-iteration opts: when autopilot has already fallen back from
    // `forceEngine`, clear `forceEngine` so the next iteration picks
    // the next-best engine instead of stubbornly retrying the same one.
    const iterOpts: AiInitOpts =
      autopilot && opts.forceEngine && tried.size > 0 ? { ...opts, forceEngine: undefined } : opts;
    const result: AiInitResult & { __profile?: ProjectProfile; __break?: boolean } =
      opts.runOnceForTest
        ? await opts.runOnceForTest(iterOpts, tried, prompt ?? undefined, profile ?? undefined)
        : await runAiInitOnce(iterOpts, tried, prompt ?? undefined, profile ?? undefined);
    // Test seam: a stubbed runOnceForTest can return a `__break: true`
    // marker to force the loop to fall off the end without returning.
    // This exercises the post-loop fallback in tests.
    if ((result as { __break?: boolean }).__break) {
      lastResult = result as AiInitResult;
      break;
    }
    if (result.ok) {
      if (autopilot && originalRequested && result.engine && result.engine !== originalRequested) {
        result.fallback = { original: originalRequested, used: result.engine };
      }
      return result;
    }
    lastResult = result;
    prompt = opts.buildPrompt ? result.prompt : undefined;
    profile = (result as { __profile?: ProjectProfile }).__profile ?? profile;
    // Track which engine we just attempted (or would have attempted,
    // in the engine-selection-failure case). Adding to `tried` is
    // critical even when `result.engine` is undefined: it prevents the
    // next iteration from picking the same (unready) engine again.
    // For the "forceEngine is not ready" case the candidate we just
    // rejected was the requested engine itself, even though we never
    // actually executed against it.
    const candidateThisAttempt = result.engine ?? originalRequested;
    if (candidateThisAttempt) tried.add(candidateThisAttempt);
    if (!autopilot) return result;
    // Retryable conditions (autopilot only):
    //   1. ForceEngine was requested and is not ready (engine === undefined
    //      on first iteration only — once tried.size > 0 we already cleared
    //      forceEngine and the next iteration picks the best available).
    //   2. Invocation reported the engine as unavailable (CLI missing).
    //   3. Spawner returned a permission-denied / unauthorized pattern.
    // Non-retryable: timeouts and unknown non-zero status codes.
    const reason = result.reason ?? "";
    const isPermission = PERMISSION_DENIED_RE.test(reason);
    const isInvocationUnavail =
      result.engine !== undefined && UNAVAILABLE_RE.test(reason) && !result.raw;
    const isForceUnready =
      result.engine === undefined && attempt === 0 && originalRequested !== undefined;
    if (!isPermission && !isInvocationUnavail && !isForceUnready) {
      // Not a retryable failure. Two wrapping paths:
      //   (a) "exhausted autopilot fallbacks" — when autopilot was on
      //       AND the loop has already retried (tried.size > 1) AND
      //       we are past the first attempt. A single failure with
      //       no fallbacks attempted is just a plain failure (don't
      //       wrap it with the "exhausted" message).
      //   (b) "forced engine X is not ready" — when a specific engine
      //       was requested and no candidate was reachable.
      if (originalRequested && !result.engine) {
        return {
          ...result,
          reason: `forced engine ${originalRequested} is not ready and no fallback engine is available — run \`vf doctor --probe\` to diagnose`,
        };
      }
      if (tried.size > 1 && autopilot) {
        return {
          ...result,
          reason: `${result.engine ?? "engine"} ${result.reason ?? "failed"} — exhausted ${AUTOPILOT_MAX_RETRIES} autopilot fallbacks; original request was ${originalRequested ?? "auto"}`,
        };
      }
      return result;
    }
    // Retryable: continue the loop. The for-loop's `attempt <=
    // AUTOPILOT_MAX_RETRIES` guard means we never exceed the budget
    // — the "exhausted" message is emitted from the non-retryable
    // branch above when we run out of candidates.
  }

  // TS-required return for code paths that fall off the end of the
  // loop. The loop body's return paths cover every iteration in
  // practice, so this is a defensive default.
  return (
    lastResult ?? {
      ok: false,
      reason: "autopilot loop exited without a result",
    }
  );
}

/**
 * Run a single attempt of the AI init against a specific engine. The
 * caller (runAiInit) is responsible for selecting which engine and
 * looping on autopilot. This function does not know about retries.
 *
 * The `tried` set lets the autopilot loop pass already-failed engines
 * down to the next-best selector so we never retry the same engine
 * twice in one run.
 */
async function runAiInitOnce(
  opts: AiInitOpts,
  tried: Set<Engine> = new Set(),
  cachedPrompt?: string,
  cachedProfile?: ProjectProfile,
): Promise<AiInitResult & { __profile?: ProjectProfile }> {
  const {
    base,
    timeoutMs = AI_INIT_TIMEOUT_MS,
    dryRun = false,
    spawner,
    forceEngine,
    preflight,
  } = opts;

  // Determine which engine to use. With `tried` (from the autopilot
  // loop), pick the best non-already-tried engine.
  const probe = preflight ?? ((engines, pg) => preflightAll(engines, pg));
  const readiness = probe(ENGINES, { probe: true });
  let engine: Engine | null = null;
  if (forceEngine) {
    const match = readiness.find((r) => r.engine === forceEngine && r.level === "ready");
    engine = match ? forceEngine : null;
  } else {
    const base = selectBestEngine(readiness);
    // If the autopilot loop has already failed an engine, the
    // next-best selector should skip it. We do that here (locally) by
    // re-running selectBestEngine against a synthetic readiness list
    // that downgrades the tried engines below all other ready ones.
    if (tried.size > 0 && base) {
      const filtered = readiness.map((r) =>
        tried.has(r.engine) ? { ...r, level: "no-binary" as const } : r,
      );
      engine = selectBestEngine(filtered);
    } else {
      engine = base;
    }
  }

  if (!engine) {
    return {
      ok: false,
      reason: forceEngine
        ? `forced engine ${forceEngine} is not ready — run \`vf doctor --probe\` to diagnose`
        : "no ready engine found — run `vf doctor --probe` to check engine status",
    };
  }

  // Scan the project (cached across attempts so we don't re-scan
  // the same project multiple times in an autopilot fallback chain).
  const profile = cachedProfile ?? scanRepo(base);

  // Build the prompt text WITHOUT writing context files yet. The slim
  // prompt is short, so this is cheap and lets us run the Windows 32K
  // fail-fast below BEFORE writeContextFiles touches disk (saves ~35K
  // chars of writes when we would just abort). Test seam: allow tests
  // to inject a stubbed prompt to exercise the >30000 char threshold
  // without depending on the real profile.
  const prompt =
    cachedPrompt ??
    (opts.buildPrompt
      ? opts.buildPrompt(profile, base)
      : renderSlimPrompt(profile, base, listContextFiles(base, profile, engine)));

  // The original promptFile write/read block (Task 7 follow-up) was
  // DEAD CODE: claude and codex read prompts from stdin (no file
  // needed); copilot has no --prompt-file flag and the file content
  // was ultimately put back on cmd-line as argv anyway, defeating
  // the original purpose of bypassing Windows's 32K argv limit.
  // We just pass the prompt inline as argv and let Windows complain
  // if it's > 32K (fail-fast below).

  // Dry run: return prompt without writing context files or spawning
  if (dryRun) {
    return {
      ok: true,
      engine,
      prompt,
      reason: "dry run — prompt ready for inspection",
      __profile: profile,
    };
  }

  // Resolve engine invocation
  const invocation: EngineCommandResult = (opts.engineCommandFn ?? engineCommand)(engine);

  if (isUnavailable(invocation)) {
    // Write context files before returning — they are still useful
    // diagnostic output for the caller.
    writeContextFiles(base, profile, [engine], opts.ctx7Auth);
    return { ok: false, engine, reason: invocation.unavailable, prompt, __profile: profile };
  }

  // Windows cmd-line length guard for copilot. If the prompt is too
  // long to fit on cmd-line, fail-fast with a clear message instead
  // of letting Windows produce a confusing "command line too long"
  // error or copilot's silent interactive mode fallback. The 32K
  // argv limit is a hard constraint: copilot has no --prompt-file
  // flag, and claude/codex read from stdin (so they are not
  // affected). Switch to claude or codex for huge prompts.
  //
  // This check runs BEFORE writeContextFiles so we don't leave ~35K
  // chars of orphaned context files on disk when the call would just
  // abort. contextFiles were already listed above (pure / no I/O).
  if (process.platform === "win32" && engine === "copilot" && prompt.length > 30_000) {
    return {
      ok: false,
      engine,
      reason: `copilot prompt is ${prompt.length} chars; Windows cmd-line limit is ~32K. Switch to claude or codex (they read from stdin).`,
      prompt,
      __profile: profile,
    };
  }

  // Prompt is shippable — now write the bulky context files for the AI.
  writeContextFiles(base, profile, [engine], opts.ctx7Auth);

  // Handle the copilot promptMode: prompt goes as -p value
  const materialized = materializePrompt(
    { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
    prompt,
  );
  const args = materialized.args;
  const input = materialized.input;

  // Spawn the engine via direct Bun.spawn
  const asyncSpawn = spawner ?? makeAsyncSpawner({ timeoutMs });

  const result = await asyncSpawn(materialized.cmd, args, input);

  if (result.timedOut) {
    return {
      ok: false,
      engine,
      reason: `${engine} AI analysis timed out after ${timeoutMs / 1000}s — deterministic context files are in place`,
      raw: result.stdout,
      __profile: profile,
    };
  }

  if (result.status !== 0) {
    const r = result as { status: number; stdout: string; stderr?: string; timedOut?: boolean };
    const stderrHint = r.stderr ? ` — ${r.stderr.slice(0, 500)}` : "";
    return {
      ok: false,
      engine,
      reason: `${engine} exited with status ${result.status}${stderrHint}`,
      raw: result.stdout,
      __profile: profile,
    };
  }

  return { ok: true, engine, raw: result.stdout, __profile: profile };
}

// ---------------------------------------------------------------------------
// Workflow-shaped AI init (agent team via the orchestrator).
//
// The legacy `runAiInit` above runs a single mega-prompt and the engine
// owns the entire flow end-to-end. `runAiInitWorkflow` (added in the
// agent-team refactor) decomposes the same surface into 4 parallel work
// units (analyzer, instruction-writer, skill-curator, context-updater),
// dispatches them through `orchestrateUnits` with the existing bounded-
// parallel + reviewer + goalEval gates, and returns a structured
// per-unit outcome.
//
// The old path is preserved for callers that haven't opted in (the
// dry-run preview in `vf init --ai --dry` and existing unit tests).
// ---------------------------------------------------------------------------

/** Result of the workflow-shaped AI init. Reports per-unit status
 *  alongside the aggregate verdict. */
export interface AiInitWorkflowResult {
  ok: boolean;
  engine?: Engine;
  reason?: string;
  /** Per-unit work-unit state (post-dispatch). Empty when the planner
   *  produced no units or the run failed before dispatch. The
   *  orchestrator preserves each input's shape (via `...unit` in
   *  applyOutcome), so AiInitUnit fields like `acceptance` are kept
   *  (MINOR-5: typed as AiInitUnit[] here, not WorkUnit[]). */
  units: AiInitUnit[];
  /** Per-unit review verdicts in dispatch order. */
  reviews: Array<{ unit: string; pass: boolean; reason: string }>;
  /** True when every unit passed review and reached confidence 1.0. */
  goalMet: boolean;
  /** How the workflow was blocked (when ok=false). Distinguishes the
   *  pre-dispatch "no engine" case from the mid-flight "engine failed"
   *  case so the CLI can pick the right recovery message. */
  blockKind?: "no-engine" | "engine-failed" | "wave-blocked";
  /** When the workflow was blocked mid-flight, the units that DID pass
   *  before the block. Always a subset of `units` (those with status
   *  "verifying" / "done"). Empty when the block happened at the
   *  pre-dispatch preflight (no engine ready). */
  passedUnits?: string[];
  /** P0-4: units held back because quota was below the skip threshold.
   *  These were never dispatched (no engine call), so they did not
   *  consume any rate-limit budget. The user can re-run `vf init`
   *  after the quota window resets to get them. Empty when the
   *  quota was healthy enough to dispatch everything. */
  skippedUnits?: string[];
}

/** Options for {@link runAiInitWorkflow}. */
export interface AiInitWorkflowOpts {
  base: string;
  /** Trimmed intake answers (used to drive the per-unit spec). */
  intake: AiInitIntake;
  /** Engine to dispatch each unit to. When set, the planner skips the
   *  best-engine selection and pins the call. */
  forceEngine?: Engine;
  /** Test seam: same surface as `runAiInit`'s preflight (avoids live
   *  engine probes). */
  preflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
  /** Injected dispatcher so unit tests can drive the orchestrator
   *  without spawning real engines. Production callers omit this and
   *  `runAiInitWorkflow` constructs `defaultAiInitDispatcher(engine)`
   *  internally (passing through the `engineCommandFn` + `spawner`
   *  seams below). */
  dispatcher?: UnitDispatcher;
  /** Bounded-parallel concurrency. Defaults to DEFAULT_CONCURRENCY (3). */
  concurrency?: number;
  /**
   * Force wave-0 (the adapters with no dependencies — analyzer,
   * instruction-writer, tool-configurator) to run sequentially
   * (concurrency=1) even when `concurrency` is set higher. Wave 1+
   * still runs with the configured concurrency. Default true.
   *
   * Rationale: Copilot / Claude / Codex treat parallel calls as a
   * burst and are more likely to rate-limit the wave. The wave-0
   * units are also the cheapest per-call, so the wall-clock cost
   * of serializing them is small (~2-4s) compared to the savings
   * in rate-limit risk. Set to false to restore the old parallel
   * behavior (e.g. for local engines with no quota). */
  sequentialWave0?: boolean;
  /**
   * Inter-unit delay (ms) inside a single wave. Default 0 (no
   * delay). When > 0, each unit waits `min + jittered(0..jitter)`
   * ms before starting, where `jitter` defaults to the same value.
   * Staggers parallel-ish calls so the engine sees a steadier
   * request stream instead of bursts. Pair with low `concurrency`
   * to mimic a sequential call shape while keeping wave structure. */
  interUnitDelayMs?: number;
  /** Test seam: forwards to `defaultAiInitDispatcher` when the default
   *  dispatcher is constructed. Mirrors `runAiInit`'s option. */
  engineCommandFn?: (engine: Engine) => EngineCommandResult;
  /** Test seam: forwards to `defaultAiInitDispatcher`. Mirrors
   *  `runAiInit`'s `spawner` option. */
  spawner?: AsyncSpawner;
  /** Test seam: per-unit engine-call timeout. Defaults to
   *  `AI_INIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** CLI-side ctx7 auth state. false means generated instructions/specs use fallback. */
  ctx7Auth?: boolean;
  /**
   * P0-4: optional pre-flight quota state. When supplied and the
   * remaining quota is below `quotaSkipFinisherBelowPct` (default
   * 20%), the four optional finisher units (tool-configurator,
   * workflow-policy-writer, workflow-state-writer, quickstart-writer)
   * are NOT dispatched. They are reported as `skipped: low-quota`
   * on the workflow result so the user can see what was held back
   * and re-run `vf init` after the quota window resets to get the
   * rest. Phase-skill enrichment and the 4 core adapters
   * (analyzer / instruction-writer / skill-curator / context-updater)
   * are NEVER skipped — they produce the reusable artifacts that
   * the rest of VibeFlow depends on. */
  quotaStatus?: QuotaStatus;
  /** Percent remaining (0-100) below which finishers are skipped.
   *  Default 20. Set to 0 to disable quota-aware skipping. */
  quotaSkipFinisherBelowPct?: number;
  /**
   * P1-4: backoff overrides for the default dispatcher. The CLI
   * init path sets `maxRetries=3` + `backoffCapMs=120_000` so a
   * transient 429 has 4 chances to recover with up to 2-minute
   * waits between tries. Other callers (e.g. `vf orchestrate`)
   * keep the strict defaults (2 retries, 60s cap) for faster
   * failure feedback. */
  dispatcherMaxRetries?: number;
  dispatcherBackoffBaseMs?: number;
  dispatcherBackoffCapMs?: number;
  /**
   * P1-7: collapse the four optional finisher adapters into a
   * single `ai-init-finishers-batch` unit (default true). One
   * engine call instead of four. Set to false to restore the
   * per-finisher shape (used by tests that assert on individual
   * unit names). */
  batchFinishers?: boolean;
}

/** Build the default dispatcher: per unit, run a single engine call with
 *  the unit's `spec` as the prompt. Returns a `UnitOutcome` whose
 *  evidence cites the unit's `scope` paths (so the reviewer can gate
 *  on real on-disk artifacts via the file-exists check).
 *
 *  This is the production dispatcher; tests inject a fake dispatcher
 *  (or a fake `engineCommandFn` + `spawner`) to stay deterministic.
 *
 *  Contract: status="verifying" on success (production never says "done"
 *  — the reviewer must), confidence=1, evidence=unit.scope. status="blocked"
 *  on any engine error (timeout, non-zero exit, unavailable binary), with
 *  evidence=[] so the reviewer rejects the unit deterministically.
 *
 *  Retry policy: when the engine exits non-zero with a rate-limit signal
 *  (HTTP 429, "rate limit", "too many requests"), the dispatcher retries
 *  the same call up to `maxRetries` times with exponential backoff +
 *  full jitter, honoring a server `retry-after` hint as a floor. This
 *  prevents one transient Copilot / Claude / Codex rate-limit from
 *  poisoning an entire agent-team wave (previously a single 429 on the
 *  workflow-state-writer took out the whole final wave). Other non-zero
 *  exits (auth, syntax, missing binary) are NOT retried — retrying
 *  cannot help. */
export function defaultAiInitDispatcher(
  engine: Engine,
  opts: {
    engineCommandFn?: (engine: Engine) => EngineCommandResult;
    spawner?: AsyncSpawner;
    timeoutMs?: number;
    /** Max retry attempts on a rate-limit signal. Default 2 (3 total tries). */
    maxRetries?: number;
    /** Base delay (ms) for exponential backoff. Default 2000. */
    backoffBaseMs?: number;
    /** Cap (ms) on a single backoff delay. Default 60000. */
    backoffCapMs?: number;
    /** Test seam: inject a sleep fn to keep the suite deterministic. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): UnitDispatcher {
  const {
    engineCommandFn,
    spawner,
    timeoutMs = AI_INIT_TIMEOUT_MS,
    maxRetries = 2,
    backoffBaseMs = 2000,
    backoffCapMs = 60_000,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  const resolveInvocation = engineCommandFn ?? engineCommand;
  const asyncSpawn = spawner ?? makeAsyncSpawner({ timeoutMs });
  // Probe the engine invocation once at dispatcher construction time so we can
  // surface the copilot `--version` warning (github/copilot-cli#1606 class —
  // silent breaking auto-updates that drop `-p --allow-all`). The legacy
  // `runAiInit` path surfaces this via `announceLaunch`; the agent-team path
  // never calls that, so we have to do it here. Warn-once is the right call
  // because the warning is per-installation, not per-unit — but since a single
  // dispatcher handles all units, emitting on the first invocation is fine
  // (and avoids per-unit stderr noise on the typical 7-unit agent-team run).
  const probedInvocation = resolveInvocation(engine);
  let warnedDegraded = false;
  return async (unit): Promise<UnitOutcome> => {
    const invocation = probedInvocation;
    if (isUnavailable(invocation)) {
      // Surface the engine's reason so callers and CI logs can see why
      // the workflow blocked. Stderr (for the user) + evidence marker
      // (for the workflow-level summary).
      const reason = invocation.unavailable;
      process.stderr.write(`[ai-init-dispatcher] engine ${engine} unavailable: ${reason}\n`);
      return {
        status: "blocked",
        confidence: 0,
        evidence: [`engine-unavailable:${engine}:${reason}`],
      };
    }
    if (invocation.warning && !warnedDegraded) {
      warnedDegraded = true;
      process.stderr.write(`[ai-init-dispatcher] ${engine}: ${invocation.warning}\n`);
    }
    const materialized = materializePrompt(
      { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
      unit.spec ?? "",
    );
    // Retry loop: a transient rate-limit should not poison the whole wave.
    // We retry only when `detectQuota` flags a retryable signal (HTTP 429,
    // "rate limit", "too many requests") with high confidence. Other
    // non-zero exits fall through immediately — no point retrying a
    // syntax error or auth failure.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await asyncSpawn(materialized.cmd, materialized.args, materialized.input);
      if (result.timedOut) {
        const reason = `timed out after ${timeoutMs}ms`;
        process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
        return {
          status: "blocked",
          confidence: 0,
          evidence: [`dispatcher-timeout:${unit.name}:${reason}`],
        };
      }
      if (result.status === 0) {
        return {
          status: "verifying",
          confidence: 1,
          evidence: [...(unit.scope ?? [])],
        };
      }
      const sig = detectQuota({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr ?? "",
      });
      const plan = backoffPlan(sig, attempt, {
        baseMs: backoffBaseMs,
        capMs: backoffCapMs,
        maxRetries,
      });
      if (plan.retry) {
        process.stderr.write(
          `[ai-init-dispatcher] ${unit.name} ${sig.kind ?? "rate-limited"} ` +
            `(exit ${result.status}); retrying in ${plan.delayMs}ms ` +
            `(attempt ${attempt + 1}/${maxRetries})\n`,
        );
        await sleep(plan.delayMs);
        continue;
      }
      const reason = `exit ${result.status}`;
      process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
      return {
        status: "blocked",
        confidence: 0,
        evidence: [`dispatcher-nonzero:${unit.name}:${reason}`],
      };
    }
    // Unreachable: the loop returns on every path (last attempt's
    // plan.retry is false because attempt >= maxRetries). Defensive
    // fallback so the type checker is happy.
    const reason = `exit after ${maxRetries + 1} attempts`;
    process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
    return {
      status: "blocked",
      confidence: 0,
      evidence: [`dispatcher-nonzero:${unit.name}:${reason}`],
    };
  };
}

/**
 * Run the workflow-shaped AI init. Decomposes the surface into 4
 * parallel units via `planAiInitUnits`, dispatches through
 * `orchestrateUnits` with `aiInitReviewer`, and aggregates the result.
 *
 * This is the new entry point for callers that want the agent-team
 * shape (analyzer / instruction-writer / skill-curator / context-updater
 * dispatched in parallel with an independent reviewer per unit). The
 * legacy `runAiInit` stays for backward compatibility.
 */
export async function runAiInitWorkflow(opts: AiInitWorkflowOpts): Promise<AiInitWorkflowResult> {
  const { base, intake, forceEngine, preflight, concurrency, ctx7Auth } = opts;

  // Scan repo + detect roles so the planner can interpolate them.
  const profile = scanRepo(base);
  const detectedRoles = detectRolesForRepo(base, profile);

  // F3 + F4: pre-create .vibeflow/ai-context/ and all deterministic
  // context files (stack-evidence.md, project-profile.json, etc.) so
  // the engine never hits "parent directory does not exist" and the
  // reviewer's file-exists check passes even if the engine is transient.
  writeContextFiles(base, profile, intake.engines, ctx7Auth);
  // Also pre-create directory-scope items (e.g. .vibeflow/skills/) so
  // the reviewer's pathIsDir check passes when the engine cites them.
  mkdirSync(join(base, CTX_DIR, "skills"), { recursive: true });

  // Resolve engine (mirrors runAiInit's preflight logic).
  const probe = preflight ?? ((engines, pg) => preflightAll(engines, pg));
  let engine: Engine | null = null;
  if (forceEngine) {
    // Probe ONLY the forced engine — probing all 3 engines just to look up a
    // single entry in the readiness array is wasted work (~2 extra CLI calls
    // per init, multiplied by every unit in the agent-team run). The
    // preflight() contract still takes an array, so we hand it [forceEngine].
    const readiness = probe([forceEngine], { probe: true });
    const match = readiness.find((r) => r.engine === forceEngine && r.level === "ready");
    engine = match ? forceEngine : null;
  } else {
    const readiness = probe(ENGINES, { probe: true });
    engine = selectBestEngine(readiness);
  }
  if (!engine) {
    return {
      ok: false,
      blockKind: "no-engine",
      reason: forceEngine
        ? `forced engine ${forceEngine} is not ready — run \`vf doctor --probe\` to diagnose`
        : "no ready engine found — run `vf doctor --probe` to check engine status",
      units: [],
      reviews: [],
      goalMet: false,
    };
  }

  // Decompose into work units.
  const plannerIntake: AiInitIntake = {
    ...intake,
    engines: intake.engines?.length ? intake.engines : [engine],
    ctx7Authenticated: intake.ctx7Authenticated ?? ctx7Auth,
  };
  const adapterUnits = planAiInitUnits(profile, plannerIntake, detectedRoles).filter(
    (e) => !e.name.startsWith("ai-init-phase"),
  );

  // P1-7: by default, collapse the four optional finisher adapters
  // (tool-configurator, workflow-policy/state-writer, quickstart-writer)
  // into a single `ai-init-finishers-batch` unit. This replaces 4
  // separate engine calls (~400-800k tokens total) with one batched
  // call (~200-300k tokens). Set `batchFinishers: false` in opts to
  // restore the per-finisher shape (e.g. for tests that assert on
  // individual unit names).
  const batchFinishers = opts.batchFinishers !== false;
  let adapterUnitsFinal: AiInitUnit[] = adapterUnits;
  if (batchFinishers) {
    const finisherNames = new Set<string>(AI_INIT_FINISHER_NAMES as ReadonlySet<string>);
    const kept = adapterUnits.filter((u) => !finisherNames.has(u.name));
    const batchUnit = buildFinisherBatchUnit(profile, plannerIntake, detectedRoles);
    adapterUnitsFinal = [...kept, batchUnit];
  }

  // Build phase-skill enrichment unit(s) for phases with I/O paths.
  // These read the declared input files and rewrite the canonical
  // phase skill template into a reusable, project-aware template.
  // The current shape is a single batched unit covering all phases
  // (was N units — one per phase). The batched unit's own spec sets
  // `depends_on: ["ai-init-analyzer"]`, so this loop is now a no-op
  // but kept for back-compat (in case the builder ever returns >1 unit).
  const enrichmentTarget: (e: Engine, slug: string) => string = (_e, slug) =>
    `${CTX_DIR}/skills/${slug}/SKILL.md`;
  const enrichmentUnits = buildPhaseSkillEnrichmentUnits(plannerIntake, [engine], enrichmentTarget);
  for (const u of enrichmentUnits) {
    u.depends_on = ["ai-init-analyzer"];
  }

  // P0-4: quota-aware finisher skip. When the engine reports low
  // remaining quota (e.g. <20%) we hold back the optional finisher
  // unit to preserve the core workflow. With P1-7 the four per-
  // finisher units are collapsed into a single
  // `ai-init-finishers-batch`, so we only need to skip that one
  // unit (it owns the same 4 output paths). The 4 CORE adapters
  // (analyzer, instruction-writer, skill-curator, context-updater)
  // and the phase-skill enrichment are NEVER skipped — they are
  // the load-bearing outputs the rest of VibeFlow consumes.
  const skipFinisherBelow = opts.quotaSkipFinisherBelowPct ?? 20;
  const skippedFinisherNames: string[] = [];
  let dispatchable = [...adapterUnitsFinal, ...enrichmentUnits];
  if (opts.quotaStatus && skipFinisherBelow > 0) {
    const remaining = opts.quotaStatus.percentRemaining;
    if (remaining !== undefined && remaining < skipFinisherBelow) {
      const kept: AiInitUnit[] = [];
      for (const u of dispatchable) {
        if (
          u.name === "ai-init-finishers-batch" ||
          AI_INIT_FINISHER_NAMES.has(u.name as AiInitAdapterName)
        ) {
          // Hold back the optional finisher batch. status="skipped"
          // is not in the unit-status union, so we record the name
          // and drop the unit from the dispatch list — the caller
          // can re-run after the quota window resets to fill in.
          skippedFinisherNames.push(u.name);
          continue;
        }
        kept.push(u);
      }
      if (skippedFinisherNames.length > 0) {
        process.stderr.write(
          `[ai-init] quota at ${remaining?.toFixed(1)}% — skipping ${skippedFinisherNames.length} ` +
            `optional finisher unit(s) to preserve core workflow: ${skippedFinisherNames.join(", ")}\n`,
        );
      }
      dispatchable = kept;
    }
  }
  const units = dispatchable;

  // Dispatch through the orchestrator. The injected dispatcher defaults
  // to a placeholder (so unit tests stay deterministic); production
  // Construct the default dispatcher (B3/T2): per-unit engine call, with
  // the test seams (engineCommandFn, spawner, timeoutMs) forwarded so
  // production calls go live and tests stay deterministic. Callers may
  // still inject a custom dispatcher via `opts.dispatcher`.
  //
  // P1-4: the CLI init path passes generous backoff defaults
  // (maxRetries=3, cap=120s) — Copilot free/individual tier has a
  // tight per-hour quota and one transient 429 should not take out
  // the whole wave. The legacy defaults (2/60s) are kept for
  // callers that want strict fail-fast (e.g. CI pipelines).
  const dispatcher =
    opts.dispatcher ??
    defaultAiInitDispatcher(engine, {
      engineCommandFn: opts.engineCommandFn,
      spawner: opts.spawner,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.dispatcherMaxRetries,
      backoffBaseMs: opts.dispatcherBackoffBaseMs,
      backoffCapMs: opts.dispatcherBackoffCapMs,
    });

  // Schedule units into parallel waves based on `depends_on`. Units in
  // the same wave run concurrently; waves run sequentially so the
  // engine-mirror fan-out is bounded by the selected engine.
  const waves = scheduleAiInitWaves(units);

  // Run waves sequentially. Inside each wave, units are dispatched in
  // parallel. This replaces the previous flat-parallel dispatch which
  // let skill-curator start before stack-evidence.md was written.
  const allUnits: AiInitUnit[] = [];
  const allReviews: Array<{ unit: string; pass: boolean; reason: string }> = [];
  for (const wave of waves) {
    // Deterministic pre-wave step: run whitelist-based skill curation
    // BEFORE the AI skill-curator unit fires. This ensures:
    // 1. stack-evidence.md is already written (analyzer finished in wave 0)
    // 2. ctx7 installs go to scratch dir deterministically (no AI guesswork)
    // 3. The AI skill-curator only handles fallback gaps (unmatched tech)
    if (wave.includes("ai-init-skill-curator") && base && engine) {
      const result = curateSkillsFromEvidence(base, engine, {
        ctx7Authenticated: opts.ctx7Auth,
      });
      if (result.installed.length > 0) {
        process.stderr.write(
          `[curator] whitelist installed ${result.installed.length} skill(s): ${result.installed.join(", ")}\n`,
        );
      }
      if (result.unmatched.length > 0) {
        process.stderr.write(
          `[curator] ${result.unmatched.length} tech(s) unmatched — AI skill-curator should handle: ${result.unmatched.join(", ")}\n`,
        );
      }
    }
    const waveUnits = units.filter((u) => wave.includes(u.name));
    // P0-2: wave 0 is the first wave in the schedule. By default we
    // serialize it (concurrency=1) to avoid the burst-call rate-limit
    // cliff that Copilot/Claude/Codex hit when 3+ adapter calls
    // land within the same second. Wave 1+ (which only contains
    // downstream units whose deps are now satisfied) still runs with
    // the user-requested concurrency — the wins from rate-limit
    // avoidance outweigh the wall-clock cost on the cheap wave 0.
    // P0-3: inter-unit delay staggers the start times inside a wave
    // so the engine never sees a tight burst, even when concurrency=1
    // is paired with a high `interUnitDelayMs` elsewhere.
    const isWave0 = waves.indexOf(wave) === 0;
    const waveConcurrency =
      isWave0 && opts.sequentialWave0 !== false ? 1 : (concurrency ?? DEFAULT_CONCURRENCY);
    const waveResult = await orchestrateUnits<AiInitUnit>({
      units: waveUnits,
      dispatcher,
      // MINOR-4: pass `base` so the reviewer can resolve cited paths
      // against the project root (not process.cwd()).
      reviewer: (u, o) => aiInitReviewer(u, o, base),
      concurrency: waveConcurrency,
      interUnitDelayMs: opts.interUnitDelayMs,
      agent: engine,
    });
    allUnits.push(...waveResult.units);
    allReviews.push(...waveResult.reviews);
    // Bail early if any unit in this wave is blocked — no point
    // dispatching downstream waves whose dependencies failed.
    const blocked = waveResult.reviews.find((r) => !r.pass);
    if (blocked) {
      // Persist what we DID get to .vibeflow/WORKFLOW_STATE.json so the
      // user can see which units passed (and re-run only the failed
      // ones) instead of starting from scratch on the next init.
      // Previously the wave-blocked path returned without writing, so
      // a transient rate-limit on a single unit threw away the work
      // of the 5+ units that already succeeded.
      const passedNames = allReviews.filter((r) => r.pass).map((r) => r.unit);
      if (base && allUnits.length > 0) {
        try {
          const partial: WorkflowState = {
            task_id: "vf-init",
            goal: intake.goal?.trim() || "VibeFlow init",
            success_criteria: [
              `${allUnits.length} unit(s) initialized`,
              `${passedNames.length} passed, ${allUnits.length - passedNames.length} blocked at ${blocked.unit}`,
            ],
            work_units: allUnits as WorkUnit[],
            totals: {
              units: allUnits.length,
              done: passedNames.length,
              tokens: 0,
              cost_usd: 0,
              wall_seconds: 0,
            },
            repo_path: base,
          };
          writeState(base, partial);
          process.stderr.write(
            `[ai-init] persisted partial state for ${passedNames.length}/${allUnits.length} unit(s) ` +
              `to ${CTX_DIR}/WORKFLOW_STATE.json\n`,
          );
        } catch (err) {
          // Persistence is best-effort — don't let a state-write failure
          // hide the original wave-block reason from the user.
          process.stderr.write(
            `[ai-init] warning: could not persist partial state: ${(err as Error).message}\n`,
          );
        }
      }
      return {
        ok: false,
        blockKind: "wave-blocked",
        engine,
        units: allUnits,
        reviews: allReviews,
        goalMet: false,
        passedUnits: passedNames,
        // P0-4: include quota-skipped finishers in the failed result
        // too, so the user can see the full picture on a blocked run.
        skippedUnits: skippedFinisherNames.length > 0 ? skippedFinisherNames : undefined,
        reason: `wave blocked at ${blocked.unit}: ${blocked.reason}`,
      };
    }
  }

  const result = { units: allUnits, reviews: allReviews };
  const goalMet =
    result.reviews.every((r) => r.pass) && result.units.every((u) => u.status === "done");
  return {
    ok: goalMet,
    engine,
    units: result.units,
    reviews: result.reviews,
    goalMet,
    reason: goalMet ? undefined : result.reviews.find((r) => !r.pass)?.reason,
    // P0-4: surface quota-skipped finisher names on the success path
    // so the CLI message can tell the user "5 done, 2 held back".
    skippedUnits: skippedFinisherNames.length > 0 ? skippedFinisherNames : undefined,
  };
}

/**
 * Group units into parallel waves using `depends_on` as the edge set.
 * Returns an array of waves, where each wave is a list of unit names
 * safe to dispatch concurrently. Units with no dependencies are in
 * wave 0; units that depend on a wave-N unit land in wave N+1.
 *
 * Returns waves in execution order. Pure: same input → same output.
 */
function scheduleAiInitWaves(units: AiInitUnit[]): string[][] {
  const byName = new Map(units.map((u) => [u.name, u]));
  const remaining = new Map(units.map((u) => [u.name, new Set(u.depends_on ?? [])]));
  const waves: string[][] = [];
  const done = new Set<string>();
  while (remaining.size) {
    const ready: string[] = [];
    for (const [name, deps] of remaining) {
      // A unit is ready when every dependency is in `done` (or unknown
      // — e.g. a name not in our unit set means the dependency was
      // resolved by a different path; treat it as satisfied).
      const allMet = [...deps].every((d) => done.has(d) || !byName.has(d));
      if (allMet) ready.push(name);
    }
    if (ready.length === 0) {
      // Cycle or unresolvable dependency. Surface the survivors as
      // their own wave so the orchestrator still reports a result.
      waves.push([...remaining.keys()]);
      break;
    }
    waves.push(ready);
    for (const name of ready) {
      remaining.delete(name);
      done.add(name);
    }
  }
  return waves;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectRolesForRepo } from "./agents/detect-roles.js";
import {
  type AiInitIntake,
  type AiInitUnit,
  aiInitReviewer,
  planAiInitUnits,
} from "./ai-init-workflow.js";
import { CTX_DIR, ENGINES, type Engine, type WorkUnit } from "./core.js";
import {
  type AsyncSpawner,
  type EngineCommandResult,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  materializePrompt,
} from "./dispatch.js";
import { type UnitDispatcher, type UnitOutcome, orchestrateUnits } from "./orchestrator/run.js";
import { type EngineReadiness, preflightAll } from "./preflight.js";
import { type ProjectProfile, renderFindingsTable, scanRepo } from "./scanner.js";

/** Engine priority for AI init: prefer engines that produce higher-quality analysis. */
const ENGINE_PRIORITY: Engine[] = ["claude", "copilot", "codex"];

/** Files the AI is asked to inspect and potentially edit. */
const INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".agents/instructions.md",
] as const;

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
const INSTRUCTIONS_BODY = `## Your Tasks

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
`;

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
  for (const e of ENGINE_PRIORITY) {
    if (ready.has(e)) return e;
  }
  // Fallback: engine installed but probe failed or auth issue → try it anyway
  const fallback = new Set(
    readiness
      .filter((r) => r.level === "probe-failed" || r.level === "no-auth")
      .map((r) => r.engine),
  );
  for (const e of ENGINE_PRIORITY) {
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
function writeContextFiles(base: string, profile: ProjectProfile): string[] {
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
  for (const f of INSTRUCTION_FILES) {
    const src = join(base, f);
    const dst = join(ctxDir, f);
    try {
      if (existsSync(src)) {
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
  try {
    writeFileSync(join(ctxDir, INSTRUCTIONS_FILE), INSTRUCTIONS_BODY);
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
export function buildAiInitPrompt(profile: ProjectProfile, base: string): string {
  // First compute the prompt text (no disk writes yet). The slim prompt
  // is short, so this is cheap and lets the caller run length checks
  // (e.g. Windows 32K fail-fast) before writeContextFiles touches disk.
  const contextFiles = listContextFiles(base, profile);
  const prompt = renderSlimPrompt(profile, base, contextFiles);

  // Only after we know the prompt is shippable, write the bulky context
  // files to disk for the AI to read.
  writeContextFiles(base, profile);
  return prompt;
}

/** Plan the file paths that would be written to .vibeflow/ai-context/.
 *  Touches the filesystem (existsSync) but does not WRITE — used by
 *  both buildAiInitPrompt (to pass the list to renderSlimPrompt)
 *  and writeContextFiles (which does the actual disk writes). The
 *  split is intentional: list = read-only probe, write =
 *  side-effectful I/O. Exported so unit tests can probe the list
 *  without going through runAiInit. */
export function listContextFiles(base: string, profile: ProjectProfile): string[] {
  const written: string[] = [];
  for (const f of INSTRUCTION_FILES) {
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
    prompt = result.prompt;
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
    (opts.buildPrompt ?? ((p, b) => renderSlimPrompt(p, b, listContextFiles(b, p))))(profile, base);

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
    writeContextFiles(base, profile);
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
  writeContextFiles(base, profile);

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
  /** Test seam: forwards to `defaultAiInitDispatcher` when the default
   *  dispatcher is constructed. Mirrors `runAiInit`'s option. */
  engineCommandFn?: (engine: Engine) => EngineCommandResult;
  /** Test seam: forwards to `defaultAiInitDispatcher`. Mirrors
   *  `runAiInit`'s `spawner` option. */
  spawner?: AsyncSpawner;
  /** Test seam: per-unit engine-call timeout. Defaults to
   *  `AI_INIT_TIMEOUT_MS`. */
  timeoutMs?: number;
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
 *  evidence=[] so the reviewer rejects the unit deterministically. */
export function defaultAiInitDispatcher(
  engine: Engine,
  opts: {
    engineCommandFn?: (engine: Engine) => EngineCommandResult;
    spawner?: AsyncSpawner;
    timeoutMs?: number;
  } = {},
): UnitDispatcher {
  const { engineCommandFn, spawner, timeoutMs = AI_INIT_TIMEOUT_MS } = opts;
  const resolveInvocation = engineCommandFn ?? engineCommand;
  const asyncSpawn = spawner ?? makeAsyncSpawner({ timeoutMs });
  return async (unit): Promise<UnitOutcome> => {
    const invocation = resolveInvocation(engine);
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
    const materialized = materializePrompt(
      { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
      unit.spec ?? "",
    );
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
    if (result.status !== 0) {
      const reason = `exit ${result.status}`;
      process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
      return {
        status: "blocked",
        confidence: 0,
        evidence: [`dispatcher-nonzero:${unit.name}:${reason}`],
      };
    }
    return {
      status: "verifying",
      confidence: 1,
      evidence: [...(unit.scope ?? [])],
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
  const { base, intake, forceEngine, preflight, concurrency } = opts;

  // Scan repo + detect roles so the planner can interpolate them.
  const profile = scanRepo(base);
  const detectedRoles = detectRolesForRepo(base, profile);

  // F3 + F4: pre-create .vibeflow/ai-context/ and all deterministic
  // context files (stack-evidence.md, project-profile.json, etc.) so
  // the engine never hits "parent directory does not exist" and the
  // reviewer's file-exists check passes even if the engine is transient.
  writeContextFiles(base, profile);
  // Also pre-create directory-scope items (e.g. .vibeflow/skills/) so
  // the reviewer's pathIsDir check passes when the engine cites them.
  mkdirSync(join(base, CTX_DIR, "skills"), { recursive: true });

  // Resolve engine (mirrors runAiInit's preflight logic).
  const probe = preflight ?? ((engines, pg) => preflightAll(engines, pg));
  let engine: Engine | null = null;
  if (forceEngine) {
    const readiness = probe(ENGINES, { probe: true });
    const match = readiness.find((r) => r.engine === forceEngine && r.level === "ready");
    engine = match ? forceEngine : null;
  } else {
    const readiness = probe(ENGINES, { probe: true });
    engine = selectBestEngine(readiness);
  }
  if (!engine) {
    return {
      ok: false,
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
  };
  const units = planAiInitUnits(profile, plannerIntake, detectedRoles);

  // Dispatch through the orchestrator. The injected dispatcher defaults
  // to a placeholder (so unit tests stay deterministic); production
  // Construct the default dispatcher (B3/T2): per-unit engine call, with
  // the test seams (engineCommandFn, spawner, timeoutMs) forwarded so
  // production calls go live and tests stay deterministic. Callers may
  // still inject a custom dispatcher via `opts.dispatcher`.
  const dispatcher =
    opts.dispatcher ??
    defaultAiInitDispatcher(engine, {
      engineCommandFn: opts.engineCommandFn,
      spawner: opts.spawner,
      timeoutMs: opts.timeoutMs,
    });

  const result = await orchestrateUnits<AiInitUnit>({
    units,
    dispatcher,
    // MINOR-4: pass `base` so the reviewer can resolve cited paths
    // against the project root (not process.cwd()).
    reviewer: (u, o) => aiInitReviewer(u, o, base),
    concurrency,
    agent: engine,
  });

  const goalMet =
    result.reviews.every((r) => r.pass) && result.units.every((u) => u.status === "done");
  return {
    ok: goalMet,
    engine,
    units: result.units,
    reviews: result.reviews,
    goalMet,
    reason: goalMet ? undefined : result.reviews.find((r) => !r.pass)?.reason,
  };
}

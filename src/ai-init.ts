import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, ENGINES, type Engine } from "./core.js";
import {
  type AsyncSpawner,
  type EngineCommandResult,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  materializePrompt,
} from "./dispatch.js";
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
}

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
    "You are an AI agent performing project initialization for VibeFlow (`vf init --ai`).",
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
}

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
 */
export async function runAiInit(opts: AiInitOpts): Promise<AiInitResult> {
  const {
    base,
    timeoutMs = AI_INIT_TIMEOUT_MS,
    dryRun = false,
    spawner,
    forceEngine,
    preflight,
  } = opts;

  // Determine which engine to use
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
    };
  }

  // Scan the project
  const profile = scanRepo(base);

  // Build the prompt text WITHOUT writing context files yet. The slim
  // prompt is short, so this is cheap and lets us run the Windows 32K
  // fail-fast below BEFORE writeContextFiles touches disk (saves ~35K
  // chars of writes when we would just abort). Test seam: allow tests
  // to inject a stubbed prompt to exercise the >30000 char threshold
  // without depending on the real profile.
  const contextFiles = listContextFiles(base, profile);
  const prompt = (opts.buildPrompt ?? ((p, b) => renderSlimPrompt(p, b, listContextFiles(b, p))))(
    profile,
    base,
  );

  // The original promptFile write/read block (Task 7 follow-up) was
  // DEAD CODE: claude and codex read prompts from stdin (no file
  // needed); copilot has no --prompt-file flag and the file content
  // was ultimately put back on cmd-line as argv anyway, defeating
  // the original purpose of bypassing Windows's 32K argv limit.
  // We just pass the prompt inline as argv and let Windows complain
  // if it's > 32K (fail-fast below).

  // Dry run: return prompt without writing context files or spawning
  if (dryRun) {
    return { ok: true, engine, prompt, reason: "dry run — prompt ready for inspection" };
  }

  // Resolve engine invocation
  const invocation: EngineCommandResult = (opts.engineCommandFn ?? engineCommand)(engine);

  if (isUnavailable(invocation)) {
    // Write context files before returning — they are still useful
    // diagnostic output for the caller.
    writeContextFiles(base, profile);
    return { ok: false, engine, reason: invocation.unavailable, prompt };
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

  const result = await asyncSpawn(invocation.cmd, args, input);

  if (result.timedOut) {
    return {
      ok: false,
      engine,
      reason: `${engine} AI analysis timed out after ${timeoutMs / 1000}s — deterministic context files are in place`,
      raw: result.stdout,
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
    };
  }

  return { ok: true, engine, raw: result.stdout };
}

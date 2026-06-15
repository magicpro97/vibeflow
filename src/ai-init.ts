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

/** Write full file contents to the ai-context temp dir so the AI can read them directly. */
function writeContextFiles(base: string, profile: ProjectProfile): string[] {
  const ctxDir = join(base, AI_CONTEXT_DIR);
  try {
    mkdirSync(ctxDir, { recursive: true });
  } catch {
    /* best effort */
  }
  const written: string[] = [];

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
 * Build the comprehensive AI analysis prompt.
 * Writes FULL file contents to .vibeflow/ai-context/ so the AI reads them directly —
 * no truncation, no slicing. The prompt references the file paths.
 */
export function buildAiInitPrompt(profile: ProjectProfile, base: string): string {
  // Write full context files for the AI to read
  const contextFiles = writeContextFiles(base, profile);

  const langList = profile.languages.length ? profile.languages.join(", ") : "unknown";
  const fwList = profile.frameworks.length ? profile.frameworks.join(", ") : "none detected";
  const pkgMgr = profile.packageManager ?? "unknown";
  const build = profile.buildCommand ?? "(not found)";
  const test = profile.testCommand ?? "(not found)";
  const lint = profile.lintCommand ?? "(not found)";
  const hasCI = profile.hasCI ? "yes" : "no";
  const summary = profile.summary ?? "(no README summary)";
  const manifests = profile.manifests.length ? profile.manifests.join(", ") : "none";

  const contextFileList = contextFiles.map((f) => `- ${f}`).join("\n");

  return [
    "## VibeFlow AI-Powered Project Initialization",
    "",
    "You are an AI agent performing project initialization for VibeFlow (`vf init --ai`).",
    "Your working directory IS the project root. You have full access to read and write files using your tools.",
    "",
    "## Project Detection",
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
    "For the evidence-backed stack table (with confidence levels), read `.vibeflow/ai-context/stack-evidence.md`. Do not guess stack without evidence.",
    "",
    "## Context Files (READ THESE FIRST — full content, no truncation)",
    "The following files contain the complete, untruncated project context.",
    "Read them with the Read tool before making any edits:",
    "",
    contextFileList,
    "",
    `- \`${AI_CONTEXT_DIR}/project-profile.json\` — structured project metadata (JSON)`,
    `- \`${AI_CONTEXT_DIR}/directory-listing.txt\` — project tree (top 2 levels)`,
    "",
    "For existing instruction files (CLAUDE.md, AGENTS.md, etc.), read BOTH:",
    "- The actual file at the repo root (may have human content outside fences)",
    `- The full copy under \`${AI_CONTEXT_DIR}/\` (exact current state at init time)`,
    "",
    "## Your Tasks",
    "",
    "### 0. Pre-flight Check",
    "Before ANY work, verify environment:",
    "- Run `npx ctx7 whoami` — if not logged in, WARN the user:",
    '  "⚠ ctx7 not logged in. Run: npx ctx7 login. Skill discovery will be limited without login."',
    "- Run `git rev-parse --git-dir` — confirm you are in a git repo",
    "- List existing instruction files at repo root",
    "",
    "### 1. Analyze the Project (INVESTIGATE until confidence = 1.0)",
    "",
    "**CONFIDENCE GATE: You MUST reach confidence = 1.0 on every finding BEFORE writing anything.**",
    "Confidence < 1 means you are GUESSING. GUESSING is FORBIDDEN. Investigate instead.",
    "",
    "To reach confidence 1.0, read these files exhaustively:",
    "- package.json (scripts, dependencies, devDependencies, engines)",
    "- tsconfig.json / jsconfig.json (compiler options, paths, strictness)",
    "- biome.json / .eslintrc.* / .prettierrc* (lint/format rules)",
    "- CI config (.github/workflows/*.yml, .gitlab-ci.yml, etc.)",
    "- Source directory structure (top 3 levels, all directories)",
    "- Sample source files (pick 5-10 files across different modules, read their imports and patterns)",
    "- Existing docs (README.md, docs/*.md, ARCHITECTURE.md)",
    "- Test directory structure and sample test files (test framework, patterns)",
    "",
    "**If confidence is still < 1 on any aspect:**",
    "- Read MORE files — don't stop at the first 2 files",
    "- Search the internet for the framework/library conventions if unfamiliar",
    '- Web-search: "<framework> project structure conventions 2026"',
    '- Web-search: "<library> best practices testing patterns"',
    "- Cross-reference: does the actual code match what the docs claim?",
    '- If still unsure after 3 rounds of investigation → note it as "uncertain: <topic>" and move on',
    "",
    "**Evidence checklist (all must be checked before confidence reaches 1.0):**",
    "☐ Build command verified by reading package.json scripts",
    "☐ Test command verified by reading package.json scripts + test config",
    "☐ Lint command verified by reading package.json scripts + lint config",
    "☐ Package manager identified (check lockfile: bun.lockb, package-lock.json, yarn.lock, pnpm-lock.yaml)",
    "☐ At least 5 source files read across different modules",
    "☐ At least 2 test files read to understand test patterns",
    "☐ Framework versions confirmed from package.json dependencies",
    "☐ CI pipeline understood (if .github/workflows exists)",
    "",
    "### 2. Write/Update Instruction Files",
    "",
    "These target locations MUST be written (all 4 — no skipping):",
    "- `CLAUDE.md` (root) — Claude Code instructions",
    "- `AGENTS.md` (root) — generic AI agent instructions",
    "- `.github/copilot-instructions.md` — GitHub Copilot instructions",
    "- `.agents/instructions.md` — standard agent instructions (Claude Code convention)",
    "",
    "If `.agents/` directory does not exist, CREATE it with `mkdir -p .agents` first.",
    "",
    "For EACH file:",
    "- FIND `<!-- vibeflow:start -->` / `<!-- vibeflow:end -->` markers",
    "- REPLACE only content BETWEEN markers with project-specific guidance",
    "- PRESERVE everything OUTSIDE markers exactly as-is",
    "- If no markers exist, the file may be human-authored → APPEND markers + generated block at end",
    "",
    "Inside the generated block, include:",
    "- **Build/Test/Lint** — exact commands from package.json",
    "- **Code conventions** — discovered from actual code (not guessed)",
    "- **Architecture** — key modules and data flow (from reading source files)",
    "- **Tech stack** — versions, libraries, frameworks with versions",
    "- **Gotchas** — non-obvious constraints discovered during investigation",
    "",
    "### 3. Discover and Install Skills",
    "",
    "**Skill sources are verified by ctx7. NEVER invent skills.**",
    "",
    "**3a. Check ctx7 login:**",
    "  `npx ctx7 whoami`",
    "  If NOT logged in → print warning, skip to 3c (manual discovery via docs).",
    "",
    "**3b. Install skills HEADLESS (non-interactive) via ctx7:**",
    "  These commands work headless (no TUI):",
    "  - `npx ctx7 library <tech>` → resolve library ID",
    "  - `npx ctx7 docs <libraryId> <query>` → fetch documentation",
    "  - `npx ctx7 skills install --yes --all --claude <repo>` → install skills to .claude/skills/",
    "  - `npx ctx7 skills list` → verify what's installed",
    "",
    "  IMPORTANT: The `--yes --all` flags are MANDATORY for headless mode. Without them, ctx7 opens an interactive TUI that will hang forever.",
    "",
    "  Use `--claude` (NOT `--all-agents`) — only 3 dirs matter: .claude/ .agents/ .github/",
    "  `--all-agents` creates .agent/ (Codex-specific) and .cursor/ which are NOT needed.",
    "",
    "  After --claude install, COPY skills to .agents/ and .github/:",
    "  for d in .claude/skills/*/; do",
    '    name=$(basename "$d")',
    '    [ "$name" = "README.md" ] && continue',
    '    mkdir -p ".agents/skills/$name" ".github/skills/$name"',
    '    cp "$d/SKILL.md" ".agents/skills/$name/SKILL.md"',
    '    cp "$d/SKILL.md" ".github/skills/$name/SKILL.md"',
    "  done",
    "",
    "  VERIFY after install: all 3 dirs (.claude/skills/, .agents/skills/, .github/skills/) must have skills.",
    "  - `ls .claude/skills/ | wc -l` ≥ 2",
    "  - `ls .agents/skills/ | wc -l` ≥ 2",
    "  - `ls .github/skills/ | wc -l` ≥ 2 (minus README.md)",
    "",
    "Before creating or editing any skill, read these files in `.vibeflow/ai-context/`:",
    "- `ANTHROPIC_SKILL_STANDARD.md` — required skill format",
    "- `SKILL_TAXONOMY.md` — project-fit vs tool/tweak rules",
    "- `stack-evidence.md` — detected stack with file/manifest evidence",
    "",
    "**3c. Skills rules (read the standard/taxonomy files first):**",
    "  - Project-fit skills live in `.vibeflow/skills/<name>/SKILL.md`",
    "  - Tool/tweak skills: prefer Context7/docs; if unavailable, create as `status: experimental` and cite evidence",
    "  - Never invent tool/tweak skills from project guesses",
    "  - Follow the SKILL.md format from `ANTHROPIC_SKILL_STANDARD.md`",
    "",
    "**3d. VERIFY every skill:**",
    "  Run `vf skills validate`. Read each SKILL.md. Empty/placeholder = bug, fix or delete.",
    "",
    "**3e. Update index:**",
    "  Run `vf skills list` to render the updated `.vibeflow/SKILL_INDEX.md`.",
    "",
    "### 4. Update Project Context",
    "- Edit `.vibeflow/PROJECT_CONTEXT.md`",
    "- Update detected stack, architecture insights, conventions",
    "- Preserve human-authored sections outside generated markers",
    "",
    "## Confidence Gate Protocol (MANDATORY)",
    "",
    "You are NOT allowed to finish with confidence < 1.0.",
    "",
    "If confidence < 1.0 on ANY task:",
    "1. Identify what you're uncertain about (be specific)",
    "2. Investigate: read more files, search the internet, run commands",
    "3. Re-evaluate confidence after each investigation round",
    "4. Repeat until confidence = 1.0 or you have exhausted all investigative paths",
    "5. If truly stuck after 5+ rounds → document the uncertainty in the JSON output",
    "",
    "  Example investigation round:",
    '  "Confidence on test framework = 0.6. I see vitest imports but no vitest.config.ts.',
    '  Investigating: reading package.json scripts → found `"test": "bun test"`.',
    '  Reading sample test file → uses `from "bun:test"` imports.',
    '  Confidence now 1.0: project uses bun test, NOT vitest."',
    "",
    "When confidence hits 1.0 on ALL findings, write the JSON summary.",
    "",
    "## Critical Constraints",
    "- NEVER delete or truncate any file",
    "- NEVER modify content OUTSIDE `<!-- vibeflow:start -->`/`<!-- vibeflow:end -->` markers",
    "- Use Edit tool for instruction file modifications — never Write whole files that have human content",
    "- BE CONCISE in instruction files — AI agents read them, keep them scannable",
    "- Skills from ctx7: use `ctx7 skills install --yes --claude` (headless) or write manually from `ctx7 docs`",
    "- After every action, update your internal confidence score for that finding",
    "",
    "## Output (LAST thing — only when ALL tasks done at confidence 1.0)",
    "",
    "```json",
    "{",
    '  "files_edited": ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".agents/instructions.md"],',
    '  "skills_installed": ["<name>"],',
    '  "skills_source": ["ctx7:<repo>", "manual-from-ctx7-docs"],',
    '  "key_findings": ["<concrete finding>"],',
    '  "investigation_rounds": <number of investigation rounds needed>,',
    '  "project_type": "<type>",',
    '  "confidence": 1.0',
    "}",
    "```",
    "",
    "REMEMBER: confidence must be EXACTLY 1.0. If it's 0.9, you're not done. Go back and investigate.",
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
  // Test seam: lets unit tests inject a stubbed prompt to exercise
  // the >10000 char threshold for the promptFile write path.
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

  // Build the prompt (writes full context files, no truncation)
  // Test seam: allow tests to inject a stubbed prompt to exercise
  // the >10000 char threshold without depending on the real profile.
  const prompt = (opts.buildPrompt ?? ((p, b) => buildAiInitPrompt(p, b)))(profile, base);

  // Windows 32K cmd-line limit workaround: write prompt to file
  const usePromptFile = process.platform === "win32" || prompt.length > 10000;
  let promptFile: string | undefined;
  if (usePromptFile) {
    try {
      const ctxDir = join(base, CTX_DIR, "ai-context");
      mkdirSync(ctxDir, { recursive: true });
      promptFile = join(ctxDir, "ai-init-prompt.txt");
      writeFileSync(promptFile, prompt);
    } catch {
      /* fallback to arg mode */
    }
  }

  // Dry run: return prompt without spawning
  if (dryRun) {
    return { ok: true, engine, prompt, reason: "dry run — prompt ready for inspection" };
  }

  // Resolve engine invocation
  const invocation: EngineCommandResult = (opts.engineCommandFn ?? engineCommand)(engine);

  if (isUnavailable(invocation)) {
    return { ok: false, engine, reason: invocation.unavailable, prompt };
  }

  // Handle the copilot promptMode: prompt goes as -p value
  let materialized = materializePrompt(
    { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
    prompt,
  );

  // Copilot workaround for huge prompts: read the promptFile and
  // treat its content as the prompt. We CANNOT pipe via stdin
  // (copilot's -p mode requires the prompt as argv value) and we
  // CANNOT use a shell pipe (Windows `type file | copilot -p`
  // results in copilot receiving `-p --allow-all-tools` with no
  // prompt value, falling back to interactive mode — see "You're
  // in <cwd>... What should I do next?"). The only working
  // approach is to read the file in JS and pass the content as
  // the `-p` argv element via direct Bun.spawn (no shell, so
  // args[1] isn't reinterpreted by cmd.exe).
  if (engine === "copilot" && promptFile) {
    try {
      const fileContent = readFileSync(promptFile, "utf8");
      materialized = materializePrompt(
        {
          cmd: invocation.cmd,
          args: invocation.args,
          promptMode: invocation.promptMode,
        },
        fileContent,
      );
    } catch {
      // If the file can't be read, fall through with the original
      // materialized (which has the truncated prompt). This is
      // best-effort — the dispatch may still fail, but we'll see
      // a clear error from copilot instead of a silent interactive
      // mode fallback.
    }
  }
  const args = materialized.args;
  const input = materialized.input;

  // Spawn the engine via direct Bun.spawn (no shell, so the
  // args[1] prompt value isn't reinterpreted by cmd.exe).
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

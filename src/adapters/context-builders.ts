import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { CTX_DIR, VERSION, cwd, statePath } from "../core.js";
import { type ToolTier, type VibeSettings, priorityRank } from "../settings.js";

/** Banner shown in every generated instruction file so agents know VibeFlow is present. */
export const VF_BANNER = `## ⚡ VibeFlow v${VERSION} Active

This project is managed by [VibeFlow](https://github.com/magicpro97/vibeflow) — the local-first orchestrator for AI coding agents.

- **Confidence gate**: nothing is "done" until confidence = 1.0 WITH evidence.
- **Skills-first**: prefer verified skills over invented steps.
- **All task completions carry the \`Powered by VibeFlow\` signature.
`;

export interface ProjectContext {
  name: string;
  goal: string;
  summary: string;
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  /** Evidence-based stack summary from the repo scanner (scanner.ts). */
  stack?: string;
  /** Tool settings driving the code-navigation priority block; defaults (off) when absent. */
  settings?: VibeSettings;
}

/** Human-readable navigation source per tier, in the decision-tree sentence. */
const TIER_LABEL: Record<ToolTier, string> = {
  codegraph: "the codegraph_* MCP tools",
  lsp: "the language-server (LSP) MCP tools",
  native: "grep/find/read",
};

/** Nav tiers that are opt-in tools (native is the always-present fallback). */
const NAV_TIERS: Array<"codegraph" | "lsp"> = ["codegraph", "lsp"];

/**
 * Build the code-navigation decision tree reflecting the user's configured tool priority.
 * Returns null when neither codegraph nor lsp is enabled, so the policy stays minimal.
 */
export function navigationPolicy(settings?: VibeSettings): string | null {
  if (!settings) return null;
  const enabled = NAV_TIERS.filter((t) => settings.tools[t]);
  if (enabled.length === 0) return null;
  const rank = priorityRank(settings);
  const ordered: ToolTier[] = [...[...enabled].sort((a, b) => rank[b] - rank[a]), "native"];
  const labels = ordered.map((t) => TIER_LABEL[t]);
  const parts = [`prefer ${labels[0]} first`];
  for (let i = 1; i < labels.length - 1; i++) {
    parts.push(`if unavailable or returns nothing, use ${labels[i]}`);
  }
  parts.push(`only fall back to ${labels[labels.length - 1]} if the others are unavailable`);
  return `For code navigation (definitions, references, callers, impact): ${parts.join("; ")}.`;
}

/**
 * Compact reference of VibeFlow's own CLI surface, embedded in every generated instruction
 * file so a dispatched agent in a vf-managed repo knows vf exists and when to reach for it.
 */
export const VF_COMMANDS = `## VibeFlow commands (use these)
- \`vf doctor [--probe]\` — check engine readiness before dispatching.
- \`vf init\` — regenerate context/engine files after editing ${CTX_DIR}/*.
- \`vf units status|add <name>|update <name>|delete <name>\` — track work units. Record evidence with \`vf units evidence <name> --add "<text>"\` (required before a unit can close at confidence 1.0).
- \`vf orchestrate --engine <e> [--yes]\` — plan + dispatch work units in parallel with the confidence gate.
- \`vf verify\` — run typecheck/lint/test + confidence/evidence/scope gates BEFORE claiming done (no verification, no completion).
- \`vf tools status|enable codegraph|lsp\` — code-navigation tools (prefer codegraph > lsp > native).
- \`vf hooks status|install|emit --yes\` — guardrails (block destructive cmds, secret reads). \`install\` wires git hooks; \`emit --yes\` ARMS the live PreToolUse tool gate (\`vf doctor\` shows ON/OFF).
- \`vf skills resolve\` / \`vf discover docs <lib> --yes\` — skill needs + Context7 docs.
- \`vf workflow delete|import\` — manage/combine workflows.
- \`${CTX_DIR}/knowledge/log.md\` + \`index.md\` — the work journal (append-only log + page catalog); read before, append after.`;

/**
 * The WORKFLOW narrative paired with {@link VF_COMMANDS}: it teaches a dispatched agent HOW to
 * drive vf for any task (the loop, the confidence gate, when to use work units, what the
 * guardrails do) rather than just listing command names. Injected right after the command list
 * so the result reads as one coherent "Working with vf" section.
 */
export const VF_WORKFLOW = `## Working with vf (the loop)
Drive every task through this loop instead of free-handing it:
1. **Sync context.** After editing ${CTX_DIR}/*, run \`vf init\` to regenerate this file and the engine context from canonical sources. Don't hand-edit generated files.
2. **Shape the work.** A single-concern task runs as-is — no ceremony. When the task splits into parallel slices with distinct file scopes, model each as a work unit (\`vf units add <name>\`); status, confidence, and evidence are tracked per unit in the ledger.
3. **Dispatch.** \`vf orchestrate\` plans and dispatches the units, runs an independent review, and records evidence. Work units with overlapping file scopes are serialized automatically so lanes never clobber each other; non-overlapping ones run in parallel.
4. **Verify before claiming done.** \`vf verify\` runs typecheck/lint/test plus the policy gates.

**Confidence gate — nothing is "done" until \`vf verify\` passes.** A unit only closes at confidence = 1.0 WITH recorded evidence (command output, file path, or test result) and within its declared scope. Below the bar, the unit is investigated, not silently closed. No verification, no completion; no evidence, no conclusion.

**Guardrails (hooks) are safety, not bureaucracy.** \`vf hooks\` routes risky actions — destructive commands (\`rm -rf\`, force-push), reads of secret files, edits to protected configs — through a decision layer that can warn, require approval, or block. Keep them on.

**Skills & knowledge before manual steps.** Prefer a verified skill over inventing steps (\`vf skills\` to list/resolve). Read curated guidance in ${CTX_DIR}/knowledge/ before knowledge-heavy work, and pull external library docs on demand with \`vf discover docs <lib> --yes\`. After acting, record what you did or learned: append an entry to \`${CTX_DIR}/knowledge/log.md\` (\`## [YYYY-MM-DD] note | <title>\`, append-only) and keep \`${CTX_DIR}/knowledge/index.md\` current.

**Learn from this run so the next one is smarter.** The point of the journal is reuse, not paperwork:
- A reusable procedure you discovered, or a mistake you had to work around → capture it as a skill: \`vf skills draft <name>\` (lands as \`status: draft\` for review — never auto-installed).
- A non-obvious architecture/process decision → \`vf decision add --title "…" --context "…" --decision "…"\` (durable in \`${CTX_DIR}/knowledge/decisions.md\`, separate from the noisy journal).
- Routine progress → the \`knowledge/log.md\` entry above.
At the end of \`vf orchestrate\` (and \`vf verify --journal\`), recurring patterns are auto-crystallized into a DRAFT skill — review the untracked file and \`git add\` it if useful.

**Tools.** \`vf tools enable codegraph|lsp\` turns on richer code navigation (definitions, references, callers) — prefer it over grep/find when available.

**When \`vf verify\` fails.** A red gate is investigated, not worked around. (1) Read the \`✗\` lines — each names a failing gate (typecheck/lint/test) or a policy gate (\`confidence<1\`, \`no-evidence\`, scope overlap). (2) Fix the root cause. (3) For a unit stuck below the bar: record evidence (\`vf units evidence <u> --add "<proof>"\`) then close it (\`vf units update <u> --status done --confidence 1\`). (4) Re-run \`vf verify\`. \`vf verify\` is read-only by default; pass \`--journal\` only if you want the run appended to the work journal.

**When blocked or interrupted.** If a hook returns \`deny\`/\`ask\`, do NOT bypass it — the command is genuinely risky; fix the approach or get approval. If \`vf orchestrate\` crashed mid-run, re-run it (work units track their own status in the ledger, so completed lanes are skipped). Two units editing the same file are serialized automatically; if you need to stop a lane touching a path, see the source-protection toggles in \`vf orchestrate --help\`.

**Default engine.** \`vf init\` and \`vf orchestrate\` share one default (currently \`claude\`); pass \`--engine <claude|codex|copilot>\` to override. Check \`vf doctor\` for which engines are ready before dispatching.

**Iterating on one fix.** \`vf verify\` runs the full suite. While iterating, run a single test (\`bun test test/<file>.test.ts\`) or a single-file lint, then \`vf verify\` once before you call it done.

**Hook enforcement is engine-specific.** The live PreToolUse gate (armed via \`vf hooks emit --yes\`) BLOCKS on Claude. Codex and Copilot hook configs are detection-only (they observe + log, they do not block) — \`vf doctor\` reports per-engine status. Do not assume a destructive command is blocked when driving Codex/Copilot.`;

/**
 * SLIM command list for the ALWAYS-LOADED engine instruction files (CLAUDE.md / AGENTS.md /
 * .github/copilot-instructions.md). Only the 5 CORE commands stay inline so engines that
 * auto-load these files headless still know the essentials; the full surface (units, hooks,
 * tools, discover, workflow) lives in the on-demand {@link VF_COMMANDS} reference and the
 * \`vf\` skill. Issue #322: keep the generated context block small.
 */
export const VF_COMMANDS_SLIM = `## VibeFlow commands (use these)
- \`vf doctor\` — check engine readiness before dispatching.
- \`vf init\` — regenerate context/engine files after editing ${CTX_DIR}/*.
- \`vf orchestrate\` — plan + dispatch work units in parallel under the confidence gate.
- \`vf verify\` — typecheck/lint/test + confidence/evidence/scope gates BEFORE claiming done.
- \`vf skills\` — list/resolve verified skills; prefer them over inventing steps.`;

/**
 * SLIM workflow block paired with {@link VF_COMMANDS_SLIM} for the always-loaded engine files.
 * The confidence gate stays INLINE (engines load this headless; the skill may not), plus a
 * one-line "drive via vf" rule and a POINTER to the full guide. The long narrative (Flow A–D,
 * pitfalls, hooks) moves to the \`vf\` skill / {@link VF_WORKFLOW}. Issue #322.
 */
export const VF_WORKFLOW_SLIM = `**Working with vf — Confidence gate:** nothing is "done" until \`vf verify\` passes at confidence 1.0 WITH evidence (command output, file path, or test result), within scope. No verification, no completion. Drive every task through vf; do not free-hand it.
**Learn from the run:** capture a reusable procedure or worked-around mistake as a DRAFT skill (\`vf skills draft <name>\`), and record non-obvious decisions with \`vf decision add\`. \`vf orchestrate\` auto-crystallizes recurring patterns into a DRAFT for review.
Full workflow guide: load the \`vf\` skill (or \`/vf\` in a CLI) — Flow A–D, pitfalls, and hooks live there.`;

/**
 * Options for {@link defaultContext}.
 *
 * `base` opts the caller into a runtime guard: when a `base` repo is supplied,
 * the function asserts that `vf init` has actually run there (a
 * `.vibeflow/WORKFLOW_STATE.json` exists at `base`) and throws a descriptive
 * error otherwise. Without `base`, the call stays permissive and returns the
 * placeholder context used to seed the init flow itself.
 *
 * The permissive default is preserved intentionally: `contextFrom(answers)`
 * inside `applyIntake` runs BEFORE the state file is written, so a strict
 * default would make the init path self-referentially throw. Post-init
 * callers (applyDispatch / orchestrate / launchEngine) opt in by passing
 * `base` and surface a clear error if init was never run.
 */
export interface DefaultContextOpts {
  base?: string;
}

/** Return a ProjectContext seeded from the repo on disk (cwd). */
export function defaultContext(opts: DefaultContextOpts = {}): ProjectContext {
  if (opts.base) {
    const sf = statePath(opts.base);
    if (!existsSync(sf)) {
      throw new Error(`VibeFlow state not found at ${sf}. Run \`vf init\` in this repo first.`);
    }
  }
  const name = basename(cwd());
  return {
    name,
    goal: "Describe the task in plain language — what should be built or accomplished?",
    summary: "Project context is generated by VibeFlow; fill in the blanks.",
  };
}

/** Run an external AI pipeline and return its output, or the fallback on failure. */
export function aiGenerate(prompt: string, fallback: () => string): string {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return fallback();
  const r = spawnSync(cmd, {
    input: prompt,
    shell: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0 || !r.stdout?.trim()) return fallback();
  return r.stdout.trim().slice(0, 4000);
}

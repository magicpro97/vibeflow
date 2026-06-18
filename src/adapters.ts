import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type AgentEngine, agentFilePath, renderForEngine } from "./agents/render.js";
import { type RoleName, getRoleSpec, roleContextFromProfile } from "./agents/role-templates.js";
import type { RoleSpec } from "./agents/role.js";
import { CTX_DIR, ENGINES, type Engine, VERSION, cwd, statePath } from "./core.js";
import type { ProjectProfile } from "./scanner.js";

/** Banner shown in every generated instruction file so agents know VibeFlow is present. */
const VF_BANNER = `## ⚡ VibeFlow v${VERSION} Active

This project is managed by [VibeFlow](https://github.com/magicpro97/vibeflow) — the local-first orchestrator for AI coding agents.

- **Confidence gate**: nothing is "done" until confidence = 1.0 WITH evidence.
- **Skills-first**: prefer verified skills over invented steps.
- **All task completions carry the \`Powered by VibeFlow\` signature.
`;
import { type ToolTier, type VibeSettings, priorityRank } from "./settings.js";

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
function navigationPolicy(settings?: VibeSettings): string | null {
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
const VF_COMMANDS = `## VibeFlow commands (use these)
- \`vf doctor [--probe]\` — check engine readiness before dispatching.
- \`vf init\` — regenerate context/engine files after editing ${CTX_DIR}/*.
- \`vf units status|add <name>|update <name>|delete <name>\` — track work units.
- \`vf orchestrate --engine <e> [--yes]\` — plan + dispatch work units in parallel with the confidence gate.
- \`vf verify\` — run typecheck/lint/test + confidence/evidence/scope gates BEFORE claiming done (no verification, no completion).
- \`vf tools status|enable codegraph|lsp\` — code-navigation tools (prefer codegraph > lsp > native).
- \`vf hooks status|install\` — guardrails (block destructive cmds, secret reads).
- \`vf skills resolve\` / \`vf discover docs <lib> --yes\` — skill needs + Context7 docs.
- \`vf workflow delete|import\` — manage/combine workflows.
- \`${CTX_DIR}/knowledge/log.md\` + \`index.md\` — the work journal (append-only log + page catalog); read before, append after.`;

/**
 * The WORKFLOW narrative paired with {@link VF_COMMANDS}: it teaches a dispatched agent HOW to
 * drive vf for any task (the loop, the confidence gate, when to use work units, what the
 * guardrails do) rather than just listing command names. Injected right after the command list
 * so the result reads as one coherent "Working with vf" section.
 */
const VF_WORKFLOW = `## Working with vf (the loop)
Drive every task through this loop instead of free-handing it:
1. **Sync context.** After editing ${CTX_DIR}/*, run \`vf init\` to regenerate this file and the engine context from canonical sources. Don't hand-edit generated files.
2. **Shape the work.** A single-concern task runs as-is — no ceremony. When the task splits into parallel slices with distinct file scopes, model each as a work unit (\`vf units add <name>\`); status, confidence, and evidence are tracked per unit in the ledger.
3. **Dispatch.** \`vf orchestrate\` plans and dispatches the units, runs an independent review, and records evidence. Work units with overlapping file scopes are serialized automatically so lanes never clobber each other; non-overlapping ones run in parallel.
4. **Verify before claiming done.** \`vf verify\` runs typecheck/lint/test plus the policy gates.

**Confidence gate — nothing is "done" until \`vf verify\` passes.** A unit only closes at confidence = 1.0 WITH recorded evidence (command output, file path, or test result) and within its declared scope. Below the bar, the unit is investigated, not silently closed. No verification, no completion; no evidence, no conclusion.

**Guardrails (hooks) are safety, not bureaucracy.** \`vf hooks\` routes risky actions — destructive commands (\`rm -rf\`, force-push), reads of secret files, edits to protected configs — through a decision layer that can warn, require approval, or block. Keep them on.

**Skills & knowledge before manual steps.** Prefer a verified skill over inventing steps (\`vf skills\` to list/resolve). Read curated guidance in ${CTX_DIR}/knowledge/ before knowledge-heavy work, and pull external library docs on demand with \`vf discover docs <lib> --yes\`. After acting, record what you did or learned: append an entry to \`${CTX_DIR}/knowledge/log.md\` (\`## [YYYY-MM-DD] note | <title>\`, append-only) and keep \`${CTX_DIR}/knowledge/index.md\` current.

**Tools.** \`vf tools enable codegraph|lsp\` turns on richer code navigation (definitions, references, callers) — prefer it over grep/find when available.`;

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
 * `base` and surface a clear "run vf init" message instead of silently
 * propagating the placeholder goal.
 */
export interface DefaultContextOpts {
  /** Repo base directory to assert initialization against. */
  base?: string;
}

export function defaultContext(opts: DefaultContextOpts = {}): ProjectContext {
  if (opts.base !== undefined) {
    const stateFile = statePath(opts.base);
    if (!existsSync(stateFile)) {
      throw new Error(
        `defaultContext: vf init has not been run in ${opts.base} ` +
          `(missing ${stateFile}). Run \`vf init\` before dispatching an engine.`,
      );
    }
  }
  return {
    name: basename(cwd()),
    goal: `Describe the task in ${CTX_DIR}/TASK_CONTEXT.md before dispatching an engine.`,
    summary: `Project context is generated by VibeFlow. Edit ${CTX_DIR}/PROJECT_CONTEXT.md to refine it.`,
  };
}

/**
 * AI bridge. Per the VibeFlow principle, generated files are composed by an AI from
 * canonical context rather than copied from static templates. When the VIBEFLOW_AI
 * environment variable points to a command, the prompt is piped to it and its stdout is
 * used verbatim. Otherwise VibeFlow falls back to a deterministic projection of the
 * canonical context so the tool remains usable offline.
 */
export function aiGenerate(prompt: string, fallback: () => string): string {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return fallback();
  // Bounded so a hung VIBEFLOW_AI command cannot block vf init forever.
  // 30s matches aiEnrichRole (consistency).
  const r = spawnSync(cmd, {
    input: prompt,
    shell: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout;
  return fallback();
}

// --- Canonical context files (the single source of truth) ---
export function canonicalFiles(ctx: ProjectContext): Record<string, string> {
  const sources = [
    `- Documentation source: ${ctx.docSource ?? "TODO"}`,
    `- Task/issue source: ${ctx.taskSource ?? "TODO"}`,
    ctx.fileTypes?.length ? `- File types in scope: ${ctx.fileTypes.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const requirements = ctx.expectedResult
    ? `- Expected result: ${ctx.expectedResult}\n`
    : "- TODO: capture business and technical requirements.\n";
  const sample = ctx.sample ? `- Reference/sample: ${ctx.sample}\n` : "";
  const stack = ctx.stack ? `\n## Detected stack\n\n${ctx.stack}\n` : "";
  const nav = navigationPolicy(ctx.settings);
  const navBlock = nav ? `\n## Code Navigation Priority\n- ${nav}\n` : "";
  return {
    [`${CTX_DIR}/PROJECT_CONTEXT.md`]: `# Project Context\n\n- Name: ${ctx.name}\n- Summary: ${ctx.summary}\n${sources}\n${stack}`,
    [`${CTX_DIR}/REQUIREMENTS.md`]: `# Requirements\n\n${requirements}${sample}`,
    [`${CTX_DIR}/TASK_CONTEXT.md`]: `# Task Context\n\n- Goal: ${ctx.goal}\n- Definition of Done: ${ctx.expectedResult ?? "TODO"}\n- Must not change: TODO\n`,
    [`${CTX_DIR}/WORKFLOW_POLICY.md`]: `# Workflow Policy\n\n- No evidence, no conclusion. No verification, no completion.\n- Generate the fewest files possible; every generated file is AI-composed from this context.\n- Ask approval only for side effects or high-risk actions.\n\n${VF_COMMANDS}\n\n${VF_WORKFLOW}\n\n## Incremental File Authoring\n- Never write a large file in a single operation — it causes request timeouts. Create the file with a small first part, then append/edit the remaining parts in separate steps.\n- When merging generated content into an existing file, edit/append the specific section rather than rewriting the whole file.\n\n## Knowledge\n- Read curated guidance in \`${CTX_DIR}/knowledge/\` before knowledge-heavy or research tasks. Treat it as input you maintain (cross-reference and keep current); never overwrite a source the human curated.\n- Read \`${CTX_DIR}/knowledge/index.md\` first to find the relevant pages.\n- After each task, append a dated entry to \`${CTX_DIR}/knowledge/log.md\` (\`## [YYYY-MM-DD] <op> | <title>\`), append-only — never rewrite past entries.\n- File durable findings as their own linked page and add a one-line entry to \`index.md\`.\n- Periodically lint for stale, contradictory, or orphaned notes.\n\n## Tool Error & Execution Policy\n- If any terminal command or test execution times out or returns an error code, do not give up immediately.\n- Autonomously analyze the error output or partial logs, fix the scripts or parameters, and retry the command up to 3 times.\n- Only prompt the user for feedback if the execution consistently fails after 3 distinct self-correction attempts.\n${navBlock}`,
    [`${CTX_DIR}/SKILL_INDEX.md`]:
      "# Skill Index\n\n| skill | status | capabilities |\n|-------|--------|--------------|\n",
  };
}

// --- Per-engine adapter output, AI-composed from canonical context ---
function engineBody(engine: Engine, ctx: ProjectContext): string {
  const nav = navigationPolicy(ctx.settings);
  const navLine = nav ? `- ${nav}\n` : "";
  // Trim user-provided goal so trailing whitespace/newlines in `ctx.goal` do not stack with the
  // template's own "\n\n" and produce a double-blank line before the "Powered by VibeFlow" footer
  // (issue #91). Tolerate missing `goal` for callers that build a partial ProjectContext.
  const goal = (ctx.goal ?? "").trim();
  const shared = `${VF_BANNER}Project: ${ctx.name}\nGoal: ${goal}\n\nPolicy:\n- Use verified skills when a task matches one; do not invent manual steps.\n- Back every factual claim with a file path, command output, or test result.\n- No verification, no completion.\n- Read curated guidance in ${CTX_DIR}/knowledge/ before knowledge-heavy tasks; keep it cross-referenced and current, never overwrite a human-curated source.\n- After acting, append a dated note to \`${CTX_DIR}/knowledge/log.md\` and keep \`${CTX_DIR}/knowledge/index.md\` current (append-only; never rewrite human-curated pages).\n- Author files incrementally: never write a large file in one operation (it times out) — create a small first part, then append/edit the rest in separate steps; when merging into an existing file, edit the specific section rather than rewriting the whole file.\n${navLine}\n${VF_COMMANDS}\n\n${VF_WORKFLOW}\n\n# Tool Error & Execution Policy\n- If any terminal command or test execution times out or returns an error code, do not give up immediately.\n- Autonomously analyze the error output or partial logs, fix the scripts or parameters, and retry the command up to 3 times.\n- Only prompt the user for feedback if the execution consistently fails after 3 distinct self-correction attempts.\n\nPowered by VibeFlow v${VERSION} — https://github.com/magicpro97/vibeflow\n`;
  if (engine === "claude") {
    return `# CLAUDE.md\n\n${shared}\nThe block between the \`vibeflow:start\`/\`vibeflow:end\` markers is generated by VibeFlow from ${CTX_DIR}/* and is replaced on \`vf init\`. Edit freely OUTSIDE the markers; that content is preserved across re-init.\n`;
  }
  return `# AGENTS.md\n\n${shared}\nThe block between the \`vibeflow:start\`/\`vibeflow:end\` markers is generated by VibeFlow from ${CTX_DIR}/* and is replaced on \`vf init\`. Edit freely OUTSIDE the markers; that content is preserved across re-init.\n`;
}

export function engineFiles(
  engine: Engine,
  ctx: ProjectContext,
  useAi = true,
): Record<string, string> {
  const compose = (prompt: string, fallback: () => string): string =>
    useAi ? aiGenerate(prompt, fallback) : fallback();
  const prompt = `Compose the ${engine} instruction file for project "${ctx.name}" from this context:\n${JSON.stringify(ctx)}`;
  const body = compose(prompt, () => engineBody(engine, ctx));
  // Note: `.agents/instructions.md` was historically generated for every engine (with a
  // comment claiming it was a "Claude Code convention"), but no supported engine actually
  // reads it: Claude Code reads `CLAUDE.md` (and `~/.claude/CLAUDE.md`), Codex reads
  // `AGENTS.md`, Copilot reads `.github/copilot-instructions.md` (+ path-scoped rules in
  // `.github/instructions/`), and opencode reads `AGENTS.md` (with `CLAUDE.md` fallback).
  // Generating it for every engine created an unused `.agents/` directory when running
  // `vf init` with a single engine (e.g. the copilot default). For users who hand-curated
  // `.agents/instructions.md` historically, `ENGINE_INSTRUCTION_FILES` in workflow/merge.ts
  // still merges any existing file on re-init (data-loss safety).
  switch (engine) {
    case "claude":
      return { "CLAUDE.md": body };
    case "codex":
      return { "AGENTS.md": body };
    case "copilot":
      return {
        "AGENTS.md": body,
        ".github/copilot-instructions.md": compose(
          `Compose .github/copilot-instructions.md for "${ctx.name}".`,
          () =>
            `# Copilot Instructions\n\n${engineBody("copilot", ctx)}\nPath-specific rules live in .github/instructions/*.instructions.md.\n`,
        ),
      };
  }
}

/** A unit brief for the dispatch prompt: just a name, or a name with a build spec + file scope. */
// --- Per-engine agent files (per-role specialists) ---

/**
 * Render per-role agent files in all 3 engine formats. For each role in
 * `roles`, emit a file at the engine-specific path:
 *  - `.claude/agents/<name>.md`   (Markdown + YAML frontmatter)
 *  - `.codex/agents/<name>.toml`  (TOML config)
 *  - `.github/agents/<name>.md`   (Markdown + YAML frontmatter, tools as list)
 *
 * The same role spec (engine-agnostic markdown body) is shared across all
 * three renderers; only the wrapper format differs.
 *
 * When `useAi` is true and `VIBEFLOW_AI` is set, each role's body and
 * description can be enriched by the AI. The fallback is the deterministic
 * template from `role-templates.ts`. Without an AI, behaviour matches the
 * old hard-coded mode (no I/O beyond the `agentFiles` call itself).
 */
export function agentFiles(
  profile: ProjectProfile,
  roles: RoleName[],
  useAi = true,
  engines: readonly AgentEngine[] = ENGINES as readonly AgentEngine[],
): Record<string, string> {
  const ctx = roleContextFromProfile(profile);
  const out: Record<string, string> = {};
  for (const roleName of roles) {
    const baseSpec = getRoleSpec(roleName, ctx);
    if (!baseSpec) continue;
    const spec = useAi ? aiEnrichRole(baseSpec, profile) : baseSpec;
    for (const engine of engines) {
      out[agentFilePath(engine, roleName)] = renderForEngine(engine, spec);
    }
  }
  return out;
}

/** When `VIBEFLOW_AI` is set, ask the AI to tailor the role's body to
 * the actual project profile. Falls back to the hard-coded template
 * when the env var is unset or the AI returns empty. Body input is
 * bounded so a runaway AI can't blow the tool budget.
 *
 * Note: this only enriches `body`, NOT `description`. The description
 * is a routing trigger (Claude/Codex use it to decide when to invoke
 * this sub-agent), so it must stay short and keyword-stable; rewriting
 * it would break the routing. */
function aiEnrichRole(spec: RoleSpec, profile: ProjectProfile): RoleSpec {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return spec;
  const prompt = [
    `Tailor the following agent role for project "${profile.name}".`,
    `Project summary: ${profile.summary ?? "(none)"}.`,
    `Detected stack: ${profile.languages.join(", ")}, packageManager=${profile.packageManager ?? "?"}.`,
    "Return ONLY the rewritten body (markdown). Do not change name, tools, model, or sandbox.",
    "Keep length under 4000 characters.",
    "",
    "Original body:",
    spec.body,
  ].join("\n");
  const r = spawnSync(cmd, { input: prompt, shell: true, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0 || !r.stdout?.trim()) return spec;
  const enrichedBody = r.stdout.trim().slice(0, 4000);
  return { ...spec, body: enrichedBody };
}

export type UnitBrief =
  | string
  | {
      name: string;
      spec?: string;
      scope?: string[];
      /** Verified skills resolved for this unit (by name) — injected so the engine follows them. */
      skills?: string[];
      /** True when this is a knowledge-heavy unit (e.g. UX/UI) and NO skill matched. */
      skillGap?: boolean;
    };

function briefName(u: UnitBrief): string {
  return typeof u === "string" ? u : u.name;
}

type UnitBriefObj = Exclude<UnitBrief, string>;

export function dispatchPrompt(engine: Engine, ctx: ProjectContext, units: UnitBrief[]): string {
  const names = units.map(briefName);
  const objs = units.filter((u): u is UnitBriefObj => typeof u !== "string");
  const specs = objs.filter(
    (u) => Boolean(u.spec?.trim()) || Boolean(u.scope?.length) || Boolean(u.skills?.length),
  );
  // Trim user-provided goal so trailing whitespace/newlines in `ctx.goal` do not stack with the
  // trailing empty-line marker below and produce a double-blank line in the dispatch prompt
  // (issue #91). Tolerate missing `goal` for callers that build a partial ProjectContext.
  const goal = (ctx.goal ?? "").trim();
  const lines = [
    `# VibeFlow dispatch → ${engine}`,
    "",
    `Goal: ${goal}`,
    `Work units: ${names.length ? names.join(", ") : "(none — running the whole task)"}`,
    "",
  ];
  if (specs.length) {
    lines.push("Work unit details:");
    for (const u of specs) {
      lines.push(`- ${u.name}`);
      if (u.scope?.length) lines.push(`  scope: ${u.scope.join(", ")}`);
      if (u.spec?.trim()) lines.push(`  spec: ${u.spec.trim()}`);
      if (u.skills?.length) lines.push(`  skills: ${u.skills.join(", ")}`);
    }
    lines.push("");
  }
  // Skills-first: name the verified skills the engine MUST follow, and flag knowledge-heavy units
  // with no matching skill so the engine doesn't silently freelance (esp. UX/UI).
  const matched = objs.flatMap((u) => u.skills ?? []);
  const gaps = objs.filter((u) => u.skillGap).map((u) => u.name);
  if (matched.length || gaps.length) {
    lines.push("Skills:");
    if (matched.length) {
      lines.push(
        `- Follow these verified skills before improvising: ${[...new Set(matched)].join(", ")}.`,
      );
    }
    if (gaps.length) {
      lines.push(
        `- NO verified skill matched for: ${gaps.join(", ")}. Do NOT freelance knowledge-heavy work (especially UX/UI) — follow the spec exactly, mirror existing patterns in the repo, and flag in your uncertainty that no skill backed this.`,
      );
    }
    lines.push("");
  }
  // Tell the engine which code-navigation MCP tools are configured so it prefers them over a
  // blind grep/find. Driven by SETTINGS.json tool toggles; silent when none are enabled.
  const enabledTools: string[] = [];
  if (ctx.settings?.tools?.codegraph) enabledTools.push("codegraph (code-graph MCP)");
  if (ctx.settings?.tools?.lsp) enabledTools.push("lsp (language-server MCP)");
  if (enabledTools.length) {
    lines.push(
      "Code navigation:",
      `- Prefer these MCP tools over raw grep/find for definitions, references, and callers: ${enabledTools.join(", ")}.`,
      "- Priority order: codegraph > lsp > native search. Fall back to native only if the tool is unavailable.",
      "",
    );
  }
  lines.push(
    "Constraints:",
    "- Stay within the declared scope of your work unit.",
    "- Use selected skills; do not invent manual steps when a verified skill exists.",
    "- Return a JSON summary: skills used, files changed, commands run, tests run, confidence, uncertainty.",
    "",
  );
  return lines.join("\n");
}

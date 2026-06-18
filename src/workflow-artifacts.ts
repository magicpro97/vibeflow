// size-waiver: #186 — workflow-artifacts.ts split into workflow-artifacts/{render,validate,types}; see issue #186
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type AgentEngine, agentFilePath, renderForEngine, yamlQuote } from "./agents/render.js";
import type { RoleModel, RoleSpec, ToolIntent } from "./agents/role.js";
import type { WorkflowPhase } from "./ai-init-workflow.js";
import { CTX_DIR, VERSION } from "./core.js";
import { VF_BLOCK_END, VF_BLOCK_START, mergeManagedBlock } from "./workflow/merge.js";

export type { WorkflowPhase };

// ── Engine config (add a new entry here to support a new engine) ──────────

interface EngineConfig {
  instructionFiles: string[];
  skillRoot: string;
}

export const ENGINE_CONFIGS: Record<AgentEngine, EngineConfig> = {
  claude: {
    instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    skillRoot: ".claude/skills",
  },
  codex: { instructionFiles: ["AGENTS.md"], skillRoot: ".agents/skills" },
  copilot: { instructionFiles: [".github/copilot-instructions.md"], skillRoot: ".github/skills" },
};

/**
 * Single source of truth for per-engine skill mirror directories.
 *
 * This is the WRITE side: `vf init` and `vf skills sync` copy skills
 * from `.vibeflow/skills/<name>/` into each of these roots. The READ
 * side (`src/skills/registry.ts` and `src/skills/validator.ts`) MUST
 * scan the same roots so that a freshly-synced skill is discoverable
 * by `vf skills list` / `vf skills validate`.
 *
 * Audit (C2) found that this list was duplicated as `MIRRORS` in
 * `src/skills/sync.ts` AND that the read side had a DIFFERENT,
 * overlapping set of roots (`.vibeflow`, `.kiro`, `.claude`), missing
 * `.agents` and `.github` — so a skill synced to codex/copilot mirrors
 * was invisible to `vf skills list`. The fix: both sides import
 * `SKILL_MIRRORS` from this module.
 */
export const SKILL_MIRRORS: string[] = [
  ENGINE_CONFIGS.claude.skillRoot,
  ENGINE_CONFIGS.codex.skillRoot,
  ENGINE_CONFIGS.copilot.skillRoot,
];

// ── Public options ─────────────────────────────────────────────────────────

export interface WorkflowArtifactOpts {
  phases: WorkflowPhase[];
  engines: AgentEngine[];
  projectName: string;
  base: string;
}

/**
 * Dependency-injection slot for the warn callback used by
 * `generateWorkflowArtifacts`. Default is `console.warn` in production;
 * tests pass a capturing function to assert warnings without polluting
 * stdout. Matches the `copySkillCreator` pattern at the top of this
 * file.
 */
export interface GenerateArtifactsInject {
  onWarn?: (msg: string) => void;
}

// ── Common template skill copy ─────────────────────────────────────────────

/**
 * Resolve the path to the common template skill for a given phase name.
 * The templates live at `<package>/templates/skills/<phase>/SKILL.md` and
 * ship with the package (see `package.json` `files[]`).
 *
 * The resolution uses `import.meta.url` so it works from both source
 * (Bun, `dist/` after build) and the published package — Bun builds with
 * `--target=node` rewrite `import.meta.url` to a `file://` URL, and the
 * package keeps `templates/skills/` next to `dist/cli.js`.
 */
function commonTemplateSkillPath(phaseName: string): string {
  const url = new URL(`../templates/skills/${phaseName}/SKILL.md`, import.meta.url);
  return url.pathname;
}

/**
 * Copy the bundled common skill for a phase from `templates/skills/<phase>/SKILL.md`
 * into each engine's skill root. Mirrors `copySkillCreator` (DI for `exists`
 * + `onWarn` to keep the missing-source path testable). The phase name is
 * used as the destination skill directory name (matches the phase slug, so
 * `generateWorkflowArtifacts` writes the same final path whether it
 * renders a stub or copies a common skill).
 *
 * Returns the list of relative paths written (one per engine).
 */
export function copyCommonTemplateSkill(
  phaseName: string,
  base: string,
  engines: AgentEngine[],
  inject: { exists?: (p: string) => boolean; onWarn?: (msg: string) => void } = {},
): string[] {
  const exists = inject.exists ?? existsSync;
  const onWarn = inject.onWarn ?? ((msg) => console.warn(msg));
  const written: string[] = [];
  const srcPath = commonTemplateSkillPath(phaseName);
  if (!exists(srcPath)) {
    onWarn(
      `vibeflow: common template skill not found at ${srcPath} — falling back to stub for phase "${phaseName}".`,
    );
    return written;
  }
  for (const engine of engines) {
    const dstRelPath = skillFilePath(engine, phaseName);
    const dstDir = join(base, dirname(dstRelPath));
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(srcPath, join(base, dstRelPath));
    written.push(dstRelPath);
  }
  return written;
}

// ── Phase helpers ──────────────────────────────────────────────────────────

function phaseSlug(phase: WorkflowPhase): string {
  return phase.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when the user supplied concrete input AND output paths for the
 * phase. When true, the AI enrichment (Phase 2) is expected to read the
 * declared files and generate a project-specific skill; when false, a
 * generic common template is copied instead.
 */
function hasUserDeclaredIO(phase: WorkflowPhase): boolean {
  const inputs = phase.inputs?.filter((s) => s.trim().length > 0) ?? [];
  const outputs = phase.outputs?.filter((s) => s.trim().length > 0) ?? [];
  return inputs.length > 0 && outputs.length > 0;
}

function phaseAgentName(phase: WorkflowPhase): string {
  return `phase-${phaseSlug(phase)}`;
}

function orchestratorAgentName(): string {
  return "workflow-orchestrator";
}

function orchestratorAgentPath(engine: AgentEngine): string {
  return agentFilePath(engine, orchestratorAgentName());
}

function skillDirPath(engine: AgentEngine, skillName: string): string {
  return `${ENGINE_CONFIGS[engine].skillRoot}/${skillName}`;
}

function skillFilePath(engine: AgentEngine, skillName: string): string {
  return `${skillDirPath(engine, skillName)}/SKILL.md`;
}

// ── Orchestrator definition ────────────────────────────────────────────────

function renderAgentPaths(phase: WorkflowPhase, engines: AgentEngine[]): string {
  const slug = phaseSlug(phase);
  const first = engines[0];
  if (engines.length === 1 && first) {
    return `- Agent: \`${agentFilePath(first, `phase-${slug}`)}\``;
  }
  return engines.map((e) => `- Agent (${e}): \`${agentFilePath(e, `phase-${slug}`)}\``).join("\n");
}

function renderSkillPaths(phase: WorkflowPhase, engines: AgentEngine[]): string {
  const slug = phaseSlug(phase);
  const first = engines[0];
  if (engines.length === 1 && first) {
    return `- Skill: \`${skillFilePath(first, slug)}\``;
  }
  return engines.map((e) => `- Skill (${e}): \`${skillFilePath(e, slug)}\``).join("\n");
}

function renderWorkflowBody(
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): string {
  const lines: string[] = [
    `# Workflow Orchestrator — ${projectName}`,
    "",
    `Generated by VibeFlow v${VERSION}. Edit phase descriptions and DoDs here; re-run \`vf init\` to regenerate agent/skill files.`,
    "",
    "## Phases",
    "",
    `Total: ${phases.length} phase(s)`,
    "",
  ];
  for (const [i, p] of phases.entries()) {
    const slug = phaseSlug(p);
    const prev = i > 0 ? phases[i - 1] : undefined;
    const prevName = prev?.name ?? null;
    const deps = prevName ? `Depends on: ${prevName}` : "No dependencies";
    const entries: Array<string | null> = [
      `### ${i + 1}. ${p.name}`,
      "",
      `- Description: ${p.description || "(none)"}`,
      renderAgentPaths(p, engines),
      renderSkillPaths(p, engines),
      `- ${deps}`,
      `- Inputs: ${p.inputs?.length ? p.inputs.join(", ") : "(auto)"}`,
      `- Outputs: ${p.outputs?.length ? p.outputs.join(", ") : "(auto)"}`,
      p.template ? `- Template: ${p.template}` : null,
      p.dod ? `- Definition of Done: ${p.dod}` : null,
      "",
    ];
    lines.push(...entries.filter((e): e is string => e !== null));
  }
  lines.push(
    "## Usage",
    "",
    "Run `vf orchestrate` to execute pending phases in order.",
    "Each phase is dispatched to its configured agent with the associated skill.",
    "",
  );
  return lines.filter((l) => l !== null).join("\n");
}

function buildOrchestratorSpec(
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): RoleSpec {
  return {
    name: orchestratorAgentName(),
    description: `Coordinate ${projectName} workflow phases and dispatch phase agents in order`,
    body: renderWorkflowBody(phases, engines, projectName),
    tools: ["read", "write", "edit", "bash", "grep", "glob"],
    model: "sonnet" as RoleModel,
  };
}

// ── Per-phase agent files ──────────────────────────────────────────────────

function inferPhaseTools(_phase: WorkflowPhase): ToolIntent[] {
  return ["read", "write", "edit", "bash", "grep", "glob"];
}

function buildPhaseSpec(phase: WorkflowPhase, projectName: string, skillPath: string): RoleSpec {
  const slug = phaseSlug(phase);
  let body = [
    `# ${phase.name}`,
    "",
    phase.description || `Execute the ${phase.name} phase.`,
    "",
  ].join("\n");
  if (phase.inputs?.length) {
    body += `## Inputs\n\n${phase.inputs.map((i) => `- ${i}`).join("\n")}\n\n`;
  }
  if (phase.outputs?.length) {
    body += `## Outputs\n\n${phase.outputs.map((o) => `- ${o}`).join("\n")}\n\n`;
  }
  if (phase.template) body += `## Template\n\n${phase.template}\n\n`;
  if (phase.dod) body += `## Definition of Done\n\n${phase.dod}\n\n`;
  body += `## Skill\n\nRead \`${skillPath}\` before executing this phase.\n`;
  return {
    name: phaseAgentName(phase),
    description: phase.description || `Execute ${phase.name} phase`,
    body,
    tools: inferPhaseTools(phase),
    model: "sonnet" as RoleModel,
  };
}

// ── Per-phase skill files ──────────────────────────────────────────────────

function renderPhaseSkill(phase: WorkflowPhase, projectName: string): string {
  const slug = phaseSlug(phase);
  const lines: string[] = [
    "---",
    `name: ${slug}`,
    `description: ${yamlQuote(phase.description || `Execute the ${phase.name} phase.`)}`,
    "---",
    "",
    `# ${phase.name} — ${projectName}`,
    "",
    phase.description || `Execute the ${phase.name} phase.`,
    "",
    "## Inputs",
    "",
  ];
  if (phase.inputs?.length) {
    lines.push(...phase.inputs.map((i) => `- ${i}`));
  } else {
    lines.push("- (auto-detected from project context)");
  }
  lines.push("", "## Outputs", "");
  if (phase.outputs?.length) {
    lines.push(...phase.outputs.map((o) => `- ${o}`));
  } else {
    lines.push("- (auto-detected from project context)");
  }
  if (phase.template) {
    lines.push("", "## Template", "", phase.template);
  }
  lines.push("", "## Execution Steps", "");
  if (phase.inputs?.length) {
    lines.push("1. Read all inputs and understand the current state.");
  } else {
    lines.push("1. Scan the project to understand the current state.");
  }
  lines.push("2. Review the Definition of Done to know when the phase is complete.");
  if (phase.template) {
    lines.push("3. Follow the phase template to produce the required outputs.");
  } else {
    lines.push("3. Execute the phase work according to the description.");
  }
  if (phase.outputs?.length) {
    lines.push("4. Write outputs to the declared output paths.");
  } else {
    lines.push("4. Document the results in the project context.");
  }
  lines.push("5. Verify against the Definition of Done before marking complete.");
  lines.push("6. Record evidence of completion (file paths, command output, or test results).");
  if (phase.dod) lines.push("", "## Definition of Done", "", phase.dod);
  lines.push("", "---", "", `Powered by VibeFlow v${VERSION}`);
  return lines.join("\n");
}

// ── Engine instruction managed block update ────────────────────────────────

function orchestratorSnippet(phases: WorkflowPhase[], engines: AgentEngine[]): string | null {
  if (!phases.length) return null;
  const files = engines.map((e) => `\`${orchestratorAgentPath(e)}\``).join(", ");
  return [
    "## Workflow",
    "",
    `This project has ${phases.length} defined workflow phase(s).`,
    `Read ${files} for the phase DAG and agent assignments.`,
    "Run `vf orchestrate` to execute pending phases.",
    "",
  ].join("\n");
}

function appendToManagedBlock(filePath: string, addendum: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  const start = content.indexOf(VF_BLOCK_START);
  const end = content.indexOf(VF_BLOCK_END);
  let newBlock: string;
  if (start !== -1 && end !== -1 && end > start) {
    const current = content.slice(start + VF_BLOCK_START.length, end).trim();
    newBlock = `${current}\n\n${addendum}`;
  } else {
    newBlock = addendum;
  }
  const merged = mergeManagedBlock(content, newBlock);
  writeFileSync(filePath, merged.content);
}

// ── Skill-creator copy ─────────────────────────────────────────────────────

/**
 * Copy the bundled `skill-creator` skill from the package's own
 * `.agents/skills/skill-creator/` into each engine's skill root in `base`.
 *
 * Dependency-injected `exists` and `onWarn` make the missing-source path
 * testable without renaming real files. Default `exists` is `existsSync`
 * and default `onWarn` is `console.warn` — production callers don't pass
 * them.
 */
export function copySkillCreator(
  base: string,
  engines: AgentEngine[],
  inject: { exists?: (p: string) => boolean; onWarn?: (msg: string) => void } = {},
): string[] {
  const exists = inject.exists ?? existsSync;
  const onWarn = inject.onWarn ?? ((msg) => console.warn(msg));
  const written: string[] = [];
  const srcUrl = new URL("../.agents/skills/skill-creator", import.meta.url);
  const srcPath = srcUrl.pathname;
  if (!exists(srcPath)) {
    onWarn(
      `vibeflow: skill-creator source not found at ${srcPath} — AI enrichment will be degraded. Check package.json files[] includes ".agents/skills/skill-creator".`,
    );
    return written;
  }
  for (const engine of engines) {
    const dstDir = join(base, skillDirPath(engine, "skill-creator"));
    copyRecursiveSync(srcPath, dstDir);
    written.push(skillDirPath(engine, "skill-creator"));
  }
  return written;
}

function copyRecursiveSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyRecursiveSync(srcPath, dstPath);
    } else {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }
  }
}

// ── AI enrichment prompt ───────────────────────────────────────────────────

function renderPhaseListLine(phase: WorkflowPhase, engines: AgentEngine[]): string {
  const slug = phaseSlug(phase);
  const dod = phase.dod ? `DoD: ${phase.dod}` : "";
  const agentPaths = engines.map((e) => agentFilePath(e, `phase-${slug}`));
  const agents = agentPaths.join(", ");
  const skillPaths = engines.map((e) => skillFilePath(e, slug)).join(", ");
  return `  - ${phase.name} (agent: ${agents}, skill: ${skillPaths}) ${dod}`;
}

export function buildEnrichmentPrompt(
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  profile: { name: string; summary?: string; languages: string[] },
  _base: string,
): string {
  const phaseList = phases.map((p) => renderPhaseListLine(p, engines)).join("\n");
  const orchestratorFiles = engines.map((e) => orchestratorAgentPath(e));
  const instructionFiles = engines.flatMap((e) => ENGINE_CONFIGS[e]?.instructionFiles ?? []);
  const uniqueInstructionFiles = [...new Set(instructionFiles)];
  const agentDirs = [
    ...new Set(engines.map((e) => dirname(agentFilePath(e, "phase-placeholder")))),
  ];
  const agentSection = agentDirs.map((d) => `  - \`${d}/\``).join("\n");
  const skillFiles = phases.flatMap((p) => {
    const slug = phaseSlug(p);
    return engines.map((e) => skillFilePath(e, slug));
  });
  const skillSection = skillFiles.map((f) => `  - \`${f}\``).join("\n");

  return [
    `# VibeFlow Init — ${profile.name}`,
    "",
    `Project: ${profile.name}`,
    profile.summary ? `Summary: ${profile.summary}` : null,
    `Stack: ${profile.languages.join(", ")}`,
    `Engines: ${engines.join(", ")}`,
    "",
    "## Phase 1: Project Analysis",
    "",
    "Analyze the project to enrich the AI context files with project-specific guidance.",
    "",
    `1. Read \`${CTX_DIR}/PROJECT_CONTEXT.md\` and the scanned \`${CTX_DIR}/ai-context/\` files.`,
    ...(uniqueInstructionFiles.length
      ? [
          `2. Enrich ${uniqueInstructionFiles.join(", ")} with project-specific details (stack, conventions, workflows).`,
        ]
      : []),
    "3. Only modify content within the `<!-- vibeflow:start -->` / `<!-- vibeflow:end -->` fence.",
    "4. Do NOT remove or alter content outside the fence (human-authored text).",
    "",
    "## Phase 2: Workflow Artifact Enrichment",
    "",
    "The deterministic workflow artifacts have been generated. Enrich them using the skill-creator methodology.",
    "",
    `1. Read ${orchestratorFiles.map((f) => `\`${f}\``).join(", ")} to understand the workflow structure.`,
    `2. Read ${engines.map((e) => `\`${skillFilePath(e, "skill-creator")}\``).join(", ")} and apply the skill-creator methodology.`,
    "3. For each phase skill file under the selected engine skill root (excluding skill-creator/):",
    "   - Treat the phase's declared inputs and outputs as STRUCTURAL EXAMPLES, not as content to copy.",
    "   - Extract the TRANSFORMATION PATTERN (input structure → output structure).",
    "   - Rewrite the skill body as a REUSABLE TEMPLATE that the phase agent can",
    "     apply to ANY task of the same phase type, not just the one being processed now.",
    "   - Use placeholders (`{{...}}`) for project/task-specific values.",
    "   - Do NOT embed concrete requirement IDs (BR-001, E-014, AC-032, etc.) from the sample task.",
    "   - Do NOT hardcode file paths from the current project into the skill body.",
    "   - Do describe the structural pattern, the transformation rules, and the verification approach.",
    "   - Include an Anti-Patterns section that lists common mistakes to avoid.",
    "   - The skill should remain valid for the NEXT task of the same phase type.",
    "4. Project context (build/test/lint commands, conventions, stack) goes into the instruction files and PROJECT_CONTEXT.md, not into the phase skill body.",
    ...(agentDirs.length === 1
      ? [`5. For each phase agent file under \`${agentDirs[0]}/\`:`]
      : ["5. For each phase agent file:"]
    ).map(
      (l) =>
        `${l}
   - Enrich the agent body with project-specific context
   - Add relevant tool usage patterns
   - Reference the associated skill file`,
    ),
    "6. Update the workflow orchestrator agent if needed to reflect project-specific phase details.",
    "7. Do NOT remove existing content — only enrich and expand.",
    "8. Record evidence of changes in your output.",
    "",
    "## Phases",
    "",
    phaseList,
    "",
    "## Files to Analyze & Enrich",
    "",
    ...(uniqueInstructionFiles.length
      ? ["### Instruction files", ...uniqueInstructionFiles.map((f) => `  - \`${f}\``), ""]
      : []),
    "### Skill files",
    skillSection,
    "",
    "### Agent files",
    agentSection,
    "",
    "---",
    "",
    "Powered by VibeFlow",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ── Main entry point ───────────────────────────────────────────────────────

export function generateWorkflowArtifacts(
  opts: WorkflowArtifactOpts,
  inject: GenerateArtifactsInject = {},
): string[] {
  const { phases, engines, projectName, base } = opts;
  const onWarn = inject.onWarn ?? ((msg) => console.warn(msg));
  if (!phases.length) {
    // Issue #83: silent no-op was a defect. Surface a warning so the
    // caller (and the user) knows nothing was generated.
    onWarn("vibeflow: generateWorkflowArtifacts called with no phases — nothing to generate.");
    return [];
  }

  const written: string[] = [];

  // 1. Workflow orchestrator agent (one per engine)
  const orchestratorSpec = buildOrchestratorSpec(phases, engines, projectName);
  for (const engine of engines) {
    const relPath = orchestratorAgentPath(engine);
    const absPath = join(base, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, renderForEngine(engine, orchestratorSpec));
    written.push(relPath);
  }

  // 2. Per-phase agent files (one per engine)
  const agentDirsCreated = new Set<string>();
  for (const phase of phases) {
    for (const engine of engines) {
      const spec = buildPhaseSpec(phase, projectName, skillFilePath(engine, phaseSlug(phase)));
      const relPath = agentFilePath(engine, phaseAgentName(phase));
      const absPath = join(base, relPath);
      const dir = dirname(absPath);
      if (!agentDirsCreated.has(dir)) {
        mkdirSync(dir, { recursive: true });
        agentDirsCreated.add(dir);
      }
      writeFileSync(absPath, renderForEngine(engine, spec));
      written.push(relPath);
    }
  }

  // 3. Per-phase skill files.
  //    When the user declared concrete input+output paths the skill stub
  //    carries those paths so Phase 2 AI reads them and enriches with
  //    actual file content.  When paths are missing a common template
  //    skill (shipped under `templates/skills/<phase-name>/`) is copied
  //    instead.  Either way the resulting file sits at the same path.
  //
  //    Each phase skill is written in TWO places:
  //    1. Canonical store: `.vibeflow/skills/<slug>/SKILL.md` — source of
  //       truth, owned by VibeFlow, validated by `vf skills validate`.
  //    2. Engine mirror: `<engine-skill-root>/<slug>/SKILL.md` — what the
  //       engine reads at runtime. For copilot = `.github/skills/`.
  //
  //    Writing only to the mirror (legacy behaviour) caused the AI
  //    skill-curator unit in Phase 2 to mistake the canonical location
  //    for "stale empty dirs" and delete the phase-skill scaffolding
  //    from `.vibeflow/skills/`. Both writes are needed so the
  //    canonical store and the engine mirror stay in lockstep.
  for (const phase of phases) {
    const slug = phaseSlug(phase);
    // Render the content once (stub or common template) and write to
    // both canonical + each engine mirror.
    let content: string;
    if (hasUserDeclaredIO(phase)) {
      // Phase with concrete paths → render stub for AI enrichment.
      content = renderPhaseSkill(phase, projectName);
    } else {
      // No concrete paths → copy the bundled common template into a
      // temp buffer (we read it from disk so we can also write to the
      // canonical store, not just the engine mirror).
      const templatePath = commonTemplateSkillPath(slug);
      if (existsSync(templatePath)) {
        content = readFileSync(templatePath, "utf8");
      } else {
        // Template not found (e.g. custom phase name) → fall back to
        // the generic stub. emit the same warning once per phase.
        onWarn(
          `vibeflow: no common template for phase "${phase.name}" (slug: ${slug}) — rendering generic stub.`,
        );
        content = renderPhaseSkill(phase, projectName);
      }
    }

    // Write to canonical store (single source of truth). This must
    // happen BEFORE the engine mirror so a single `vf skills sync`
    // can later pick up the canonical copy and mirror it elsewhere.
    const canonicalDir = join(base, CTX_DIR, "skills", slug);
    const canonicalPath = join(canonicalDir, "SKILL.md");
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(canonicalPath, content);
    written.push(`${CTX_DIR}/skills/${slug}/SKILL.md`);

    // Mirror to each engine's skill root so the engine reads it at
    // runtime. Same content — a thin pointer would also work, but a
    // full copy means the mirror is usable even if the canonical is
    // temporarily missing (e.g. during re-init).
    for (const engine of engines) {
      const mirrorDir = join(base, skillDirPath(engine, slug));
      const mirrorPath = skillFilePath(engine, slug);
      mkdirSync(mirrorDir, { recursive: true });
      writeFileSync(join(base, mirrorPath), content);
      written.push(mirrorPath);
    }
  }

  // 4. Update engine instruction files with orchestrator reference
  const snippet = orchestratorSnippet(phases, engines);
  if (snippet) {
    for (const engine of engines) {
      const cfg = ENGINE_CONFIGS[engine];
      if (!cfg) continue;
      for (const fileName of cfg.instructionFiles) {
        appendToManagedBlock(join(base, fileName), snippet);
      }
    }
  }

  return written;
}

/**
 * Remove per-engine skill + agent directories that belong to engines the
 * user did NOT select. Prevents the engine-mirror fan-out bug where:
 * - Phase 1.5 deterministic code (pre-fix) wrote to all engine mirrors
 * - Phase 2 AI enrichment runs `ctx7 skills install` which writes to
 *   `.agents/skills/` (universal) regardless of the selected engine
 *
 * Uses `ENGINE_CONFIGS` as the single source of truth for which paths
 * to prune. Only removes the known engine skillRoot + its sibling
 * `agents/` subdirectory. Leaves other contents (MCP configs, hook
 * configs, user-authored files) untouched.
 *
 * Idempotent: missing directories are silently skipped.
 *
 * @returns relative paths of pruned directories (for logging).
 */
export function pruneUnselectedEngineFolders(base: string, selectedEngine: AgentEngine): string[] {
  const removed: string[] = [];
  for (const [engine, cfg] of Object.entries(ENGINE_CONFIGS) as Array<
    [AgentEngine, EngineConfig]
  >) {
    if (engine === selectedEngine) continue;

    // Mirror root: e.g. .claude/skills, .agents/skills
    const skillRoot = join(base, cfg.skillRoot);
    if (existsSync(skillRoot)) {
      try {
        rmSync(skillRoot, { recursive: true, force: true });
        removed.push(cfg.skillRoot);
      } catch {
        // best-effort
      }
    }
    // Agent dir: e.g. .claude/agents, .github/agents
    const agentDir = join(base, dirname(cfg.skillRoot), "agents");
    if (existsSync(agentDir)) {
      try {
        rmSync(agentDir, { recursive: true, force: true });
        removed.push(join(dirname(cfg.skillRoot), "agents"));
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

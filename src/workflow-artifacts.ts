import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEngine } from "./agents/render.js";
import { agentFilePath, renderForEngine } from "./agents/render.js";
import type { RoleSpec } from "./agents/role.js";
import type { WorkflowPhase } from "./ai-init-workflow.js";
import { CTX_DIR } from "./core.js";
import {
  renderOrchestratorBody,
  renderPhaseAgentBody,
} from "./workflow-artifacts/agent-templates.js";
import {
  commonTemplateSkillPath,
  skillDirPath,
  skillFilePath,
} from "./workflow-artifacts/common-template.js";
import {
  appendToManagedBlock,
  orchestratorAgentPath,
  orchestratorSnippet,
  phaseAgentName,
  renderPhaseListLine,
} from "./workflow-artifacts/phase-specs.js";
import { renderPhaseSkill } from "./workflow-artifacts/phase-templates.js";
import type {
  EngineConfig,
  GenerateArtifactsInject,
  WorkflowArtifactOpts,
} from "./workflow-artifacts/types.js";
import { ENGINE_CONFIGS, hasUserDeclaredIO, phaseSlug } from "./workflow-artifacts/types.js";
export { copyPhaseAgentTemplates, copyUsageGuide } from "./workflow-artifacts/agent-templates.js";

// ── Re-exports (public surface, unchanged for the 6 importers) ──────────────

export { copyCommonTemplateSkill, copySkillCreator } from "./workflow-artifacts/common-template.js";
export {
  copyPhaseSkillTemplates,
  ensureContextDir,
  readPhaseSkillTemplate,
} from "./workflow-artifacts/phase-templates.js";
export { ENGINE_CONFIGS, SKILL_MIRRORS } from "./workflow-artifacts/types.js";
export type {
  GenerateArtifactsInject,
  WorkflowArtifactOpts,
  WorkflowPhase,
} from "./workflow-artifacts/types.js";

// ── Enrichment prompt ──────────────────────────────────────────────────────

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

  // 1. Workflow orchestrator agent (one per engine) — body from template
  const orchestratorBody = renderOrchestratorBody(phases, engines, projectName);
  const orchestratorSpec: RoleSpec = {
    name: "workflow-orchestrator",
    description: `Coordinate ${projectName} workflow phases and dispatch phase agents in order`,
    body: orchestratorBody,
    tools: ["read", "write", "edit", "bash", "grep", "glob"],
    model: "sonnet",
  };
  for (const engine of engines) {
    const relPath = orchestratorAgentPath(engine);
    const absPath = join(base, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, renderForEngine(engine, orchestratorSpec));
    written.push(relPath);
  }

  // 2. Per-phase agent files (one per engine) — body from template
  const agentDirsCreated = new Set<string>();
  for (const phase of phases) {
    const slug = phaseSlug(phase);
    const firstEngineSkill = skillFilePath(engines[0] ?? "copilot", slug);
    const agentBody = renderPhaseAgentBody(phase, projectName, firstEngineSkill);
    for (const engine of engines) {
      const engineSkillPath = skillFilePath(engine, slug);
      const relPath = agentFilePath(engine, phaseAgentName(phase));
      const absPath = join(base, relPath);
      const dir = dirname(absPath);
      if (!agentDirsCreated.has(dir)) {
        mkdirSync(dir, { recursive: true });
        agentDirsCreated.add(dir);
      }
      const spec: RoleSpec = {
        name: phaseAgentName(phase),
        description: phase.description || `Execute ${phase.name} phase`,
        body: agentBody.replace(/\{\{SKILL_PATH\}\}/g, engineSkillPath),
        tools: ["read", "write", "edit", "bash", "grep", "glob"],
        model: "sonnet",
      };
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

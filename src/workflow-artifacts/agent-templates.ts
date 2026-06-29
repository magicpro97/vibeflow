import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEngine } from "../agents/render.js";
import { agentFilePath } from "../agents/render.js";
import type { WorkflowPhase } from "../ai-init-workflow.js";
import { CTX_DIR, VERSION } from "../core.js";
import { skillFilePath } from "./common-template.js";
import {
  buildOrchestratorSpec,
  buildPhaseSpec,
  orchestratorAgentName,
  phaseAgentName,
} from "./phase-specs.js";
import { resolveTemplatePath } from "./template-path.js";
import { phaseSlug } from "./types.js";

const FM_RE = /^---\n[\s\S]*?\n---\n/;

function stripFrontmatter(content: string): string {
  return content.replace(FM_RE, "");
}

function readPhaseAgentTemplate(phase: WorkflowPhase): string | null {
  const slug = phaseSlug(phase);
  const path =
    resolveTemplatePath(`agents/phase-${slug}.md`) ??
    resolveTemplatePath("agents/phase-default.md");
  return path ? readFileSync(path, "utf8") : null;
}

function resolvePhaseTemplateFull(phase: WorkflowPhase): string | null {
  return readPhaseAgentTemplate(phase);
}

function substitutePhaseVars(template: string, phase: WorkflowPhase, skillPath: string): string {
  return template
    .replace(/---\nname: phase-\{\{PHASE_NAME_SLUG\}\}\n/, `---\nname: phase-${phaseSlug(phase)}\n`)
    .replace(/\{\{PHASE_NAME\}\}/g, phase.name)
    .replace(/\{\{PHASE_DESCRIPTION\}\}/g, phase.description || `Execute the ${phase.name} phase.`)
    .replace(/\{\{SKILL_PATH\}\}/g, skillPath)
    .replace(/^\s*\{\{INPUT_OUTPUT_PATHS\}\}\s*$/gm, "");
}

export function readAgentTemplate(name: string): string | null {
  const path = resolveTemplatePath(`agents/${name}.md`);
  return path ? readFileSync(path, "utf8") : null;
}

export function renderOrchestratorBody(
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): string {
  const template = readAgentTemplate("workflow-orchestrator");
  const rowTemplate = readAgentTemplate("orchestrator-phase-row");
  if (!template || !rowTemplate) {
    return buildOrchestratorSpec(phases, engines, projectName).body;
  }

  const rows: string[] = [];
  for (const [i, phase] of phases.entries()) {
    const prev = i > 0 ? phases[i - 1] : undefined;
    const slug = phaseSlug(phase);
    const agentPath = engines.map((e) => agentFilePath(e, phaseAgentName(phase))).join(", ");
    const skillPath = engines.map((e) => skillFilePath(e, slug)).join(", ");

    const row = rowTemplate
      .replace(/\{\{PHASE_NUMBER\}\}/g, String(i + 1))
      .replace(/\{\{PHASE_NAME\}\}/g, phase.name)
      .replace(/\{\{PHASE_DESCRIPTION\}\}/g, phase.description || "(none)")
      .replace(/\{\{PHASE_AGENT_PATH\}\}/g, agentPath)
      .replace(/\{\{PHASE_SKILL_PATH\}\}/g, skillPath)
      .replace(/\{\{PHASE_DEPS\}\}/g, prev ? `Depends on: ${prev.name}` : "No dependencies")
      .replace(/\{\{PHASE_DOD\}\}/g, phase.dod ? `\n- Definition of Done: ${phase.dod}` : "");
    rows.push(row);
  }

  return stripFrontmatter(template)
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{VERSION\}\}/g, VERSION)
    .replace(/\{\{PHASE_COUNT\}\}/g, String(phases.length))
    .replace(/\{\{PHASE_LIST\}\}/g, rows.join("\n").trimEnd());
}

export function renderOrchestratorFull(
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): string {
  const template = readAgentTemplate("workflow-orchestrator");
  const rowTemplate = readAgentTemplate("orchestrator-phase-row");
  if (!template || !rowTemplate) {
    return buildOrchestratorSpec(phases, engines, projectName).body;
  }

  const rows: string[] = [];
  for (const [i, phase] of phases.entries()) {
    const prev = i > 0 ? phases[i - 1] : undefined;
    const slug = phaseSlug(phase);
    const agentPath = engines.map((e) => agentFilePath(e, phaseAgentName(phase))).join(", ");
    const skillPath = engines.map((e) => skillFilePath(e, slug)).join(", ");

    const row = rowTemplate
      .replace(/\{\{PHASE_NUMBER\}\}/g, String(i + 1))
      .replace(/\{\{PHASE_NAME\}\}/g, phase.name)
      .replace(/\{\{PHASE_DESCRIPTION\}\}/g, phase.description || "(none)")
      .replace(/\{\{PHASE_AGENT_PATH\}\}/g, agentPath)
      .replace(/\{\{PHASE_SKILL_PATH\}\}/g, skillPath)
      .replace(/\{\{PHASE_DEPS\}\}/g, prev ? `Depends on: ${prev.name}` : "No dependencies")
      .replace(/\{\{PHASE_DOD\}\}/g, phase.dod ? `\n- Definition of Done: ${phase.dod}` : "");
    rows.push(row);
  }

  return template
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{VERSION\}\}/g, VERSION)
    .replace(/\{\{PHASE_COUNT\}\}/g, String(phases.length))
    .replace(/\{\{PHASE_LIST\}\}/g, rows.join("\n").trimEnd());
}

export function renderPhaseAgentBody(
  phase: WorkflowPhase,
  _projectName: string,
  skillPath: string,
): string {
  const template = readPhaseAgentTemplate(phase);
  if (!template) {
    return buildPhaseSpec(phase, _projectName, skillPath).body;
  }

  const body = substitutePhaseVars(stripFrontmatter(template), phase, skillPath);
  return body;
}

export function renderPhaseAgentFull(
  phase: WorkflowPhase,
  _projectName: string,
  skillPath: string,
): string | null {
  const template = resolvePhaseTemplateFull(phase);
  if (!template) return null;

  return substitutePhaseVars(template, phase, skillPath);
}

export function copyPhaseAgentTemplates(
  base: string,
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): string[] {
  const written: string[] = [];
  const canonDir = join(base, CTX_DIR, "agents");
  mkdirSync(canonDir, { recursive: true });

  const orcName = orchestratorAgentName();
  const orcFull = renderOrchestratorFull(phases, engines, projectName);
  writeFileSync(join(canonDir, `${orcName}.md`), orcFull);
  written.push(`${CTX_DIR}/agents/${orcName}.md`);

  for (const phase of phases) {
    const slug = phaseSlug(phase);
    const firstEngineSkillPath = skillFilePath(engines[0] ?? "copilot", slug);
    const agentName = phaseAgentName(phase);

    const full = renderPhaseAgentFull(phase, projectName, firstEngineSkillPath);
    if (full) {
      writeFileSync(join(canonDir, `${agentName}.md`), full);
      written.push(`${CTX_DIR}/agents/${agentName}.md`);
    }
  }

  return written;
}

const ENGINE_META: Record<
  AgentEngine,
  { name: string; agentDir: string; skillDir: string; instructionFile: string }
> = {
  claude: {
    name: "Claude Code",
    agentDir: ".claude/agents/",
    skillDir: ".claude/skills/",
    instructionFile: "CLAUDE.md",
  },
  codex: {
    name: "Codex",
    agentDir: ".codex/agents/",
    skillDir: ".agents/skills/",
    instructionFile: "AGENTS.md",
  },
  copilot: {
    name: "Copilot",
    agentDir: ".github/agents/",
    skillDir: ".github/skills/",
    instructionFile: ".github/copilot-instructions.md",
  },
};

export function copyUsageGuide(
  base: string,
  phases: WorkflowPhase[],
  engines: AgentEngine[],
  projectName: string,
): string[] {
  const templatePath = resolveTemplatePath("guides/VIBEFLOW_USAGE.md");
  if (!templatePath) return [];

  const phaseListSummary = phases
    .map((p, i) => `  ${i + 1}. **${p.name}** — ${p.description || ""}`)
    .join("\n");

  const primary = engines[0] ? ENGINE_META[engines[0]] : ENGINE_META.copilot;
  const engineTable = engines
    .map((e) => {
      const m = ENGINE_META[e];
      return `| ${m.name} | \`${m.instructionFile}\`, \`${m.agentDir}*\`, \`${m.skillDir}*\` |`;
    })
    .join("\n");

  const content = readFileSync(templatePath, "utf8")
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PHASE_COUNT\}\}/g, String(phases.length))
    .replace(/\{\{PHASE_LIST_SUMMARY\}\}/g, phaseListSummary)
    .replace(/\{\{ENGINE_NAME\}\}/g, primary.name)
    .replace(/\{\{ENGINE_AGENT_DIR\}\}/g, primary.agentDir)
    .replace(/\{\{ENGINE_SKILL_DIR\}\}/g, primary.skillDir)
    .replace(/\{\{ENGINE_INSTRUCTION_FILE\}\}/g, primary.instructionFile)
    .replace(/\{\{ENGINE_TABLE\}\}/g, engineTable)
    .replace(/--\s*$/, "");

  const relPath = "VIBEFLOW.md";
  writeFileSync(join(base, relPath), content);
  return [relPath];
}

/**
 * AI-init workflow unit constructors.
 *
 * Builds Tier-1 adapter units, Tier-2 phase units, phase-skill
 * enrichment units, and finisher batch units.
 * Imports from ./types.js + ./descriptions.js + ./skill-curator-spec.js.
 */

import { ROLE_NAMES, type RoleName } from "../agents/role-templates.js";
import type { Engine } from "../core.js";
import { PENDING_REQUIRED_WORK_UNIT_GATES, WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import type { ProjectProfile } from "../scanner.js";
import {
  ADAPTER_DESCRIPTION,
  ROLE_SKILLS,
  instructionDescription,
  phaseSlug,
  resolveOwner,
  selectedInstructionScope,
  stackSkillsForProfile,
} from "./descriptions.js";
import { skillCuratorDescription } from "./skill-curator-spec.js";
import type { AiInitAdapterName, AiInitIntake, AiInitUnit } from "./types.js";
/** Build the spec text for one Tier-1 adapter unit, given the live
 *  project context. The spec is what the engine receives as `unit.spec`
 *  in the dispatch prompt. */
export function buildAdapterSpec(
  name: AiInitAdapterName,
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[],
): string {
  const goal = intake.goal?.trim() || "Set up VibeFlow AI guidance for this repository";
  const engines = (intake.engines ?? []).join(", ") || "(default: copilot)";
  const roleList = detectedRoles.length ? detectedRoles.join(", ") : ROLE_NAMES.join(", ");
  return [
    `## ${name}`,
    "",
    `Goal: ${goal}`,
    `Engines: ${engines}`,
    `Project: ${profile.name} (${profile.languages.join(", ") || "unknown"})`,
    `Active roles in this repo: ${roleList}`,
    "",
    name === "ai-init-instruction-writer"
      ? instructionDescription(selectedInstructionScope(intake))
      : name === "ai-init-skill-curator"
        ? skillCuratorDescription(intake, profile)
        : ADAPTER_DESCRIPTION[name],
  ].join("\n");
}

/** Map project profile to candidate stack skill names.
 *  Uses the scanner's own findings (detected languages/frameworks) and
 *  converts each to a kebab-case skill name. This is a general algorithm
 *  — no hardcoded stack names — so it works for ANY project regardless
 *  of tech stack. The skill-curator AI adapter creates skills matching
 *  these names; this function just hints at planning time so phase
 *  units already reference them. */

/** Build one Tier-2 work unit per WorkflowPhase in the intake. Each
 *  phase becomes a unit the orchestrator can dispatch in parallel
 *  alongside the Tier-1 adapter units. The unit's owner_agent,
 *  skills_injected, and skills_required are derived from the resolved
 *  role so the reviewer gates on the right evidence. Stack skills
 *  matching the project profile are injected automatically. */
export function buildPhaseUnits(
  intake: AiInitIntake,
  detectedRoles: RoleName[],
  profile: ProjectProfile,
): AiInitUnit[] {
  const phases = intake.workflowPhases ?? [];
  if (phases.length === 0) return [];
  // T4: enforce phase.name uniqueness. Two phases with the same name would
  // produce two units whose `name` differs only by the position suffix
  // (e.g. ai-init-phase-build-cli-1 and ai-init-phase-build-cli-2), but
  // they share the same slug — a re-run would shadow the first in
  // WORKFLOW_STATE.json and the orchestrator's conflict detection would
  // silently merge them. Case-insensitive: "build-cli" and "Build-CLI"
  // are visually identical in the dashboard.
  const seen = new Set<string>();
  for (const phase of phases) {
    const key = phase.name.trim().toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `duplicate phase name "${phase.name}" in workflowPhases (phase names must be unique, case-insensitive)`,
      );
    }
    seen.add(key);
  }
  return phases.map((phase, idx): AiInitUnit => {
    const slug = phaseSlug(phase.name);
    const unitName = `ai-init-phase-${slug}-${idx + 1}`;
    const owner = resolveOwner(phase.ownerHint, detectedRoles);
    const roleSkills = ROLE_SKILLS[owner];
    const scope = (phase.outputs ?? []).map((o) => o.trim()).filter(Boolean);
    const finalScope = scope.length > 0 ? scope : [`.vibeflow/phase-outputs/${slug}.md`];
    const acceptance = phase.dod?.trim() || `phase ${phase.name} completed (one output path cited)`;
    const spec = [
      `## ${unitName}`,
      "",
      `Phase: ${phase.name}`,
      phase.description ? `Description: ${phase.description}` : "",
      phase.inputs?.length ? `Inputs: ${phase.inputs.join(", ")}` : "",
      phase.outputs?.length ? `Outputs: ${phase.outputs.join(", ")}` : "",
      phase.template ? `Template: ${phase.template}` : "",
      phase.dod ? `Definition of done: ${phase.dod}` : "",
      "",
      "Execute this phase end-to-end. Produce the declared outputs and",
      "stop. Do not start the next phase. If a declared output cannot be",
      "produced, mark the unit blocked and explain why in the JSON output.",
    ]
      .filter(Boolean)
      .join("\n");
    const injectedSet = new Set<string>(roleSkills.injected);
    const requiredSet = new Set<string>(roleSkills.required);
    for (const skill of stackSkillsForProfile(profile)) {
      injectedSet.add(skill);
      requiredSet.add(skill);
    }
    return {
      name: unitName,
      status: WORK_UNIT_STATUS.PENDING,
      confidence: 0,
      owner_agent: owner,
      spec,
      scope: finalScope,
      acceptance,
      skills_injected: [...injectedSet],
      skills_required: [...requiredSet],
      depends_on: [],
      gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  });
}

/**
 * Build Phase-2 phase-skill enrichment units. One unit per phase that
 * has BOTH concrete inputs AND concrete outputs. Each unit asks the
 * engine to read the declared input files as STRUCTURAL EXAMPLES,
 * apply the skill-creator methodology, and enrich the per-phase skill
 * file (already generated by Phase 1.5) with a REUSABLE TEMPLATE that
 * captures the transformation pattern (input structure → output
 * structure), NOT the task-specific content.
 *
 * The resulting skill body MUST remain valid for a future task of the
 * same phase type. It MUST NOT embed concrete requirement IDs (e.g.
 * BR-001, AC-032, E-014) or hardcode file paths from the current
 * project. Project/task-specific values are expressed as placeholders
 * (`{{...}}`) that the dispatch layer fills at execution time.
 *
 * These units are dispatched in parallel with the adapter units
 * inside `runAiInitWorkflow`. They do NOT participate in the long
 * orchestrator loop — they run a single AI pass per phase.
 *
 * Phases without input/output paths are skipped here: Phase 1.5 already
 * copied the common template skill for them, and there is nothing
 * project-specific to enrich against.
 *
 * One engine call per `vf init` run: previously this returned N
 * parallel units (one per phase), each spawning its own engine call.
 * With the typical 3-phase workflow that meant 3 separate engine
 * invocations on the same prompt shape — burning rate-limit budget and
 * ballooning wall-clock. The batched unit below packages all phases
 * into a single spec, the engine processes them in one turn, and the
 * reviewer gates on every per-phase skill file existing on disk.
 */

export function buildPhaseSkillEnrichmentUnits(
  intake: AiInitIntake,
  engines: Engine[],
  skillPathFor: (engine: Engine, slug: string) => string,
): AiInitUnit[] {
  const phases = (intake.workflowPhases ?? []).filter((phase) => {
    const inputs = (phase.inputs ?? []).map((s) => s.trim()).filter(Boolean);
    const outputs = (phase.outputs ?? []).map((s) => s.trim()).filter(Boolean);
    return inputs.length > 0 && outputs.length > 0;
  });
  if (phases.length === 0 || engines.length === 0) return [];
  const target = engines[0] as Engine;

  // Build the per-phase spec sections once and stitch them into one
  // master spec. The engine sees the same per-phase content as before
  // (it just has to walk more sections in one turn), so the per-phase
  // output quality is identical.
  const phaseSections = phases
    .map((phase, idx) => {
      const slug = phaseSlug(phase.name);
      const inputs = (phase.inputs ?? []).map((s) => s.trim()).filter(Boolean);
      const outputs = (phase.outputs ?? []).map((s) => s.trim()).filter(Boolean);
      const skillPath = skillPathFor(target, slug);
      return [
        `### Phase ${idx + 1}: ${phase.name}`,
        "",
        `Slug: ${slug}`,
        phase.description ? `Description: ${phase.description}` : "",
        `Skill file to enrich: \`${skillPath}\``,
        `Inputs (read these to understand the PROJECT STRUCTURE, not to copy): ${inputs.join(", ")}`,
        `Outputs (do NOT touch — evidence paths for the next phase): ${outputs.join(", ")}`,
        phase.template ? `Template: ${phase.template}` : "",
        phase.dod ? `Definition of done: ${phase.dod}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const skillPaths = phases.map((p) => skillPathFor(target, phaseSlug(p.name)));
  const unitName = "ai-init-skill-enrich-batch";
  const spec = [
    `## ${unitName}`,
    "",
    `Enrich ${phases.length} phase skill template(s) in a single pass. Each section below is one phase — process them sequentially within this turn.`,
    "",
    phaseSections,
    "",
    "For EACH phase above:",
    "1. Read every input file to identify the STRUCTURE and CONVENTIONS.",
    "2. Read the current skill file (the TEMPLATE SKELETON).",
    "3. Extract the TRANSFORMATION PATTERN from input→output (not the specific content).",
    "4. Rewrite the skill file in place as a REUSABLE TEMPLATE:",
    "   - Use placeholders like `{{project.name}}`, `{{task.inputs}}`, `{{task.business_rules}}`",
    "   - Do NOT embed task-specific requirement IDs (e.g. BR-001, AC-032, E-014)",
    "   - Do NOT hardcode file paths from the current project",
    "   - Do NOT copy business rules or specific data shapes from the samples",
    "   - Do describe the STRUCTURE that the input MUST follow",
    "   - Do describe what TRANSFORMATIONS to apply",
    "   - Do describe how to VERIFY the output is correct",
    "   - Include an Anti-Patterns section listing common mistakes",
    "5. The skill body MUST be reusable for a DIFFERENT task of the same phase type.",
    "6. Keep the frontmatter (name, description).",
    "7. Do NOT touch the output files — they belong to the next phase.",
    "8. Return JSON: {status: 'verifying'|'blocked', confidence, evidence: [skillPath, ...]}.",
  ].join("\n");

  return [
    {
      name: unitName,
      status: WORK_UNIT_STATUS.PENDING,
      confidence: 0,
      owner_agent: "skill-author",
      spec,
      scope: skillPaths,
      acceptance: `all ${skillPaths.length} phase skill file(s) exist and are non-empty: ${skillPaths.join(", ")}`,
      skills_injected: ["vf-skills", "skill-creator"],
      skills_required: ["ctx7:skill-authoring"],
      depends_on: ["ai-init-analyzer"],
      gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    },
  ];
}

/**
 * P1-7: build a single batched unit that combines the optional
 * finisher work (workflow-state-writer) into one engine call.
 */
export function buildFinisherBatchUnit(
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[],
): AiInitUnit {
  const goal = intake.goal?.trim() || "Set up VibeFlow AI guidance for this repository";
  const engines = (intake.engines ?? []).join(", ") || "(default: copilot)";
  const roleList = detectedRoles.length ? detectedRoles.join(", ") : ROLE_NAMES.join(", ");

  const sections = [
    {
      title: "ai-init-workflow-state-writer",
      scope: [".vibeflow/WORKFLOW_STATE.json"],
      body: ADAPTER_DESCRIPTION["ai-init-workflow-state-writer"],
    },
  ];

  const sectionText = sections
    .map(
      (s, i) =>
        `### Section ${i + 1}: ${s.title}\n\n**Output file**: \`${s.scope[0]}\`\n\n**Scope** (must exist on disk when you're done): ${s.scope.join(", ")}\n\n${s.body}`,
    )
    .join("\n\n");

  const allScope = sections.map((s) => s.scope[0] as string);
  const unitName = "ai-init-finishers-batch";
  const spec = [
    `## ${unitName}`,
    "",
    `Goal: ${goal}`,
    `Engines: ${engines}`,
    `Project: ${profile.name} (${profile.languages.join(", ") || "unknown"})`,
    `Active roles in this repo: ${roleList}`,
    "",
    "This is a BATCHED unit — process the section below in a single turn.",
    "Each section owns exactly ONE file. Do not write to any other path. Read",
    "existing files before editing; merge generated content into the existing",
    "file rather than rewriting it whole. Use the incremental-authoring rule",
    "in AGENTS.md (small first part, then append in follow-up edits if a",
    "section's output would exceed ~1000 lines).",
    "",
    sectionText,
    "",
    "Return JSON: {status: 'verifying'|'blocked', confidence, evidence: [scope, ...]}",
  ].join("\n");

  return {
    name: unitName,
    status: WORK_UNIT_STATUS.PENDING,
    confidence: 0,
    owner_agent: "dispatch-runner",
    spec,
    scope: allScope,
    acceptance: `all ${allScope.length} finisher file(s) exist and are non-empty: ${allScope.join(", ")}`,
    skills_injected: ["vf-skills"],
    skills_required: [],
    depends_on: ["ai-init-analyzer", "ai-init-context-updater"],
    gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    evidence: [],
  };
}

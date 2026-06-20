// size-waiver: #186 — ai-init-workflow.ts split into ai-init-workflow/{dispatch,review,subagents}; see issue #186
/**
 * AI-init workflow decomposition.
 *
 * Decomposes the AI-init surface into 2 tiers of work units that the
 * orchestrator (src/orchestrator/run.ts) can dispatch concurrently with
 * disjoint file scopes, run an independent reviewer over each, and gate
 * close on goalEval (confidence = 1.0 with recorded evidence per unit).
 *
 *   Tier 1 (always 8 adapter units): analyzer, instruction-writer,
 *     skill-curator, context-updater, tool-configurator,
 *     workflow-policy-writer, workflow-state-writer, quickstart-writer.
 *     They cover the canonical baseline (instruction files, skills,
 *     project context, tool config, workflow policy, workflow state,
 *     and the on-boarding quickstart).
 *
 *   Tier 2 (0..N phase units): one unit per `WorkflowPhase` in the
 *     intake, named `ai-init-phase-<slug>-<n>`. Each phase unit carries
 *     the phase's owner_hint, scope (declared outputs), acceptance
 *     signal (the phase's dod), and skill wiring.
 *
 * Pure module: no I/O, no engine calls. Both `planAiInitUnits` and
 * `aiInitReviewer` are deterministic given (profile, intake) so unit
 * tests can pin the decomposition.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_NAMES, type RoleName } from "./agents/role-templates.js";
import { ENGINES, type Engine, type WorkUnit } from "./core.js";
import type { ProjectProfile } from "./scanner.js";

/** A trimmed intake-answers shape this planner depends on. The full
 * `IntakeAnswers` from commands.ts is accepted with all fields optional. */
export interface AiInitIntake {
  goal?: string;
  engines?: string[];
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  repoPath?: string;
  /** Workflow phases the user wants this init to cover. Each phase
   *  becomes a work unit in Tier 2 of the planner. Empty array (or
   *  undefined) is valid — the planner still emits the Tier 1 adapter
   *  units so a project with no explicit phases still gets the full
   *  baseline. */
  workflowPhases?: WorkflowPhase[];
  /** Code-navigation tools the user wants enabled. When absent, the
   *  planner leaves `SETTINGS.json` untouched (user opt-in only). */
  toolToggles?: { codegraph?: boolean; lsp?: boolean };
  /** When true, the planner generates the agent-team agent files
   *  (`.claude/agents/<role>.md` × N roles) alongside the rest. Default
   *  true — matches the legacy `agentFiles()` behaviour. */
  generateAgentTeam?: boolean;
  /** CLI-side ctx7 auth status collected before Phase 2. false means the
   *  user declined/failed login or init is non-interactive, so specs must
   *  use the documented fallback path without prompting again. */
  ctx7Authenticated?: boolean;
}

/** A single user-declared workflow phase. Mirrors the structure the
 *  web intake wizard already exposes in `src/ui/shell.html` (workflow
 *  steps with name, description, definition of done). */
export interface WorkflowPhase {
  /** Stable phase name; the planner uses it as the work-unit name
   *  (`ai-init-phase-<slug>-<n>`). MUST be unique within `workflowPhases`. */
  name: string;
  /** Free-text description the engine sees as the unit spec. */
  description: string;
  /** Inputs this phase consumes (file paths, env, or upstream phase names). */
  inputs?: string[];
  /** Outputs this phase produces (file paths, commands, or downstream
   *  phase names). The reviewer gates on evidence citing at least one. */
  outputs?: string[];
  /** Template the engine should follow (file path or inline body). */
  template?: string;
  /** Definition of done — reviewer reads this to set the acceptance
   *  signal for the phase's work unit. */
  dod?: string;
  /** Hint the planner uses to assign `owner_agent`. Matches a role name
   *  (see `agents/role-templates.ts`) or a substring the planner can
   *  fuzzy-route against detected roles. */
  ownerHint?: string;
}

/** A work unit tailored for the AI init phase. Same fields as
 * {@link WorkUnit} plus an acceptance signal the reviewer uses. The
 * planner sets `owner_agent` to a default role so the orchestrator can
 * route it to the matching engine-agnostic agent, and `spec` to the
 * human-readable description (what the engine receives). */
export interface AiInitUnit extends WorkUnit {
  /** Disjoint file scope — used by the orchestrator to detect conflicts and
   *  serialize overlapping units. The default units below have disjoint
   *  scopes so they all run in parallel under `scheduleWaves`. */
  scope: string[];
  /** Acceptance signal the reviewer checks (e.g. "all 4 instruction files
   *  carry a fresh `vibeflow:start` block"). */
  acceptance: string;
}

/** Stable IDs for the Tier 1 (adapter) init units. The orchestrator
 *  depends on stable names (no UUIDs) so the same workflow reproduces
 *  identical work units on a re-run. Tier 2 phase units are emitted
 *  with names `ai-init-phase-<slug>-<n>` (one per `WorkflowPhase` in
 *  intake). */
export const AI_INIT_ADAPTER_NAMES = [
  "ai-init-analyzer",
  "ai-init-instruction-writer",
  "ai-init-skill-curator",
  "ai-init-context-updater",
  "ai-init-tool-configurator",
  "ai-init-workflow-policy-writer",
  "ai-init-workflow-state-writer",
  "ai-init-quickstart-writer",
] as const;
export type AiInitAdapterName = (typeof AI_INIT_ADAPTER_NAMES)[number];

/** Back-compat export: a flat list of the original 4 unit names. New
 *  code should reference `AI_INIT_ADAPTER_NAMES` (8 entries). Kept so
 *  external callers and the existing test suite still resolve. */
export const AI_INIT_UNIT_NAMES = [
  "ai-init-analyzer",
  "ai-init-instruction-writer",
  "ai-init-skill-curator",
  "ai-init-context-updater",
] as const;
export type AiInitUnitName = (typeof AI_INIT_UNIT_NAMES)[number];

/** Map each Tier-1 adapter unit to its default role (owner_agent). The
 *  reviewer passes when the unit's evidence cites the expected role's
 *  output paths. The 3 newly-added adapters (tool-configurator,
 *  workflow-policy-writer, workflow-state-writer) all map to
 *  `dispatch-runner` or `doc-writer` — they wire the orchestrator's
 *  runtime state. The quickstart-writer maps to `doc-writer` (it owns
 *  a single root-level doc, same family as the instruction-writer). */
const ADAPTER_OWNER: Record<AiInitAdapterName, RoleName> = {
  "ai-init-analyzer": "cli-engine",
  "ai-init-instruction-writer": "doc-writer",
  "ai-init-skill-curator": "skill-author",
  "ai-init-context-updater": "doc-writer",
  "ai-init-tool-configurator": "dispatch-runner",
  "ai-init-workflow-policy-writer": "doc-writer",
  "ai-init-workflow-state-writer": "dispatch-runner",
  "ai-init-quickstart-writer": "doc-writer",
};

/** Per-adapter file scope. Disjoint by design so the orchestrator's
 *  `findScopeConflicts` reports zero conflicts and all units run in
 *  parallel under `runParallel`. Each adapter owns a distinct on-disk
 *  artifact so two units never try to write the same path. */
const ADAPTER_SCOPE: Record<AiInitAdapterName, string[]> = {
  "ai-init-analyzer": [".vibeflow/ai-context/stack-evidence.md"],
  "ai-init-instruction-writer": ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"],
  "ai-init-skill-curator": [".vibeflow/skills/", ".vibeflow/SKILL_INDEX.md"],
  "ai-init-context-updater": [".vibeflow/PROJECT_CONTEXT.md"],
  "ai-init-tool-configurator": [".vibeflow/SETTINGS.json"],
  "ai-init-workflow-policy-writer": [".vibeflow/WORKFLOW_POLICY.md"],
  "ai-init-workflow-state-writer": [".vibeflow/WORKFLOW_STATE.json"],
  "ai-init-quickstart-writer": ["QUICKSTART.md"],
};

export const ENGINE_INSTRUCTION_SCOPE: Record<Engine, string[]> = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  copilot: ["AGENTS.md", ".github/copilot-instructions.md"],
};

export const ENGINE_SKILL_DIR: Record<Engine, string> = {
  claude: ".claude/skills/",
  codex: ".agents/skills/",
  copilot: ".github/skills/",
};

const INIT_DEFAULT_ENGINE: Engine = "copilot";

function selectedInstructionScope(intake: AiInitIntake): string[] {
  const selected = (intake.engines ?? []).filter((engine): engine is Engine =>
    (ENGINES as readonly string[]).includes(engine),
  );
  if (selected.length === 0) return ENGINE_INSTRUCTION_SCOPE[INIT_DEFAULT_ENGINE];
  return [...new Set(selected.flatMap((engine) => ENGINE_INSTRUCTION_SCOPE[engine]))];
}

function instructionDescription(scope: string[]): string {
  const files = scope.join(", ");
  return `Update only these instruction file(s): ${files}. Do not create or modify instruction files for engines outside this scope. Edit only inside the vibeflow:start/vibeflow:end markers; preserve all human content outside markers. Include the discovered build/test/lint commands, code conventions (from real code, not guesses), architecture (key modules + data flow), tech stack with versions, and gotchas. Be concise — AI agents read these files.`;
}

function instructionAcceptance(scope: string[]): string {
  return `instruction file scope (${scope.join(", ")}) carries a fresh vibeflow:start block`;
}

function selectedEngines(intake: AiInitIntake): Engine[] {
  const selected = (intake.engines ?? []).filter((engine): engine is Engine =>
    (ENGINES as readonly string[]).includes(engine),
  );
  return selected.length ? selected : [INIT_DEFAULT_ENGINE];
}

function skillCuratorDescription(intake: AiInitIntake): string {
  const engines = selectedEngines(intake);
  const skillDirs = engines.map((engine) => ENGINE_SKILL_DIR[engine]);
  const syncCmd =
    engines.length === 1
      ? `vf skills sync --mode pointer --engine ${engines[0]}`
      : "vf skills sync --mode pointer";
  const verifyCmd =
    engines.length === 1 ? `vf skills verify-sync --engine ${engines[0]}` : "vf skills verify-sync";
  const authInstruction =
    intake.ctx7Authenticated === true
      ? "ctx7 is already authenticated from the CLI pre-check. Use `npx ctx7 library`, `npx ctx7 docs`, and headless `npx ctx7 skills install --yes --all --claude` when useful."
      : "ctx7 is NOT authenticated or the user chose not to login. Do not run `npx ctx7 login` inside the engine. Use fallback discovery from `.vibeflow/ai-context/stack-evidence.md`, bundled skill standards, and any available docs; author fallback skills with `status: experimental` and cite the fallback source.";

  return [
    authInstruction,
    "Discover and install skills for the detected stack. Project-fit skills live under `.vibeflow/skills/<name>/SKILL.md` and must follow `.vibeflow/ai-context/ANTHROPIC_SKILL_STANDARD.md`.",
    `After validating canonical skills, run \`${syncCmd}\` and \`${verifyCmd}\`.`,
    `Only these selected engine skill mirror(s) are in scope: ${skillDirs.join(", ")}. Do not create or sync skill directories for unselected engines.`,
    "Verify with `vf skills validate` and regenerate `.vibeflow/SKILL_INDEX.md`.",
  ].join(" ");
}

/** Per-adapter acceptance signal the reviewer uses to decide pass/fail.
 *  The strings are evidence patterns: the unit's recorded evidence must
 *  cite at least one of these (file path) for the reviewer to pass it. */
const ADAPTER_ACCEPTANCE: Record<AiInitAdapterName, string> = {
  "ai-init-analyzer":
    "stack-evidence.md written, ProjectProfile summary backed by >=3 manifest/dependency citations",
  "ai-init-instruction-writer":
    "all 3 instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md) carry a fresh vibeflow:start block",
  "ai-init-skill-curator":
    ">=1 skill installed under .vibeflow/skills/, SKILL_INDEX.md regenerated, ctx7 (or fallback) cited as source",
  "ai-init-context-updater":
    ".vibeflow/PROJECT_CONTEXT.md updated with detected stack + architecture insights, human-curated sections preserved",
  "ai-init-tool-configurator":
    ".vibeflow/SETTINGS.json updated with the requested codegraph/lsp toggles (only flips tools the user explicitly asked for)",
  "ai-init-workflow-policy-writer":
    ".vibeflow/WORKFLOW_POLICY.md updated with the active workflow, agent-team roster, and the code-navigation decision tree (only when tools are enabled)",
  "ai-init-workflow-state-writer":
    ".vibeflow/WORKFLOW_STATE.json carries a `work_units` block with one unit per declared WorkflowPhase (name, status=pending, confidence=0, scope, owner_agent, skills_injected, skills_required, gates, resources), and `success_criteria` folds in each phase's `dod`",
  "ai-init-quickstart-writer":
    "QUICKSTART.md rendered from src/templates/QUICKSTART.skeleton.md with placeholders filled from stack-evidence.md, all human-curated sections outside the BEGIN/END markers preserved",
};

/** Per-adapter description (the spec the engine receives when dispatched). */
const ADAPTER_DESCRIPTION: Record<AiInitAdapterName, string> = {
  "ai-init-analyzer":
    "Investigate the project until confidence = 1.0 on every finding (build/test/lint commands, package manager, language + framework versions, CI). Read package.json, tsconfig/biome config, source tree, sample source files (>=5 across modules), and >=2 test files. Review and update .vibeflow/ai-context/stack-evidence.md with file/manifest evidence per component. Do not guess.",
  "ai-init-instruction-writer":
    "Update all 3 instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md) for this project. Edit only inside the vibeflow:start/vibeflow:end markers; preserve all human content outside markers. Include the discovered build/test/lint commands, code conventions (from real code, not guesses), architecture (key modules + data flow), tech stack with versions, and gotchas. Be concise — AI agents read these files.",
  "ai-init-skill-curator":
    "Discover and install skills for the detected stack via `npx ctx7 skills install --yes --all --claude` (headless), or fall back to manual SKILL.md authored from `ctx7 docs`. Follow the SKILL.md format from .vibeflow/ai-context/ANTHROPIC_SKILL_STANDARD.md. Copy to .claude/skills/, .agents/skills/, .github/skills/. Verify with `vf skills validate` and regenerate .vibeflow/SKILL_INDEX.md. Project-fit skills live under .vibeflow/skills/.",
  "ai-init-context-updater":
    "Update .vibeflow/PROJECT_CONTEXT.md with the detected stack (evidence-backed), architecture insights, code conventions, and the active workflow. Preserve any human-authored sections outside the generated block. This is the canonical source of truth for all subsequent `vf init` regenerations.",
  "ai-init-tool-configurator":
    "Edit .vibeflow/SETTINGS.json to enable only the code-navigation tools the user explicitly asked for in intake.toolToggles (codegraph and/or lsp). NEVER flip a tool the user did not request — settings are user opt-in. Preserve every other key in the file. Validate the resulting JSON before closing.",
  "ai-init-workflow-policy-writer":
    "Update .vibeflow/WORKFLOW_POLICY.md with: the active workflow, the agent-team roster (per detected role), the code-navigation decision tree (only when codegraph or lsp is enabled in SETTINGS.json), and the Skills-first + Knowledge-first operating loop. Preserve any human-authored sections outside the generated block.",
  "ai-init-workflow-state-writer":
    "Update .vibeflow/WORKFLOW_STATE.json to declare one work unit per user-supplied WorkflowPhase (or omit `work_units` when the user supplied no phases). Each phase unit has: name (matching the phase), status=pending, confidence=0, scope (one entry per declared output), owner_agent (resolved from phase.ownerHint via fuzzy match against detected roles, defaulting to dispatch-runner), skills_injected + skills_required (resolved from the role's known skill list), gates=pending, resources=zero. Fold each phase.dod into `success_criteria` (dedup, preserve order).",
  "ai-init-quickstart-writer":
    "Render QUICKSTART.md at the project root from the engine-agnostic skeleton at src/templates/QUICKSTART.skeleton.md (relative to the vibeflow repo, or the installed package's templates dir). Steps: (1) read the skeleton; (2) fill every `{{PLACEHOLDER}}` using evidence from .vibeflow/ai-context/stack-evidence.md and the live project (build/test/lint commands, package manager, key file paths, detected stack); (3) preserve any existing QUICKSTART.md content outside the `<!-- BEGIN/END -->` machine-managed regions verbatim; (4) write the rendered file. Do NOT hardcode engine-specific or stack-specific content into the skeleton — placeholders are filled at render time. Verify the result has no unfilled `{{...}}` tokens before closing.",
};

/** Skills wiring per role. A small built-in catalogue that the planner
 *  injects into the relevant adapter / phase units as
 *  `skills_injected` (already loaded in the engine) and `skills_required`
 *  (must be present in the engine's skill store for the unit to count as
 *  done). The reviewer uses the same catalogue to validate that the
 *  evidence cites at least one of the required skills. */
const ROLE_SKILLS: Record<RoleName, { injected: string[]; required: string[] }> = {
  "cli-engine": {
    injected: ["vf-skills", "vf-doctor"],
    required: ["ctx7:bash", "ctx7:find-skills"],
  },
  "web-ui": {
    injected: ["vf-skills", "imagegen-frontend-web"],
    required: ["ctx7:react", "ctx7:svelte"],
  },
  "skill-author": {
    injected: ["vf-skills", "skill-creator"],
    required: ["ctx7:skill-authoring"],
  },
  "preflight-engine": {
    injected: ["vf-skills", "vf-doctor"],
    required: ["ctx7:engine-probe"],
  },
  "dispatch-runner": {
    injected: ["vf-skills", "vf-orchestrate"],
    required: ["ctx7:work-unit", "ctx7:goal-eval"],
  },
  "doc-writer": {
    injected: ["vf-skills", "doc-coauthoring"],
    required: ["ctx7:markdown-lint"],
  },
};

/** Resolve the owner_agent for a phase based on the phase's
 *  `ownerHint`. Exact role-name match wins; otherwise the planner
 *  fuzzy-matches the hint (lowercased) against role-name substrings.
 *  Default is `dispatch-runner` (the role that owns cross-cutting
 *  orchestration work). */
function resolveOwner(hint: string | undefined, detected: RoleName[]): RoleName {
  if (!hint) return "dispatch-runner";
  const lower = hint.toLowerCase().trim();
  for (const role of detected) {
    if (role === lower) return role;
  }
  for (const role of detected) {
    if (role.includes(lower) || lower.includes(role)) return role;
  }
  if (/(cli|command|flag|subcommand)/.test(lower)) return "cli-engine";
  if (/(ui|web|frontend|view|panel)/.test(lower)) return "web-ui";
  if (/(skill|capability)/.test(lower)) return "skill-author";
  if (/(preflight|readiness|probe|quota)/.test(lower)) return "preflight-engine";
  if (/(dispatch|orchestrat|runner|workflow)/.test(lower)) return "dispatch-runner";
  if (/(doc|readme|changelog|comment)/.test(lower)) return "doc-writer";
  return "dispatch-runner";
}

/** Slug a phase name to a path-safe unit suffix. Strips path-traversal
 *  sequences so a crafted phase name can never escape the canonical
 *  `ai-init-phase-` prefix. */
function phaseSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/** Skill wiring for each Tier-1 adapter (looked up via the role it
 *  maps to in ADAPTER_OWNER). Adapters that share a role share the
 *  same catalogue. */
function adapterSkills(name: AiInitAdapterName): { injected: string[]; required: string[] } {
  return ROLE_SKILLS[ADAPTER_OWNER[name]];
}

/** Build the spec text for one Tier-1 adapter unit, given the live
 *  project context. The spec is what the engine receives as `unit.spec`
 *  in the dispatch prompt. */
function buildAdapterSpec(
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
        ? skillCuratorDescription(intake)
        : ADAPTER_DESCRIPTION[name],
  ].join("\n");
}

/** Build one Tier-2 work unit per WorkflowPhase in the intake. Each
 *  phase becomes a unit the orchestrator can dispatch in parallel
 *  alongside the Tier-1 adapter units. The unit's owner_agent,
 *  skills_injected, and skills_required are derived from the resolved
 *  role so the reviewer gates on the right evidence. */
function buildPhaseUnits(intake: AiInitIntake, detectedRoles: RoleName[]): AiInitUnit[] {
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
    return {
      name: unitName,
      status: "pending",
      confidence: 0,
      owner_agent: owner,
      spec,
      scope: finalScope,
      acceptance,
      skills_injected: [...roleSkills.injected],
      skills_required: [...roleSkills.required],
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  });
}

/**
 * Decompose the AI-init phase into 2 tiers of work units.
 *
 * Pure: no I/O. The orchestrator can feed the result straight into
 * `planWorkUnits` + `scheduleWaves` (no conflicts; all units land in
 * wave 0).
 *
 * @param profile       scanner profile (always available — applyIntake
 *                      calls scanRepo before phase 2)
 * @param intake        trimmed intake answers (all fields optional)
 * @param detectedRoles roles detectRolesForRepo returned for this repo.
 *                      Used to (a) interpolate into adapter specs and
 *                      (b) resolve phase.ownerHint into owner_agent.
 */
export function planAiInitUnits(
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[] = [...ROLE_NAMES],
): AiInitUnit[] {
  const adapterUnits: AiInitUnit[] = AI_INIT_ADAPTER_NAMES.map((name): AiInitUnit => {
    const spec = buildAdapterSpec(name, profile, intake, detectedRoles);
    const skills = adapterSkills(name);
    const scope =
      name === "ai-init-instruction-writer"
        ? selectedInstructionScope(intake)
        : ADAPTER_SCOPE[name];
    return {
      name,
      status: "pending",
      confidence: 0,
      owner_agent: ADAPTER_OWNER[name],
      spec,
      scope,
      acceptance:
        name === "ai-init-instruction-writer"
          ? instructionAcceptance(scope)
          : ADAPTER_ACCEPTANCE[name],
      skills_injected: [...skills.injected],
      skills_required: [...skills.required],
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  });
  const phaseUnits = buildPhaseUnits(intake, detectedRoles);
  return [...adapterUnits, ...phaseUnits];
}

/**
 * Reviewer used by the orchestrator: a unit passes when its recorded
 * evidence cites at least one path matching its acceptance pattern. This
 * is intentionally simple — a richer review (e.g. diff-based) is out of
 * scope and would require a second engine pass. The point is to gate
 * `status = done` on real on-disk evidence, not on the engine's word.
 */
export function aiInitReviewer(
  unit: WorkUnit,
  outcome: { status: WorkUnit["status"]; confidence: number; evidence: string[] },
  // MINOR-4: pass the project base so the reviewer can resolve cited
  // paths against it. Defaults to process.cwd() for back-compat with
  // existing tests (which chdir into a tmpdir before each case).
  base: string = process.cwd(),
): { pass: boolean; reason: string } {
  if (outcome.status === "blocked") {
    // Production dispatchers return "verifying" (per src/orchestrator/run.ts:96-99);
    // the reviewer is the gate, not the dispatcher. Only "blocked" is fatal.
    return { pass: false, reason: "dispatcher reported status=blocked" };
  }
  if (outcome.confidence < 1) {
    return { pass: false, reason: `confidence=${outcome.confidence} < 1.0` };
  }
  if (!outcome.evidence?.length) {
    return { pass: false, reason: "no evidence recorded" };
  }
  const name = unit.name as string;
  // Helper: for an evidence line, extract a path-like token that contains p.
  // - "edited CLAUDE.md" → "CLAUDE.md" (idx 7, word start at 0, end at 16)
  // - "updated .vibeflow/SETTINGS.json tools.codegraph" → ".vibeflow/SETTINGS.json"
  // - "CLAUDE.md content" → "CLAUDE.md" (idx 0, wordStart -1)
  const citeExists = (e: string, required: string[]): string | null => {
    for (const p of required) {
      const idx = e.indexOf(p);
      if (idx === -1) continue;
      const after = e.slice(idx);
      const wordEndRel = after.search(/\s/);
      const end = wordEndRel === -1 ? e.length : idx + wordEndRel;
      const before = e.slice(0, idx);
      const wordStart = before.search(/\S+$/);
      const start = wordStart === -1 || e.slice(wordStart, idx).trim() === "" ? wordStart : idx;
      const candidate = start === -1 ? e.slice(idx, end) : e.slice(start, end);
      if (candidate.length > 0) return candidate;
    }
    return null;
  };
  const pathIsFile = (p: string): boolean => {
    // Returns true only for existing regular files. Rejects directories,
    // symlinks-to-dirs, and missing paths. Catches the bug where a unit
    // could claim "I wrote `.vibeflow/skills/`" (a dir) and pass review
    // (MINOR-2 fix). Cited paths may be relative; resolve them against
    // the project base (MINOR-4 fix).
    try {
      return statSync(resolve(base, p)).isFile();
    } catch {
      return false;
    }
  };
  const pathIsDir = (p: string): boolean => {
    try {
      return statSync(resolve(base, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const checkFileExists = (
    e: string,
    required: string[],
  ): { ok: true } | { ok: false; reason: string } => {
    // File-scope entries (don't end with "/"): cited path must exist on disk.
    // Dir-scope entries (end with "/"): the path that starts at the dir prefix
    // and continues to the next whitespace must exist on disk.
    // Both are checked independently. The substring pre-filter upstream
    // guarantees at least one match in REQUIRED; if it was a file path, it
    // must exist; if a dir-scope path, the cited file inside the dir must exist.
    const dirEntries = required.filter((p) => p.endsWith("/"));
    const fileEntries = required.filter((p) => !p.endsWith("/"));
    if (fileEntries.length > 0) {
      const cited = citeExists(e, fileEntries);
      if (cited && !pathIsFile(cited)) {
        return {
          ok: false,
          reason: `path is not a regular file (missing or a directory): ${cited} (claimed by evidence "${e}")`,
        };
      }
    }
    if (dirEntries.length > 0) {
      for (const p of dirEntries) {
        const idx = e.indexOf(p);
        if (idx === -1) continue;
        const before = e.slice(0, idx);
        const wordStart = before.search(/\S+$/);
        const start = wordStart === -1 || e.slice(wordStart, idx).trim() === "" ? wordStart : idx;
        const after = e.slice(idx);
        const wordEndRel = after.search(/\s/);
        const end = wordEndRel === -1 ? e.length : idx + wordEndRel;
        const candidate = start === -1 ? e.slice(idx, end) : e.slice(start, end);
        if (pathIsFile(candidate) || pathIsDir(candidate)) return { ok: true };
        return {
          ok: false,
          reason: `path is not a regular file (missing or a directory): ${candidate} (claimed by evidence "${e}")`,
        };
      }
    }
    return { ok: true };
  };
  if (name === "ai-init-instruction-writer") {
    const REQUIRED = unit.scope?.length
      ? unit.scope
      : (ADAPTER_SCOPE["ai-init-instruction-writer"] ?? []);
    const hit = outcome.evidence.some((e) => REQUIRED.some((p) => e.includes(p)));
    if (!hit) {
      return {
        pass: false,
        reason: `no evidence cites one of: ${REQUIRED.join(", ")}`,
      };
    }
    // T3: file-exists check on the cited path.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-skill-curator") {
    const hit = outcome.evidence.some(
      (e) => e.includes(".vibeflow/skills/") || e.includes("SKILL_INDEX"),
    );
    if (!hit) {
      return { pass: false, reason: "no evidence cites a skill file or SKILL_INDEX update" };
    }
    // T3: file-exists check.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-skill-curator"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-tool-configurator") {
    const hit = outcome.evidence.some((e) => e.includes("SETTINGS.json") || e.includes("settings"));
    if (!hit) {
      return {
        pass: false,
        reason: "no evidence cites SETTINGS.json — the tool-configurator must update it",
      };
    }
    // T3: file-exists check on .vibeflow/SETTINGS.json.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-tool-configurator"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-workflow-policy-writer") {
    const hit = outcome.evidence.some(
      (e) => e.includes("WORKFLOW_POLICY") || e.includes("workflow-policy"),
    );
    if (!hit) {
      return {
        pass: false,
        reason: "no evidence cites WORKFLOW_POLICY.md — the workflow-policy-writer must update it",
      };
    }
    // T3: file-exists check.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-workflow-policy-writer"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-workflow-state-writer") {
    const hit = outcome.evidence.some(
      (e) => e.includes("WORKFLOW_STATE") || e.includes("workflow-state"),
    );
    if (!hit) {
      return {
        pass: false,
        reason: "no evidence cites WORKFLOW_STATE.json — the workflow-state-writer must update it",
      };
    }
    // T3: file-exists check.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-workflow-state-writer"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-analyzer") {
    // T3: file-exists check on the single scope file.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-analyzer"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-quickstart-writer") {
    const REQUIRED = unit.scope?.length
      ? unit.scope
      : (ADAPTER_SCOPE["ai-init-quickstart-writer"] ?? []);
    const hit = outcome.evidence.some((e) => REQUIRED.some((p) => e.includes(p)));
    if (!hit) {
      return {
        pass: false,
        reason: `no evidence cites one of: ${REQUIRED.join(", ")}`,
      };
    }
    // T3: file-exists check on the cited path.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name.startsWith("ai-init-phase-")) {
    const REQUIRED = unit.scope ?? [];
    const hit = outcome.evidence.some((e) =>
      REQUIRED.some((p) => e.includes(p) || p.endsWith(e) || e.endsWith(p)),
    );
    if (!hit) {
      return {
        pass: false,
        reason: `no phase evidence cites one of the declared outputs: ${REQUIRED.join(", ")}`,
      };
    }
    // MINOR-3: phase units now also pass through the file-exists check
    // (consistency with adapter units). Previously a phase could claim
    // to write `.vibeflow/phase-outputs/foo.md` and pass review even
    // when the file wasn't on disk.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  return { pass: true, reason: "evidence + confidence 1.0" };
}

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ENGINES, type Engine } from "../core.js";
import { type EnvPolicy, conversationEnvPolicy } from "../dispatch/env-filter.js";
import { type ValidatedIsolationLease, validateIsolationLease } from "../dispatch/isolation.js";
import type {
  IsolationLeaseProjection,
  SessionMode,
  SessionProvenance,
  SessionTraceMetadata,
  SpawnOptionsProjection,
} from "../dispatch/session-types.js";
import { createSpawnOptionsProjection } from "../dispatch/session-types.js";
import { type PreflightOpts, preflightAll } from "../preflight.js";
import {
  type ResolvedSkill,
  materializeDiscoveredDispatchSkills,
} from "../skills/dispatch-resolution.js";
import { renderRoleForSpawn } from "./render.js";
import { resolveRoleOverlay } from "./role-overlay.js";
import { type ResolvedRole, type RoleSandbox, type ToolIntent, isReadOnlyRole } from "./role.js";

export interface AgentBinding {
  roleRef: string;
  engine: Engine;
  modelOverride?: string;
  sessionMode: SessionMode;
  additionalSkillRefs?: string[];
}

export interface ResolvedAgentBinding {
  role: ResolvedRole;
  skills: ResolvedSkill[];
  engine: Engine;
  model: string | null;
  sessionMode: SessionMode;
  tool_intents: ToolIntent[];
  sandbox: RoleSandbox | null;
  env_policy: EnvPolicy;
  isolation: IsolationLeaseProjection | null;
  provenance: SessionProvenance;
  trace_metadata: SessionTraceMetadata;
}

export interface MaterializeAgentBindingOptions {
  repoRoot: string;
  phase: number;
  taskText: string;
  isolation?: IsolationLeaseProjection;
}

export interface MaterializedAgentBinding {
  resolved: ResolvedAgentBinding;
  spawn: SpawnOptionsProjection;
}

const SESSION_MODES = new Set<SessionMode>(["exact", "replay", "fresh"]);

function assertBindingInput(binding: AgentBinding): void {
  if (!ENGINES.includes(binding.engine)) throw new Error("unsupported conversation engine");
  if (!SESSION_MODES.has(binding.sessionMode)) throw new Error("invalid conversation session mode");
}

function renderPrompt(
  role: ResolvedRole,
  skills: ReturnType<typeof materializeDiscoveredDispatchSkills>["skills"],
  taskText: string,
): string {
  const sections = [role.spec.body.trimEnd()];
  if (skills.length > 0) {
    sections.push(
      [
        "## Resolved Skills",
        ...skills.flatMap((skill) => ["", `### ${skill.ref}`, "", skill.resolved_body.trimEnd()]),
      ].join("\n"),
    );
  }
  sections.push(["## Assigned Topic", "", taskText].join("\n"));
  return `${sections.join("\n\n")}\n`;
}

function assertModelOverride(modelOverride?: string): void {
  if (modelOverride === undefined) return;
  if (!modelOverride.trim() || modelOverride.length > 200) {
    throw new Error("model override must be a non-empty identifier of at most 200 characters");
  }
  for (const character of modelOverride) {
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
      throw new Error("model override contains a control character");
    }
  }
}

function assertAdmission(
  binding: AgentBinding,
  resolvedRole: ResolvedRole,
  resolvedSkills: readonly ResolvedSkill[],
  options: MaterializeAgentBindingOptions,
  canonicalRepoRoot: string,
  validatedIsolation?: ValidatedIsolationLease,
): void {
  if (!Number.isInteger(options.phase) || options.phase < 1) {
    throw new Error("conversation phase must be a positive integer");
  }
  if (options.phase === 1) {
    if (binding.engine !== "claude" && binding.engine !== "codex") {
      throw new Error("Phase 1 admits only built-in read-only Claude/Codex bindings");
    }
    if (
      resolvedRole.source !== "builtin" ||
      resolvedSkills.some((skill) => skill.source !== "builtin")
    ) {
      throw new Error("Phase 1 admits only built-in read-only bindings");
    }
    if (!isReadOnlyRole(resolvedRole.spec)) {
      throw new Error("Phase 1 role must be read-only");
    }
    return;
  }

  const projectMaterial =
    resolvedRole.source === "repo" || resolvedSkills.some((skill) => skill.source === "repo");
  if (validatedIsolation && validatedIsolation.repoRoot !== canonicalRepoRoot) {
    throw new Error("isolation lacks the associated canonical repository");
  }
  if (projectMaterial && !validatedIsolation) {
    throw new Error("project overlay requires a live canonical isolation lease");
  }
}

function assertEngineReady(engine: Engine, repoRoot: string): void {
  const probeOptions: PreflightOpts = { probe: true, skipCache: true, cacheKey: repoRoot };
  const readiness = preflightAll([engine], probeOptions);
  const exact = readiness.length === 1 ? readiness[0] : undefined;
  if (!exact || exact.engine !== engine || exact.level !== "ready") {
    throw new Error(`conversation binding requires a verified engine: ${engine}`);
  }
}

function validateLease(isolation: IsolationLeaseProjection): ValidatedIsolationLease {
  try {
    return validateIsolationLease(isolation);
  } catch {
    throw new Error("conversation binding requires a live canonical isolation lease");
  }
}

/** Resolve all role/skill authority before a conversation attempt can be spawned. */
export function materializeAgentBinding(
  binding: AgentBinding,
  options: MaterializeAgentBindingOptions,
): MaterializedAgentBinding {
  assertBindingInput(binding);
  assertModelOverride(binding.modelOverride);
  const canonicalRepoRoot = realpathSync(resolve(options.repoRoot));
  assertEngineReady(binding.engine, canonicalRepoRoot);
  const validatedIsolation = options.isolation ? validateLease(options.isolation) : undefined;
  const role = resolveRoleOverlay(binding.roleRef, { repoRoot: canonicalRepoRoot });
  const skillResolution = materializeDiscoveredDispatchSkills(options.taskText, {
    repoRoot: canonicalRepoRoot,
    additionalSkillRefs: binding.additionalSkillRefs,
  });
  assertAdmission(
    binding,
    role,
    skillResolution.skills,
    options,
    canonicalRepoRoot,
    validatedIsolation,
  );

  const prompt = renderPrompt(role, skillResolution.skills, options.taskText);
  const rendered = renderRoleForSpawn(binding.engine, role.spec, {
    modelOverride: binding.modelOverride,
    prompt,
  });
  const sandbox = role.spec.sandbox ?? null;
  if (rendered.sandbox !== sandbox) {
    throw new Error(`${binding.engine} cannot enforce the resolved role sandbox`);
  }

  const skillHashes = skillResolution.skills.map((skill) => skill.resolved_hash);
  const provenance: SessionProvenance = {
    roleSource: role.source,
    roleHash: role.resolved_hash,
    skillHashes,
  };
  const traceMetadata: SessionTraceMetadata = {
    role_resolved_hash: role.resolved_hash,
    skill_resolved_hashes: skillHashes,
  };
  const envPolicy = conversationEnvPolicy(binding.engine);
  const isolation = options.isolation ?? null;
  const resolved: ResolvedAgentBinding = {
    role,
    skills: skillResolution.skills,
    engine: binding.engine,
    model: rendered.model,
    sessionMode: binding.sessionMode,
    tool_intents: [...role.spec.tools],
    sandbox,
    env_policy: envPolicy,
    isolation,
    provenance,
    trace_metadata: traceMetadata,
  };
  const spawn = createSpawnOptionsProjection({
    engine: binding.engine,
    model: rendered.model,
    sessionMode: binding.sessionMode,
    rendered_prompt: rendered.rendered_prompt,
    rendered_tools: rendered.rendered_tools,
    sandbox: rendered.sandbox,
    env_policy: envPolicy,
    isolation,
    provenance,
    trace_metadata: traceMetadata,
  });
  return { resolved, spawn };
}

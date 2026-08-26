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
  SpawnOptionsInput,
  SpawnOptionsProjection,
} from "../dispatch/session-types.js";
import { createSpawnOptionsProjection } from "../dispatch/session-types.js";
import { preflightAll, preflightAllAsync } from "../preflight.js";
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

export interface PreviewAgentBinding {
  readonly resolved: ResolvedAgentBinding;
  readonly engineAvailable: boolean;
  readonly modelValid: boolean;
}
const canonicalPreviewBindings = new WeakSet<object>();
export const isCanonicalPreviewAgentBinding = (value: PreviewAgentBinding): boolean =>
  canonicalPreviewBindings.has(value);

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

function engineAvailable(engine: Engine, repoRoot: string): boolean {
  const readiness = preflightAll([engine], { probe: false, cacheKey: repoRoot });
  const exact = readiness.length === 1 ? readiness[0] : undefined;
  return exact?.engine === engine && exact.level === "ready";
}

async function engineReady(engine: Engine, repoRoot: string): Promise<boolean> {
  const readiness = await preflightAllAsync([engine], {
    probe: true,
    skipCache: true,
    cacheKey: repoRoot,
  });
  const exact = readiness.length === 1 ? readiness[0] : undefined;
  return exact?.engine === engine && exact.level === "ready";
}

function validateLease(isolation: IsolationLeaseProjection): ValidatedIsolationLease {
  try {
    return validateIsolationLease(isolation);
  } catch {
    throw new Error("conversation binding requires a live canonical isolation lease");
  }
}

function resolveBindingAuthority(
  binding: AgentBinding,
  options: MaterializeAgentBindingOptions,
  purpose: "conversation" | "preview" | "workflow" = "conversation",
): { resolved: ResolvedAgentBinding; spawnInput: SpawnOptionsInput } {
  assertBindingInput(binding);
  assertModelOverride(binding.modelOverride);
  const canonicalRepoRoot = realpathSync(resolve(options.repoRoot));
  const validatedIsolation = options.isolation ? validateLease(options.isolation) : undefined;
  const role = resolveRoleOverlay(binding.roleRef, { repoRoot: canonicalRepoRoot });
  const exactWorkflowSelection =
    purpose === "workflow" && binding.additionalSkillRefs !== undefined;
  const skillResolution = materializeDiscoveredDispatchSkills(
    exactWorkflowSelection ? "" : options.taskText,
    {
      repoRoot: canonicalRepoRoot,
      additionalSkillRefs: binding.additionalSkillRefs,
    },
  );
  const skills = exactWorkflowSelection
    ? (binding.additionalSkillRefs?.map((ref) => {
        const name = ref.split("@")[0]?.toLowerCase();
        const resolved = skillResolution.skills.find((skill) => skill.ref.toLowerCase() === name);
        if (!resolved) throw new Error(`workflow skill selection was not materialized: ${ref}`);
        return resolved;
      }) ?? [])
    : skillResolution.skills;
  if (purpose === "workflow") {
    if (!Number.isInteger(options.phase) || options.phase < 1) {
      throw new Error("workflow phase must be a positive integer");
    }
    if (validatedIsolation && validatedIsolation.repoRoot !== canonicalRepoRoot) {
      throw new Error("isolation lacks the associated canonical repository");
    }
  } else {
    assertAdmission(binding, role, skills, options, canonicalRepoRoot, validatedIsolation);
  }

  const prompt =
    purpose === "workflow" ? options.taskText : renderPrompt(role, skills, options.taskText);
  const rendered = renderRoleForSpawn(binding.engine, role.spec, {
    modelOverride: binding.modelOverride,
    prompt,
  });
  const sandbox = purpose === "workflow" ? rendered.sandbox : (role.spec.sandbox ?? null);
  if (purpose === "conversation" && rendered.sandbox !== sandbox) {
    throw new Error(`${binding.engine} cannot enforce the resolved role sandbox`);
  }

  const skillHashes = skills.map((skill) => skill.resolved_hash);
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
    skills,
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
  return {
    resolved,
    spawnInput: {
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
    },
  };
}

const modelCredential =
  /(?:^|[._/@:+-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,})(?=$|[._/@:+-])|(?:^|[._/@:+-])(?:token|secret|password|credential|api[_-]?key|access[_-]?key)(?:$|[._/@:+-])/i;
const localModelPath =
  /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|(?:src|test|tests|docs|lib|dist|build|private|artifacts?|evidence|coverage|scripts?|config)[\\/])/i;
const modelValidForPreview = (model: string | null): boolean =>
  model === null ||
  (Buffer.byteLength(model, "utf8") <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(model) &&
    !model.includes("..") &&
    !model.includes("//") &&
    !localModelPath.test(model) &&
    !modelCredential.test(model));

/** Resolve read-only authority and readiness without returning executable spawn authority. */
export function previewAgentBinding(
  binding: AgentBinding,
  options: MaterializeAgentBindingOptions,
): PreviewAgentBinding {
  const authority = resolveBindingAuthority(binding, options, "preview");
  const preview = Object.freeze({
    resolved: authority.resolved,
    engineAvailable: engineAvailable(binding.engine, realpathSync(resolve(options.repoRoot))),
    modelValid: modelValidForPreview(authority.resolved.model),
  });
  canonicalPreviewBindings.add(preview);
  return preview;
}

/** Resolve all role/skill authority before a conversation attempt can be spawned. */
export async function materializeAgentBinding(
  binding: AgentBinding,
  options: MaterializeAgentBindingOptions,
): Promise<MaterializedAgentBinding> {
  const canonicalRepoRoot = realpathSync(resolve(options.repoRoot));
  if (!(await engineReady(binding.engine, canonicalRepoRoot))) {
    throw new Error(`conversation binding requires a verified engine: ${binding.engine}`);
  }
  const authority = resolveBindingAuthority(binding, options);
  return {
    resolved: authority.resolved,
    spawn: createSpawnOptionsProjection(authority.spawnInput),
  };
}

/**
 * Materialize a workflow dispatch after the orchestrator's trusted engine gate has admitted it.
 * Workflow prompts are already complete executable documents, so this path binds provenance
 * without wrapping or re-selecting their skills. Conversation admission remains on
 * {@link materializeAgentBinding} and cannot opt into these compatibility rules.
 */
export function materializeWorkflowAgentBinding(
  binding: AgentBinding,
  options: MaterializeAgentBindingOptions,
): MaterializedAgentBinding {
  const authority = resolveBindingAuthority(binding, options, "workflow");
  return {
    resolved: authority.resolved,
    spawn: createSpawnOptionsProjection(authority.spawnInput),
  };
}

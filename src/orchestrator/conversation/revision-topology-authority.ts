import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { BrowserHostActionRequestV1 } from "../../actions/index.js";
import type { MaterializedAgentBinding } from "../../agents/binding.js";
import { isReadOnlyRole } from "../../agents/role.js";
import { AGENT_ROLE_SOURCE } from "../../core/agent-contract.js";
import { ROLE_SANDBOX, isMutatingRoleToolIntent } from "../../core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../core/role-name-contract.js";
import {
  ENGINE_SESSION_MODE,
  supportsAuthenticatedCoordinationOutput,
  supportsConversationRoleAuthority,
} from "../../dispatch/session-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { materializeConversationHostTools } from "./conversation-host-tool-policy.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";
import { ConversationRevisionCandidateInvalidError } from "./revision-errors.js";
import type { ConversationBinding, ConversationManifest } from "./types.js";

export type ConversationRevisionTopologyMutationV1 = Extract<
  BrowserHostActionRequestV1,
  {
    type:
      | typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT
      | typeof HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT
      | typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT
      | typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS
      | typeof HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE;
  }
>;

export interface ConversationTopologyBindingAuthorityV1 {
  participant_id: string;
  role_ref: string;
  engine: ConversationBinding["input"]["engine"];
  model_override: string | null;
  session_mode: ConversationBinding["input"]["sessionMode"];
  skill_refs: string[];
  host_tools: NonNullable<ConversationBinding["host_tools"]>;
}

export interface ConversationRevisionTopologyAuthorityV1 {
  schema_version: "1.0";
  policy: string;
  bindings: ConversationTopologyBindingAuthorityV1[];
  topology_digest: string;
}

export interface ConversationRevisionTopologyProjectionV1 {
  target: ConversationManifest;
  before_authority: ConversationRevisionTopologyAuthorityV1;
  authority: ConversationRevisionTopologyAuthorityV1;
}

const invalid = (message: string): never => {
  throw new ConversationRevisionCandidateInvalidError(message);
};

const exactTools = (
  observed: readonly string[] | undefined,
  expected: readonly string[],
): boolean =>
  observed !== undefined &&
  observed.length === expected.length &&
  observed.every((tool, index) => tool === expected[index]);

function fresh(binding: ConversationBinding): ConversationBinding {
  return {
    ...structuredClone(binding),
    input: { ...structuredClone(binding.input), sessionMode: ENGINE_SESSION_MODE.FRESH },
  };
}

function withRole(binding: ConversationBinding, roleRef: string): ConversationBinding {
  const rewritten = fresh(binding);
  rewritten.input.roleRef = roleRef;
  rewritten.host_tools = materializeConversationHostTools({ roleRef });
  return rewritten;
}

function coordinator(binding: ConversationBinding): ConversationBinding {
  const rewritten = withRole(binding, CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR);
  rewritten.host_tools = [];
  return rewritten;
}

function executor(binding: ConversationBinding): ConversationBinding {
  const rewritten = fresh(binding);
  rewritten.host_tools = [];
  return rewritten;
}

function direct(binding: ConversationBinding): ConversationBinding {
  return withRole(binding, CONVERSATION_ROLE_NAME.DIRECT);
}

function participantId(
  parent: ConversationManifest,
  action: Extract<
    ConversationRevisionTopologyMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT }
  >,
  idempotencyKey: string,
): string {
  const digest = digestV1("VF-CONVERSATION-REVISION-PARTICIPANT\0v1\0", {
    schema_version: "1.0",
    conversation_id: parent.conversation_id,
    revision_id: parent.revision_id,
    idempotency_key: idempotencyKey,
    participant: action.participant,
  });
  return `participant-${digestHex(digest).slice(0, 32)}`;
}

function addedBinding(
  parent: ConversationManifest,
  action: Extract<
    ConversationRevisionTopologyMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT }
  >,
  idempotencyKey: string,
): ConversationBinding {
  const participant = action.participant;
  return {
    participant_id: participantId(parent, action, idempotencyKey),
    host_tools: materializeConversationHostTools({ roleRef: participant.role_ref }),
    input: {
      roleRef: participant.role_ref,
      engine: participant.engine,
      sessionMode: ENGINE_SESSION_MODE.FRESH,
      ...(participant.model === null ? {} : { modelOverride: participant.model }),
      additionalSkillRefs: [...participant.skill_refs],
    },
  };
}

function updatedBinding(
  binding: ConversationBinding,
  action: Extract<
    ConversationRevisionTopologyMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT }
  >,
): ConversationBinding {
  if (binding.participant_id !== action.participant_id) return fresh(binding);
  const prior = structuredClone(binding.input);
  const { modelOverride: _modelOverride, ...withoutModel } = prior;
  const input: ConversationBinding["input"] = {
    ...(action.changes.model === null ? withoutModel : prior),
    sessionMode: ENGINE_SESSION_MODE.FRESH,
  };
  if (action.changes.role_ref !== undefined) input.roleRef = action.changes.role_ref;
  if (action.changes.engine !== undefined) input.engine = action.changes.engine;
  if (action.changes.model !== null && action.changes.model !== undefined)
    input.modelOverride = action.changes.model;
  if (action.changes.skill_refs !== undefined)
    input.additionalSkillRefs = [...action.changes.skill_refs];
  return {
    participant_id: binding.participant_id,
    input,
    host_tools: materializeConversationHostTools({
      roleRef: input.roleRef,
      explicit: binding.host_tools ?? [],
    }),
  };
}

function assertStructuralTopology(manifest: ConversationManifest): void {
  if (manifest.policy === CONVERSATION_POLICY.DIRECT) {
    const survivor = manifest.bindings[0];
    if (manifest.bindings.length !== 1 || !survivor) {
      invalid("direct conversation topology is noncanonical");
    }
    return;
  }
  if (manifest.policy === CONVERSATION_POLICY.DEBATE) {
    const evaluatorCount = manifest.bindings.filter(
      (binding) => binding.input.roleRef === CONVERSATION_ROLE_NAME.BRAINSTORM_EVALUATOR,
    ).length;
    if (evaluatorCount !== 1 || manifest.bindings.length - evaluatorCount < 2)
      invalid("debate conversation topology is noncanonical");
    return;
  }
  if (manifest.policy !== CONVERSATION_POLICY.COORDINATE) return;
  const lead = manifest.bindings[0];
  if (!lead || manifest.bindings.length < 2) {
    throw new ConversationRevisionCandidateInvalidError(
      "coordinate conversation topology is noncanonical",
    );
  }
  if (
    lead.input.roleRef !== CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR ||
    !supportsAuthenticatedCoordinationOutput(lead.input.engine) ||
    !exactTools(lead.host_tools, [])
  )
    invalid("coordinate conversation topology is noncanonical");
  for (const executorBinding of manifest.bindings.slice(1)) {
    if (
      !supportsAuthenticatedCoordinationOutput(executorBinding.input.engine) ||
      executorBinding.input.engine === lead.input.engine ||
      !exactTools(executorBinding.host_tools, [])
    )
      invalid("coordinate executor authority is invalid");
  }
}

function assertNormalizedTopology(manifest: ConversationManifest): void {
  assertStructuralTopology(manifest);
  if (manifest.policy !== CONVERSATION_POLICY.DIRECT) return;
  const survivor = manifest.bindings[0];
  if (
    survivor?.input.roleRef !== CONVERSATION_ROLE_NAME.DIRECT ||
    !supportsConversationRoleAuthority(survivor.input.engine) ||
    !exactTools(
      survivor.host_tools,
      materializeConversationHostTools({ roleRef: CONVERSATION_ROLE_NAME.DIRECT }),
    )
  )
    invalid("direct survivor topology is noncanonical");
}

function normalizeCoordinate(
  lead: ConversationBinding,
  executors: readonly ConversationBinding[],
): ConversationBinding[] {
  return [coordinator(lead), ...executors.map(executor)];
}

function mutate(input: {
  parent: ConversationManifest;
  action: ConversationRevisionTopologyMutationV1;
  idempotencyKey: string;
}): ConversationManifest {
  const manifest = structuredClone(input.parent);
  const action = input.action;
  assertStructuralTopology(manifest);
  if (action.type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT) {
    const addition = addedBinding(manifest, action, input.idempotencyKey);
    if (manifest.bindings.some(({ participant_id }) => participant_id === addition.participant_id))
      invalid("derived participant identity already exists");
    if (manifest.policy === CONVERSATION_POLICY.DIRECT) {
      manifest.policy = CONVERSATION_POLICY.COORDINATE;
      manifest.bindings = normalizeCoordinate(manifest.bindings[0] as ConversationBinding, [
        addition,
      ]);
    } else if (manifest.policy === CONVERSATION_POLICY.COORDINATE) {
      manifest.bindings = normalizeCoordinate(manifest.bindings[0] as ConversationBinding, [
        ...manifest.bindings.slice(1),
        addition,
      ]);
    } else manifest.bindings = [...manifest.bindings.map(fresh), addition];
  } else if (action.type === HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT) {
    if (!manifest.bindings.some(({ participant_id }) => participant_id === action.participant_id))
      invalid("revision participant is absent");
    const retained = manifest.bindings.filter(
      ({ participant_id }) => participant_id !== action.participant_id,
    );
    if (!retained.length) invalid("conversation revision requires at least one participant");
    if (retained.length === 1) {
      manifest.policy = CONVERSATION_POLICY.DIRECT;
      manifest.bindings = [direct(retained[0] as ConversationBinding)];
    } else if (manifest.policy === CONVERSATION_POLICY.COORDINATE) {
      manifest.bindings = normalizeCoordinate(
        retained[0] as ConversationBinding,
        retained.slice(1),
      );
    } else manifest.bindings = retained.map(fresh);
  } else if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT) {
    if (!manifest.bindings.some(({ participant_id }) => participant_id === action.participant_id))
      invalid("revision participant is absent");
    manifest.bindings = manifest.bindings.map((binding) => updatedBinding(binding, action));
  } else {
    manifest.bindings = manifest.bindings.map(fresh);
    if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS) {
      if (action.changes.policy !== undefined) manifest.policy = action.changes.policy;
      if (action.changes.max_rounds !== undefined) manifest.max_rounds = action.changes.max_rounds;
      if (action.changes.baseline_enabled !== undefined)
        manifest.baseline_enabled = action.changes.baseline_enabled;
    }
  }
  if (
    action.type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT ||
    action.type === HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT
  )
    assertNormalizedTopology(manifest);
  else assertStructuralTopology(manifest);
  return manifest;
}

/** Manifest-only topology authority; resolved hashes remain owned by canonical rehydration. */
export function materializeConversationTopologyAuthority(
  manifest: ConversationManifest,
): ConversationRevisionTopologyAuthorityV1 {
  const preimage = {
    schema_version: "1.0" as const,
    policy: manifest.policy,
    bindings: manifest.bindings.map((binding) => ({
      participant_id: binding.participant_id,
      role_ref: binding.input.roleRef,
      engine: binding.input.engine,
      model_override: binding.input.modelOverride ?? null,
      session_mode: binding.input.sessionMode,
      skill_refs: [...(binding.input.additionalSkillRefs ?? [])],
      host_tools: [...(binding.host_tools ?? [])],
    })),
  };
  return {
    ...preimage,
    topology_digest: digestV1("VF-CONVERSATION-REVISION-TOPOLOGY\0v1\0", preimage),
  };
}

/** Validates the real overlay/model/sandbox authority after canonical binding materialization. */
export function assertConversationTopologyMaterialization(input: {
  manifest: ConversationManifest;
  bindings: readonly MaterializedAgentBinding[];
}): void {
  assertStructuralTopology(input.manifest);
  if (input.bindings.length !== input.manifest.bindings.length)
    invalid("conversation topology materialization is incomplete");
  input.bindings.forEach((binding, index) => {
    const expected = input.manifest.bindings[index];
    if (
      !expected ||
      binding.resolved.role.spec.name !== expected.input.roleRef ||
      binding.resolved.engine !== expected.input.engine ||
      binding.resolved.sessionMode !== expected.input.sessionMode ||
      !supportsConversationRoleAuthority(binding.resolved.engine)
    )
      invalid("conversation topology materialization changed binding authority");
  });
  if (input.manifest.policy === CONVERSATION_POLICY.DIRECT) {
    const binding = input.bindings[0];
    if (
      !binding ||
      binding.resolved.sandbox !== ROLE_SANDBOX.READ_ONLY ||
      !isReadOnlyRole(binding.resolved.role.spec)
    )
      invalid("direct survivor role authority is invalid");
    return;
  }
  if (input.manifest.policy !== CONVERSATION_POLICY.COORDINATE) return;
  const lead = input.bindings[0];
  if (
    !lead ||
    !supportsAuthenticatedCoordinationOutput(lead.resolved.engine) ||
    lead.resolved.role.source !== AGENT_ROLE_SOURCE.BUILTIN ||
    lead.resolved.sandbox !== ROLE_SANDBOX.READ_ONLY ||
    !isReadOnlyRole(lead.resolved.role.spec)
  )
    invalid("coordination coordinator role authority is invalid");
  for (const executorBinding of input.bindings.slice(1)) {
    if (
      !supportsAuthenticatedCoordinationOutput(executorBinding.resolved.engine) ||
      executorBinding.resolved.sandbox !== ROLE_SANDBOX.WORKSPACE_WRITE ||
      isReadOnlyRole(executorBinding.resolved.role.spec) ||
      !executorBinding.resolved.role.spec.tools.some(isMutatingRoleToolIntent)
    )
      invalid("coordination executor role must have workspace-write authority");
  }
}

/** Atomically derives a normalized target plus before/after topology digests. */
export function projectConversationRevisionTopology(input: {
  parent: ConversationManifest;
  action: ConversationRevisionTopologyMutationV1;
  idempotencyKey: string;
}): ConversationRevisionTopologyProjectionV1 {
  const target = mutate(input);
  return {
    before_authority: materializeConversationTopologyAuthority(input.parent),
    target,
    authority: materializeConversationTopologyAuthority(target),
  };
}

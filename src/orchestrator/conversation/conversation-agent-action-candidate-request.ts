import {
  type ActionProposalRequestV1,
  type ActionProposalResponseV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type CanonicalActionRequestV1,
  actionIdempotencyScopeDigest,
  assertCanonicalRequestAuthority,
  exactObject,
  validateActionProposalRequestValue,
} from "../../actions/index.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { StoredTraceEvent } from "../trace/types.js";
import type { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import {
  AGENT_ACTION_CANDIDATE_ACTOR_KIND,
  AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS,
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_EVENT_TYPE,
  AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE,
  AGENT_ACTION_CANDIDATE_HOST_TOOL,
  AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX,
  AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY,
  AGENT_ACTION_CANDIDATE_PLANNING_MODE,
  AGENT_ACTION_CANDIDATE_RECORD_FIELDS,
  AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN,
  AGENT_ACTION_CANDIDATE_ROLE,
  AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
  isAgentActionCandidateSchemaVersion,
} from "./conversation-agent-action-candidate-contract.js";
import type { DurableAgentActionCandidateStageV1 } from "./conversation-agent-action-candidate-records.js";
import { validateAgentProposableHostActionRequest } from "./conversation-agent-action-candidate-validation.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { resolveRevisionBase } from "./revision-source.js";
import type { BrowserHostActionCandidateV1, ConversationManifest } from "./types.js";

export function isAgentActionCandidateGranted(
  manifest: ConversationManifest,
  participantId: string,
): boolean {
  const binding = manifest.bindings.find((candidate) => candidate.participant_id === participantId);
  return (
    binding?.input.roleRef !== AGENT_ACTION_CANDIDATE_ROLE.BRAINSTORM_EVALUATOR &&
    binding?.host_tools?.includes(AGENT_ACTION_CANDIDATE_HOST_TOOL.PROPOSE_ACTION) === true
  );
}

export function validateAgentActionCandidateEnvelope(value: unknown): BrowserHostActionCandidateV1 {
  const row = exactObject(
    value,
    AGENT_ACTION_CANDIDATE_RECORD_FIELDS.ENVELOPE,
    [],
    `$.${AGENT_ACTION_CANDIDATE_HOST_TOOL.PROPOSE_ACTION}`,
  );
  if (!isAgentActionCandidateSchemaVersion(row.schema_version))
    throw new Error("unsupported action candidate version");
  const candidate = validateAgentProposableHostActionRequest(row.candidate);
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    candidate: structuredClone(candidate),
  };
}

export function isValidCompletedAgentActionOrigin(
  manifest: ConversationManifest,
  participantId: string,
  response: StoredTraceEvent,
  responseIdempotencyKey: string,
): boolean {
  return (
    response.conversation_id === manifest.conversation_id &&
    response.revision_id === manifest.revision_id &&
    response.participant_id === participantId &&
    response.idempotency_key === responseIdempotencyKey &&
    response.event.type === AGENT_ACTION_CANDIDATE_EVENT_TYPE.AGENT_RESPONSE_DELTA &&
    response.event.payload.participant_id === participantId &&
    response.event.payload.completes_response === true
  );
}

export function agentActionCandidateGrantDigest(
  manifest: ConversationManifest,
  participantId: string,
): string {
  return digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.HOST_TOOL_GRANT, {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    conversation_id: manifest.conversation_id,
    revision_id: manifest.revision_id,
    participant_id: participantId,
    host_tools: [AGENT_ACTION_CANDIDATE_HOST_TOOL.PROPOSE_ACTION],
  });
}

export function agentActionCandidateAuthority(
  rootSessionId: string,
  participantId: string,
  grantedDigest: string,
): ActionRequestAuthorityV1 {
  const binding = {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    participant_id: participantId,
    host_tool: AGENT_ACTION_CANDIDATE_HOST_TOOL.PROPOSE_ACTION,
    grant_digest: grantedDigest,
  };
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    principal_digest: digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.PRINCIPAL, binding),
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN.CONVERSATION,
      root_session_id: rootSessionId,
    }),
    control_session_digest: digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.CONTROL, binding),
    csrf_epoch_digest: digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.GRANT_EPOCH, binding),
    actor: {
      kind: AGENT_ACTION_CANDIDATE_ACTOR_KIND.AGENT,
      public_actor_id: participantId,
      credential_class: AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS.LOOPBACK_SESSION,
    },
  };
}

export function canonicalAgentActionRequest(
  request: ActionProposalRequestV1,
  authority: ActionRequestAuthorityV1,
): CanonicalActionRequestV1 {
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    origin: AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN.CONVERSATION,
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    planning_options: {
      mode: AGENT_ACTION_CANDIDATE_PLANNING_MODE.DURABLE,
      network_read: AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY.ORDINARY_HOST_POLICY,
    },
    request: {
      schema_version: request.schema_version,
      anchor_event_id: request.anchor_event_id,
      expected: structuredClone(request.expected),
      candidate: structuredClone(request.candidate),
    },
  };
}

export function agentActionProposalRequest(
  stage: DurableAgentActionCandidateStageV1,
  origin: StoredTraceEvent,
  base: ReturnType<typeof resolveRevisionBase>,
): ActionProposalRequestV1 {
  return validateActionProposalRequestValue({
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    idempotency_key: `${AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX}${digestHex(stage.record_digest)}`,
    anchor_event_id: origin.event_id,
    expected: {
      mode: AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
      conversation_id: base.parent.node.conversation_id,
      revision_id: base.parent.node.revision_id,
      last_seq: base.parent.source.journal_head.last_seq,
      conversation_lock_digest: base.lock.lock_digest,
    },
    candidate: stage.candidate,
  });
}

export async function recoverExistingAgentActionProposal(input: {
  home: ConversationHomeAuthorities;
  actions: ConversationActionDomainRegistryV1;
  conversation_id: string;
  participant_id: string;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
}): Promise<ActionProposalResponseV1 | null> {
  const canonical = canonicalAgentActionRequest(input.request, input.authority);
  const proposal = input.home.actions.authority.preparedProposal({
    authority: input.authority,
    idempotency_key: input.request.idempotency_key,
  });
  if (!proposal) return null;
  assertCanonicalRequestAuthority(canonical, input.authority, proposal);
  input.home.actions.authority.createProposal({
    authority: input.authority,
    canonical_request: canonical,
    proposal,
  });
  const response = await input.actions.get(input.conversation_id, proposal.proposal_id);
  if (!response) throw new Error("agent action proposal domain projection is absent");
  return response;
}

export async function recoverPreparedAgentActionProposal(input: {
  home: ConversationHomeAuthorities;
  actions: ConversationActionDomainRegistryV1;
  stage: DurableAgentActionCandidateStageV1;
}): Promise<ActionProposalResponseV1 | null> {
  const authority = agentActionCandidateAuthority(
    input.stage.root_session_id,
    input.stage.participant_id,
    input.stage.grant_digest,
  );
  const idempotencyKey = `${AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX}${digestHex(input.stage.record_digest)}`;
  const proposal = input.home.actions.authority.preparedProposal({
    authority,
    idempotency_key: idempotencyKey,
  });
  if (!proposal) return null;
  if (
    proposal.base.conversation_id !== input.stage.conversation_id ||
    proposal.base.revision_id !== input.stage.revision_id ||
    proposal.base.last_seq === null ||
    proposal.base.conversation_lock_digest === null
  )
    throw new Error("prepared candidate proposal source is incomplete");
  const request = validateActionProposalRequestValue({
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    idempotency_key: idempotencyKey,
    anchor_event_id: proposal.origin_event_id,
    expected: {
      mode: AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
      conversation_id: input.stage.conversation_id,
      revision_id: input.stage.revision_id,
      last_seq: proposal.base.last_seq,
      conversation_lock_digest: proposal.base.conversation_lock_digest,
    },
    candidate: input.stage.candidate,
  });
  return recoverExistingAgentActionProposal({
    home: input.home,
    actions: input.actions,
    conversation_id: input.stage.conversation_id,
    participant_id: input.stage.participant_id,
    request,
    authority,
  });
}

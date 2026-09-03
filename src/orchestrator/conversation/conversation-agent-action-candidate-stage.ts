import type { ActionProposalResponseV1 } from "../../actions/index.js";
import type { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import {
  AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE,
  type AgentActionCandidateDiagnosticV1,
  type AgentActionCandidateMaterializationStateV1,
  type DurableAgentActionCandidateRejectionCodeV1,
} from "./conversation-agent-action-candidate-contract.js";
import {
  ConversationAgentActionCandidateResponseConflictError,
  materializeDurableAgentActionCandidateStage,
} from "./conversation-agent-action-candidate-records.js";
import {
  agentActionCandidateGrantDigest,
  isAgentActionCandidateGranted,
  validateAgentActionCandidateEnvelope,
} from "./conversation-agent-action-candidate-request.js";
import type { ConversationAgentActionCandidateStoreV1 } from "./conversation-agent-action-candidate-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { resolveConversationLineageSource } from "./revision-source.js";
import type { ConversationManifest } from "./types.js";

export type { AgentActionCandidateDiagnosticV1 } from "./conversation-agent-action-candidate-contract.js";

export interface AgentActionCandidateRecordResultV1 {
  accepted: boolean;
  diagnostic_code: AgentActionCandidateDiagnosticV1 | null;
  record_digest?: string;
}

export interface AgentActionCandidateMaterializationV1 {
  record_digest: string;
  state: AgentActionCandidateMaterializationStateV1;
  proposal: ActionProposalResponseV1 | null;
  rejection_code: DurableAgentActionCandidateRejectionCodeV1 | null;
}

export function stageAgentActionCandidate(input: {
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
  store: ConversationAgentActionCandidateStoreV1;
  actions: ConversationActionDomainRegistryV1 | null;
  manifest: ConversationManifest;
  participant_id: string;
  response_idempotency_key: string;
  candidate: unknown;
}): AgentActionCandidateRecordResultV1 {
  if (!isAgentActionCandidateGranted(input.manifest, input.participant_id))
    return {
      accepted: false,
      diagnostic_code: AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE.HOST_TOOL_NOT_GRANTED,
    };
  let envelope: ReturnType<typeof validateAgentActionCandidateEnvelope>;
  try {
    envelope = validateAgentActionCandidateEnvelope(input.candidate);
    input.actions?.assertCandidateSupported(envelope.candidate);
  } catch {
    return {
      accepted: false,
      diagnostic_code: AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE.INVALID_ACTION_CANDIDATE,
    };
  }
  try {
    const stage = materializeDurableAgentActionCandidateStage({
      root_session_id: resolveConversationLineageSource({
        artifactRoot: input.artifactRoot,
        traceRoot: input.traceRoot,
        conversationId: input.manifest.conversation_id,
        home: input.home,
      }).lineage.root_session_id,
      conversation_id: input.manifest.conversation_id,
      revision_id: input.manifest.revision_id,
      participant_id: input.participant_id,
      response_idempotency_key: input.response_idempotency_key,
      candidate: envelope.candidate,
      grant_digest: agentActionCandidateGrantDigest(input.manifest, input.participant_id),
    });
    input.store.writeStage(stage);
    return { accepted: true, diagnostic_code: null, record_digest: stage.record_digest };
  } catch (error) {
    if (error instanceof ConversationAgentActionCandidateResponseConflictError)
      return {
        accepted: false,
        diagnostic_code: AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE.ACTION_CANDIDATE_CONFLICT,
      };
    return {
      accepted: false,
      diagnostic_code: AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE.INVALID_ACTION_ORIGIN,
    };
  }
}

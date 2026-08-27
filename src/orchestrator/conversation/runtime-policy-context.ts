import type { TraceCorrelation } from "../trace/types.js";
import { validateConversationCoordinationRepoEvidence } from "./conversation-coordination-evidence.js";
import {
  assertCoordinatorEmission,
  policyContextView,
  snapshotRuntimeValue,
} from "./emission-authority.js";
import type { LiveConversation } from "./lifecycle-gate.js";
import { conversationMessages } from "./policy-registry.js";
import { readRuntimeConversationCoordinationState } from "./runtime-coordination-state.js";
import { bindSharedHandoffToAttempt } from "./runtime-handoff.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import { prepareRuntimeConversationTurn } from "./runtime-turn-delivery.js";
import type {
  ArtifactCreateRequest,
  ArtifactUpdateRequest,
  AttemptRef,
  ConversationContext,
  CoordinatorEmission,
  PolicyAttemptRequest,
} from "./types.js";

interface RuntimePolicyContextAuthority {
  options: ConversationRuntimeOptions;
  live: LiveConversation;
  signal: AbortSignal;
  correlation: TraceCorrelation;
  writePolicy(emission: CoordinatorEmission): ReturnType<ConversationContext["emit"]>;
  launchAttempt(
    request: PolicyAttemptRequest,
    refs: Map<AttemptRef, string>,
  ): ReturnType<ConversationContext["launchAttempt"]>;
  createArtifact(request: ArtifactCreateRequest): ReturnType<ConversationContext["createArtifact"]>;
  updateArtifact(request: ArtifactUpdateRequest): ReturnType<ConversationContext["updateArtifact"]>;
}

/** Builds the policy-facing capability surface without exposing runtime authorities. */
export function createRuntimePolicyContext({
  options,
  live,
  signal,
  correlation,
  writePolicy,
  launchAttempt,
  createArtifact,
  updateArtifact,
}: RuntimePolicyContextAuthority): ConversationContext {
  const refs = new Map<AttemptRef, string>();
  return Object.freeze({
    correlation,
    ...policyContextView(live.manifest, live.bindings),
    signal,
    messages: () =>
      options.traceStore.readConversation(live.manifest.conversation_id).then(conversationMessages),
    prepareTurn: (request: Parameters<ConversationContext["prepareTurn"]>[0]) =>
      prepareRuntimeConversationTurn(options, live, request),
    coordinationState: () =>
      readRuntimeConversationCoordinationState({
        artifactStore: options.artifactStore,
        traceStore: options.traceStore,
        conversationId: live.manifest.conversation_id,
        revisionId: live.manifest.revision_id,
      }),
    validateCoordinationRepoEvidence: (references: readonly string[]) =>
      validateConversationCoordinationRepoEvidence(live.manifest.repo_root, references),
    observeWorkspace: (workspaceKey: string) => {
      if (!options.coordinationWorkspaces)
        throw new Error("coordination workspace authority is unavailable");
      return options.coordinationWorkspaces.observe({
        repoRoot: live.manifest.repo_root,
        workflowId: live.manifest.workflow_id,
        workspaceKey,
      });
    },
    verifyWorkspace: (
      workspaceKey: Parameters<ConversationContext["verifyWorkspace"]>[0],
      completion: Parameters<ConversationContext["verifyWorkspace"]>[1],
    ) => {
      if (!options.coordinationWorkspaces)
        throw new Error("coordination workspace authority is unavailable");
      return options.coordinationWorkspaces.verify({
        repoRoot: live.manifest.repo_root,
        workflowId: live.manifest.workflow_id,
        workspaceKey,
        completion: {
          task_id: completion.task_id,
          changed_paths: completion.changed_paths,
          commands: completion.verification.commands,
        },
      });
    },
    settleWorkspace: async (
      workspaceKey: Parameters<ConversationContext["settleWorkspace"]>[0],
      outcome: Parameters<ConversationContext["settleWorkspace"]>[1],
    ) => {
      if (!options.coordinationWorkspaces)
        throw new Error("coordination workspace authority is unavailable");
      options.coordinationWorkspaces.settle(
        {
          repoRoot: live.manifest.repo_root,
          workflowId: live.manifest.workflow_id,
          workspaceKey,
        },
        outcome,
      );
    },
    publishSocialIntent: (input: Parameters<ConversationContext["publishSocialIntent"]>[0]) =>
      options.socialAuthority?.participantIntent({
        conversation_id: live.manifest.conversation_id,
        response_event_id: input.response_event_id,
        actor_participant_id: input.participant_id,
        request: input.request,
      }) ?? { accepted: false, diagnostic_code: "interaction_authority_unavailable" },
    stageActionCandidate: (input: Parameters<ConversationContext["stageActionCandidate"]>[0]) =>
      options.agentActionCandidates?.stage({
        manifest: live.manifest,
        participant_id: input.participant_id,
        response_idempotency_key: input.response_idempotency_key,
        candidate: input.candidate,
      }) ?? { accepted: false, diagnostic_code: "host_tool_not_granted" },
    emit: (emission: CoordinatorEmission) => {
      const captured = snapshotRuntimeValue(emission);
      assertCoordinatorEmission(captured, live.operationId);
      return writePolicy(captured);
    },
    launchAttempt: (request: PolicyAttemptRequest) =>
      launchAttempt(bindSharedHandoffToAttempt(live.sharedHandoff, request), refs),
    createArtifact,
    updateArtifact,
  });
}

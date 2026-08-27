import {
  type ActionRequestAuthorityV1,
  actionIdempotencyScopeDigest,
} from "../../actions/index.js";
import type { MaterializedAgentBinding } from "../../agents/binding.js";
import { ENGINE_SESSION_MODE } from "../../dispatch/session-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { ConversationArtifactStore } from "./artifact-store.js";
import type { BindingAuthoritySnapshot, ConversationDurableRecord } from "./artifact-validation.js";
import { conversationLockDigest, semanticConversationJournalHead } from "./catalog-lock.js";
import { resolveActiveCompaction } from "./conversation-active-compaction.js";
import { CONVERSATION_HEAD_STATUS } from "./conversation-catalog-contract.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationInteractionCorruptError } from "./conversation-interaction-store.js";
import type { ConversationInteractionFoldV1 } from "./conversation-interaction-types.js";
import { materializeConversationLockBinding } from "./conversation-lock.js";
import { isConversationTerminalLifecycle } from "./conversation-public-wire-contract.js";
import { type BuiltContextHandoffV1, buildContextHandoff } from "./handoff-selection.js";
import type { PublicCompactionArtifactV1, PublicHandoffBindingV1 } from "./handoff-types.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import {
  type PublishedRevisionTransitionInputV1,
  publishedRevisionAuthorityMap,
} from "./lineage-published-transition.js";
import {
  type ConversationLineageReadV1,
  type ValidatedLineageNodeV1,
  deriveConversationLineages,
} from "./lineage-reader.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import type { LineageHeadRecordV1, LineageNodeIdentityV1 } from "./lineage-types.js";
import { bindingAuthorities } from "./policy-registry.js";
import {
  ConversationRevisionConflictError,
  ConversationRevisionCorruptError,
  ConversationRevisionInactiveHeadError,
  ConversationRevisionNotStableTerminalError,
} from "./revision-errors.js";
import {
  buildRevisionQuoteGraphArtifact,
  revisionPublicTranscript,
} from "./revision-handoff-context.js";
import { readConversationSourceInventory } from "./source-inventory.js";
import type { ConversationSnapshot } from "./types.js";
import type { ConversationBinding, ConversationManifest } from "./types.js";

export {
  buildRevisionQuoteGraphArtifact,
  revisionPublicTranscript,
} from "./revision-handoff-context.js";
export type {
  RevisionPublicTranscriptV1,
  RevisionQuoteSourceV1,
} from "./revision-handoff-context.js";

const key = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

export interface ResolvedRevisionBaseV1 {
  lineage: ConversationLineageReadV1;
  parent: ValidatedLineageNodeV1;
  head: LineageHeadRecordV1;
  reservation: RevisionReservationRecordV1 | null;
  lock: ReturnType<typeof materializeConversationLockBinding>;
  published: readonly PublishedRevisionTransitionInputV1[];
  active_compaction: PublicCompactionArtifactV1 | null;
  interaction_fold: ConversationInteractionFoldV1 | null;
}

export interface ResolvedConversationLineageSourceV1 {
  lineage: ConversationLineageReadV1;
  parent: ValidatedLineageNodeV1;
  published: readonly PublishedRevisionTransitionInputV1[];
}

/** Resolves an authoritative lineage node without treating current head/terminal policy as identity. */
export function resolveConversationLineageSource(input: {
  artifactRoot: string;
  traceRoot: string;
  conversationId: string;
  home: ConversationHomeAuthorities;
}): ResolvedConversationLineageSourceV1 {
  const published = input.home.publishedRevisionTransitions();
  const inventory = readConversationSourceInventory({
    artifactRoot: input.artifactRoot,
    traceRoot: input.traceRoot,
    actionAuthority: input.home.reviewedActionAuthority(),
  });
  const derivation = deriveConversationLineages(inventory, {
    publishedRevisionTransitions: published,
  });
  const lineage = derivation.lineages.find((candidate) =>
    candidate.nodes.some((node) => node.node.conversation_id === input.conversationId),
  );
  const parent = lineage?.nodes.find((node) => node.node.conversation_id === input.conversationId);
  if (!inventory.authoritative || !derivation.authoritative || !lineage || !parent)
    throw new ConversationRevisionCorruptError("conversation lineage is not authoritative");
  return { lineage, parent, published };
}

export function defaultConversationActionAuthority(
  rootSessionId: string,
): ActionRequestAuthorityV1 {
  return {
    schema_version: "1.0",
    principal_digest: digestV1("VF-CONVERSATION-CLI-PRINCIPAL\0v1\0", {
      schema_version: "1.0",
      root_session_id: rootSessionId,
    }),
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation",
      root_session_id: rootSessionId,
    }),
    control_session_digest: digestV1("VF-CONVERSATION-CLI-CONTROL\0v1\0", {
      schema_version: "1.0",
      root_session_id: rootSessionId,
    }),
    csrf_epoch_digest: digestV1("VF-CONVERSATION-CLI-CSRF\0v1\0", {
      schema_version: "1.0",
      root_session_id: rootSessionId,
    }),
    actor: {
      kind: "human-cli",
      public_actor_id: "vf-local-cli",
      credential_class: "interactive-tty",
    },
  };
}

export function resolveRevisionBase(input: {
  artifactRoot: string;
  traceRoot: string;
  conversationId: string;
  home: ConversationHomeAuthorities;
}): ResolvedRevisionBaseV1 {
  const { lineage, parent, published } = resolveConversationLineageSource(input);
  const transitions = publishedRevisionAuthorityMap(published);
  const stored = input.home.lineage.readHead(lineage.root_session_id);
  const head = validateLineageHeadForRead(
    stored ?? input.home.lineage.initializeHead(lineage),
    lineage,
    transitions,
  );
  if (
    head.head_status !== CONVERSATION_HEAD_STATUS.COMMITTED ||
    !head.active ||
    key(head.active) !== key(parent.node)
  )
    throw new ConversationRevisionInactiveHeadError();
  if (!isConversationTerminalLifecycle(parent.source.journal_head.lifecycle))
    throw new ConversationRevisionNotStableTerminalError();
  const reservation = input.home.lineage.readReservation(lineage.root_session_id);
  const claimEpoch = reservation?.revision_claim_epoch ?? 0;
  const semantic = semanticConversationJournalHead(lineage.root_session_id, parent.source);
  const lock = materializeConversationLockBinding({
    root_session_id: lineage.root_session_id,
    conversation_id: parent.node.conversation_id,
    revision_id: parent.node.revision_id,
    manifest_record_digest: parent.manifest_digest,
    semantic_journal_head_digest: semantic.digest,
    semantic_last_seq: semantic.last_sequence,
    revision_claim_epoch: claimEpoch,
  });
  if (
    lock.lock_digest !== conversationLockDigest(lineage.root_session_id, parent.source, claimEpoch)
  )
    throw new ConversationRevisionCorruptError("conversation lock derivations disagree");
  const selected = revisionPublicTranscript(lineage, parent);
  const activeCompaction = resolveActiveCompaction({
    artifacts: new ConversationArtifactStore({ dir: input.artifactRoot }),
    lineage,
    parent,
    public_events: [...selected.messages, ...selected.responses],
  });
  let interactionFold: ConversationInteractionFoldV1 | null = null;
  try {
    interactionFold = input.home.interactions.readFold(lineage.root_session_id);
  } catch (error) {
    if (!(error instanceof ConversationInteractionCorruptError)) throw error;
  }
  return {
    lineage,
    parent,
    head,
    reservation,
    lock,
    published,
    active_compaction: activeCompaction,
    interaction_fold: interactionFold,
  };
}

export function buildRevisionHandoff(input: {
  base: ResolvedRevisionBaseV1;
  bindings: PublicHandoffBindingV1[];
  snapshot: ConversationSnapshot;
  promptBudgetBytes?: number;
}): BuiltContextHandoffV1 {
  const selected = revisionPublicTranscript(input.base.lineage, input.base.parent);
  const quoteGraph = buildRevisionQuoteGraphArtifact({
    root_session_id: input.base.lineage.root_session_id,
    transcript: selected,
    interaction_fold: input.base.interaction_fold,
  });
  return buildContextHandoff({
    source: {
      conversation_id: input.base.parent.node.conversation_id,
      revision_id: input.base.parent.node.revision_id,
      last_seq: input.base.parent.source.journal_head.last_seq,
      lock_digest: input.base.lock.lock_digest,
    },
    topic: input.base.parent.source.manifest.topic,
    policy_value: input.base.parent.source.manifest.policy,
    bindings: input.bindings,
    user_messages: selected.messages,
    final_responses: selected.responses,
    artifacts: [],
    ...(quoteGraph ? { mandatory_artifacts: [quoteGraph] } : {}),
    consensus: { score: input.snapshot.consensus_score, synthesis: null },
    prompt_budget_bytes: input.promptBudgetBytes ?? 1024 * 1024,
    active_compaction: input.base.active_compaction,
  });
}

export function materializeRevisionManifest(input: {
  parent: ConversationManifest;
  target?: ConversationManifest;
  child: LineageNodeIdentityV1;
  operationId: string;
  createdAt: string;
}): ConversationManifest {
  const suffix = digestHex(
    digestV1("VF-CONVERSATION-REVISION-RUN\0v1\0", {
      schema_version: "1.0",
      operation_id: input.operationId,
    }),
  ).slice(0, 32);
  return {
    ...structuredClone(input.target ?? input.parent),
    conversation_id: input.child.conversation_id,
    revision_id: input.child.revision_id,
    run_id: `run-${suffix}`,
    parent_conversation_id: input.parent.conversation_id,
    parent_revision_id: input.parent.revision_id,
    bindings: (input.target ?? input.parent).bindings.map((binding) => ({
      ...structuredClone(binding),
      input: {
        ...structuredClone(binding.input),
        sessionMode: ENGINE_SESSION_MODE.FRESH,
      },
    })),
    created_at: input.createdAt,
  };
}

export async function materializeFreshRevisionBindings(input: {
  manifest: ConversationManifest;
  rehydrate(
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ): Promise<MaterializedAgentBinding>;
}): Promise<{ bindings: MaterializedAgentBinding[]; authorities: BindingAuthoritySnapshot[] }> {
  const bindings = await Promise.all(
    input.manifest.bindings.map((binding) => input.rehydrate(binding, input.manifest)),
  );
  if (
    bindings.some(
      (binding) =>
        binding.resolved.sessionMode !== ENGINE_SESSION_MODE.FRESH ||
        binding.spawn.sessionMode !== ENGINE_SESSION_MODE.FRESH,
    )
  )
    throw new ConversationRevisionConflictError("revision binding is not fresh");
  return { bindings, authorities: bindingAuthorities(input.manifest, bindings) };
}

export function revisionBindingProjection(input: {
  manifest: ConversationManifest;
  previousManifest?: ConversationManifest;
  authorities: readonly BindingAuthoritySnapshot[];
}): {
  publicBindings: PublicHandoffBindingV1[];
  participantStarts: RevisionPreparationPlanV1["participant_starts"];
  bindingSetDigest: string;
  bindingDeltaDigest: string;
  intendedAuthorities: BindingAuthoritySnapshot[];
} {
  const intendedAuthorities = input.authorities.map((authority) => ({
    ...structuredClone(authority),
    session_mode: ENGINE_SESSION_MODE.FRESH,
  }));
  const previousParticipants = new Set(
    input.previousManifest?.bindings.map((binding) => binding.participant_id) ??
      input.manifest.bindings.map((binding) => binding.participant_id),
  );
  const publicBindings = intendedAuthorities.map((authority, index) => ({
    participant_id: authority.participant_id,
    engine: authority.engine,
    model: authority.model,
    role_ref: input.manifest.bindings[index]?.input.roleRef ?? "",
    continuity: previousParticipants.has(authority.participant_id)
      ? ("retained" as const)
      : ("added" as const),
  }));
  const participantStarts = intendedAuthorities.map((authority, index) => ({
    participant_id: authority.participant_id,
    engine: authority.engine,
    model: authority.model,
    adapter_fingerprint: digestV1("VF-REVISION-ADAPTER-FINGERPRINT\0v1\0", {
      engine: authority.engine,
      model: authority.model,
      role_hash: authority.role_hash,
      skill_hashes: authority.skill_hashes,
    }),
    reconciliation_mode: "vf-process-lease" as const,
    cancellation_mode: "vf-process-lease" as const,
    wrapper_descriptor_digest: digestV1("VF-REVISION-WRAPPER\0v1\0", {
      participant_id: authority.participant_id,
      binding: input.manifest.bindings[index]?.input ?? null,
    }),
    max_shared_prompt_bytes: 1024 * 1024,
  }));
  return {
    publicBindings,
    participantStarts,
    intendedAuthorities,
    bindingSetDigest: digestV1("VF-REVISION-BINDING-SET\0v1\0", intendedAuthorities),
    bindingDeltaDigest: digestV1("VF-REVISION-BINDING-DELTA\0v1\0", {
      schema_version: "1.0",
      before: input.previousManifest?.bindings ?? input.manifest.bindings,
      after: input.manifest.bindings,
    }),
  };
}

export function revisionManifestRecord(
  manifest: ConversationManifest,
  authorities: BindingAuthoritySnapshot[],
): { record: ConversationDurableRecord; digest: string } {
  const record: ConversationDurableRecord = {
    manifest: structuredClone(manifest),
    binding_authorities: structuredClone(authorities),
    resume_bindings: [],
    child_revisions: {},
    artifacts: [],
    artifact_reservations: {},
  };
  return {
    record,
    digest: digestV1("VF-CONVERSATION-MANIFEST-RECORD\0v1\0", record),
  };
}

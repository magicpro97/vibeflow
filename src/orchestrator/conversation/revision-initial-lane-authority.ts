import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type {
  AttemptHandle,
  DurableAttemptStartAuthorityReaderV1,
  EngineSessionResult,
} from "../../dispatch/session-types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { foldRevisionOperation } from "./revision-fold.js";
import {
  publishAcceptedRevisionLaneBarrier,
  publishRevisionLaneResume,
} from "./revision-lane-barrier.js";
import { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import {
  latestRevisionLaneReceipts,
  writeInitialRevisionLaneEvidence,
} from "./revision-lane-observation.js";
import { revisionLaneReceiptIsProved } from "./revision-lane-proof.js";
import {
  type ParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "./revision-participant-receipt.js";
import { type RevisionOperationEventV1, materializeRevisionEvent } from "./revision-planner.js";
import { readRevisionStartAuthority } from "./revision-start-authority.js";
import type { ConversationRevisionStore } from "./revision-store.js";

const REVISION_OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface InitialRevisionLaneTokenV1 {
  operation: RevisionOperationV1;
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  attempt_key: string;
  prepared_at: string;
  effect_action_operation_id: string;
}

function later(left: string, right: string): string {
  return left < right ? right : left;
}

export class InitialRevisionLaneAuthority {
  private readonly evidence: RevisionLaneEvidenceStore;
  private readonly active = new Map<string, Map<string, AttemptHandle>>();
  private startAuthority: DurableAttemptStartAuthorityReaderV1 | undefined;

  constructor(
    artifactRoot: string,
    private readonly revisions: ConversationRevisionStore,
    private readonly now: () => string,
  ) {
    this.evidence = new RevisionLaneEvidenceStore(artifactRoot);
  }

  bindStartAuthority(reader: DurableAttemptStartAuthorityReaderV1 | undefined): void {
    this.startAuthority = reader;
  }

  receiptIsProved(
    operation: RevisionOperationV1,
    participant: RevisionPreparationPlanV1["participant_starts"][number],
    receipt: ParticipantStartReceiptV1,
  ): boolean {
    return revisionLaneReceiptIsProved({
      evidence: this.evidence,
      reader: this.startAuthority,
      operation,
      participant,
      receipt,
    });
  }

  prepare(input: {
    operation_id: string;
    conversation_id: string;
    participant_id: string;
    binding: MaterializedAgentBinding;
    purpose: string;
  }): InitialRevisionLaneTokenV1 | null {
    if (input.purpose === "baseline") return null;
    if (!REVISION_OPERATION.test(input.operation_id)) return null;
    const operation = this.revisions.readOperation(input.operation_id);
    if (!operation) return null;
    if (operation.child.conversation_id !== input.conversation_id)
      throw new Error("revision participant conversation authority changed");
    const events = this.revisions.readEvents(operation.operation_id);
    const folded = foldRevisionOperation(operation, events);
    if (folded.state !== "starting") return null;
    const plan = this.revisions.readPlan(operation.operation_id);
    const participant = plan?.participant_starts.find(
      ({ participant_id }) => participant_id === input.participant_id,
    );
    if (!plan || !participant) throw new Error("revision participant plan binding is absent");
    if (
      participant.engine !== input.binding.resolved.engine ||
      participant.model !== input.binding.resolved.model
    )
      throw new Error("revision participant adapter binding changed");
    const latest = latestRevisionLaneReceipts(events).get(participant.participant_id);
    if (latest?.state === "accepted") return null;
    if (latest)
      throw new Error("revision participant attempted again without a proved start barrier");
    const identity = {
      operation_id: operation.operation_id,
      participant_id: participant.participant_id,
      start_generation: 0,
    };
    const token = {
      operation,
      participant,
      attempt_key: participantStartAttemptKey(identity),
      prepared_at: later(this.now(), events.at(-1)?.recorded_at ?? operation.created_at),
      effect_action_operation_id: folded.effect_action_operation_id,
    };
    let next = this.append(token, events, "prepared", null, null);
    next = this.append(token, next, "effect_in_progress", null, null);
    return token;
  }

  attach(token: InitialRevisionLaneTokenV1, handle: AttemptHandle): void {
    let lanes = this.active.get(token.operation.operation_id);
    if (!lanes) {
      lanes = new Map();
      this.active.set(token.operation.operation_id, lanes);
    }
    if (lanes.has(token.participant.participant_id))
      throw new Error("revision participant lane is already active");
    lanes.set(token.participant.participant_id, handle);
  }

  startFailed(
    token: InitialRevisionLaneTokenV1,
    reader: DurableAttemptStartAuthorityReaderV1 | undefined,
  ): void {
    const authority = readRevisionStartAuthority({
      reader,
      attemptKey: token.attempt_key,
      participant: token.participant,
    });
    const proof = authority
      ? writeInitialRevisionLaneEvidence({
          store: this.evidence,
          token,
          authority,
          resume: null,
          recordedAt: this.now(),
        })
      : null;
    this.append(
      token,
      this.revisions.readEvents(token.operation.operation_id),
      authority?.outcome === "proved-absent" ? "failed" : "uncertain",
      authority?.outcome === "proved-absent" ? null : this.now(),
      proof,
    );
    this.detach(token);
  }

  observe(
    token: InitialRevisionLaneTokenV1,
    handle: AttemptHandle,
    result: EngineSessionResult,
    barrier: {
      artifacts: ConversationArtifactStore;
      live: AttemptConversationAuthority;
      startAuthority: DurableAttemptStartAuthorityReaderV1 | undefined;
    },
  ): void {
    const resume = handle.readResumeBinding();
    const adapter = handle.readEvidenceBinding();
    const authority = readRevisionStartAuthority({
      reader: barrier.startAuthority,
      attemptKey: token.attempt_key,
      participant: token.participant,
    });
    const accepted =
      result.attemptId === token.attempt_key &&
      result.ok &&
      result.state === "completed" &&
      resume?.attemptId === token.attempt_key &&
      resume.engine === token.participant.engine &&
      adapter?.attemptId === token.attempt_key &&
      authority?.outcome === "accepted" &&
      authority.native_session_id === resume.nativeSessionId &&
      authority.evidence_ref === adapter.internalRef;
    const observedAt = this.now();
    const proof = authority
      ? writeInitialRevisionLaneEvidence({
          store: this.evidence,
          token,
          authority,
          resume: resume ?? null,
          recordedAt: observedAt,
        })
      : null;
    let events = this.revisions.readEvents(token.operation.operation_id);
    if (accepted) {
      events = this.append(token, events, "observed", observedAt, proof);
      events = this.append(token, events, "accepted", observedAt, proof);
      const plan = this.revisions.readPlan(token.operation.operation_id);
      if (!plan) throw new Error("revision participant barrier plan disappeared");
      publishAcceptedRevisionLaneBarrier({
        operation: token.operation,
        plan,
        lanes: latestRevisionLaneReceipts(events),
        evidence: this.evidence,
        artifacts: barrier.artifacts,
        live: barrier.live,
      });
    } else if (authority?.outcome === "proved-absent")
      this.append(token, events, "failed", null, proof);
    else this.append(token, events, "uncertain", observedAt, proof);
    this.detach(token);
  }

  effectUnknown(
    token: InitialRevisionLaneTokenV1,
    handle: AttemptHandle,
    reader: DurableAttemptStartAuthorityReaderV1 | undefined,
  ): void {
    const latest = latestRevisionLaneReceipts(
      this.revisions.readEvents(token.operation.operation_id),
    ).get(token.participant.participant_id);
    if (latest?.state !== "effect_in_progress") {
      this.detach(token);
      return;
    }
    const observedAt = this.now();
    const resume = handle.readResumeBinding();
    const authority = readRevisionStartAuthority({
      reader,
      attemptKey: token.attempt_key,
      participant: token.participant,
    });
    const proof = authority
      ? writeInitialRevisionLaneEvidence({
          store: this.evidence,
          token,
          authority,
          resume: resume ?? null,
          recordedAt: observedAt,
        })
      : null;
    this.append(
      token,
      this.revisions.readEvents(token.operation.operation_id),
      authority?.outcome === "proved-absent" ? "failed" : "uncertain",
      authority?.outcome === "proved-absent" ? null : observedAt,
      proof,
    );
    this.detach(token);
  }

  finalize(
    operation: RevisionOperationV1,
    plan: RevisionPreparationPlanV1,
    resultStatus: string,
    artifacts: ConversationArtifactStore,
  ): "started" | "start_failed" | "needs_recovery" {
    if (!this.isQuiescent(operation.operation_id)) return "needs_recovery";
    const lanes = latestRevisionLaneReceipts(this.revisions.readEvents(operation.operation_id));
    const participants = new Map(
      plan.participant_starts.map((participant) => [participant.participant_id, participant]),
    );
    if (
      lanes.size !== participants.size ||
      [...lanes.keys()].some((participantId) => !participants.has(participantId))
    )
      return "needs_recovery";
    if (
      ["completed", "awaiting_approval"].includes(resultStatus) &&
      plan.participant_starts.every(
        ({ participant_id }) => lanes.get(participant_id)?.state === "accepted",
      )
    ) {
      for (const receipt of lanes.values())
        publishRevisionLaneResume({ operation, receipt, evidence: this.evidence, artifacts });
      return "started";
    }
    return plan.participant_starts.every((participant) => {
      const receipt = lanes.get(participant.participant_id);
      return receipt?.state === "failed" && this.receiptIsProved(operation, participant, receipt);
    })
      ? "start_failed"
      : "needs_recovery";
  }

  isQuiescent(operationId: string): boolean {
    return (this.active.get(operationId)?.size ?? 0) === 0;
  }

  allAccepted(operationId: string, plan: RevisionPreparationPlanV1): boolean {
    const lanes = latestRevisionLaneReceipts(this.revisions.readEvents(operationId));
    return plan.participant_starts.every(
      ({ participant_id }) => lanes.get(participant_id)?.state === "accepted",
    );
  }

  private append(
    token: InitialRevisionLaneTokenV1,
    events: RevisionOperationEventV1[],
    state: ParticipantStartReceiptV1["state"],
    observedAt: string | null,
    evidence: { ref: string | null; digest: string | null } | null,
  ): RevisionOperationEventV1[] {
    const receipt = this.receipt(token, state, observedAt, evidence);
    const event = materializeRevisionEvent(
      token.operation,
      events,
      {
        kind: "participant-start",
        authorized_by_action_operation_id: token.effect_action_operation_id,
        effect_action_operation_id: token.effect_action_operation_id,
        receipt,
      },
      later(this.now(), events.at(-1)?.recorded_at ?? token.prepared_at),
    );
    this.revisions.appendEvent(token.operation, event);
    return [...events, event];
  }

  private receipt(
    token: InitialRevisionLaneTokenV1,
    state: ParticipantStartReceiptV1["state"],
    observedAt: string | null,
    evidence: { ref: string | null; digest: string | null } | null,
  ): ParticipantStartReceiptV1 {
    const base = {
      operation_id: token.operation.operation_id,
      participant_id: token.participant.participant_id,
      start_generation: 0,
      attempt_key: token.attempt_key,
    };
    const processEvidence = token.participant.reconciliation_mode === "vf-process-lease";
    return materializeParticipantStartReceipt({
      ...base,
      state,
      engine: token.participant.engine,
      model: token.participant.model,
      adapter_fingerprint: token.participant.adapter_fingerprint,
      reconciliation_mode: token.participant.reconciliation_mode,
      cancel_attempt_key: null,
      cancellation_mode: null,
      shared_prompt_digest: token.operation.prompt_projection_digest,
      wrapper_digest: token.participant.wrapper_descriptor_digest,
      private_native_session_ref: processEvidence ? null : (evidence?.ref ?? null),
      private_native_session_producer_receipt_digest: processEvidence
        ? null
        : (evidence?.digest ?? null),
      private_process_lease_ref: processEvidence ? (evidence?.ref ?? null) : null,
      private_process_lease_producer_receipt_digest: processEvidence
        ? (evidence?.digest ?? null)
        : null,
      prepared_at: token.prepared_at,
      observed_at: observedAt,
    });
  }

  private detach(token: InitialRevisionLaneTokenV1): void {
    const lanes = this.active.get(token.operation.operation_id);
    lanes?.delete(token.participant.participant_id);
    if (lanes?.size === 0) this.active.delete(token.operation.operation_id);
  }
}

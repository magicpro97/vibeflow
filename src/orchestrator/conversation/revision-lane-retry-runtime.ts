import { PUBLIC_OPERATION_PARTICIPANT_START_PHASE } from "../../actions/protocol-contract.js";
import {
  ENGINE_ATTEMPT_START_OUTCOME,
  ENGINE_SESSION_MODE,
} from "../../dispatch/session-contract.js";
import {
  type AttemptHandle,
  type EngineSessionAdapter,
  createSpawnOptionsProjection,
} from "../../dispatch/session-types.js";
import { contextHandoffSharedPromptBytes } from "./handoff-selection.js";
import type { ContextHandoffStore } from "./handoff-store.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { rehydrateConversation } from "./policy-registry.js";
import { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import { classifyRevisionLaneRetryResult } from "./revision-lane-retry-validation.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";
import { readRevisionStartAuthority } from "./revision-start-authority.js";
import type { ConversationRuntimeOptions } from "./runtime.js";

export interface RevisionLaneRetryResultV1 {
  participant_id: string;
  start_generation: number;
  attempt_key: string;
  outcome:
    | typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED
    | typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED
    | typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN;
  private_evidence_ref: string | null;
  private_evidence_digest: string | null;
  observed_at: string;
}

type InternalRevisionLaneRetryResultV1 = RevisionLaneRetryResultV1 & {
  resume: ReturnType<AttemptHandle["readResumeBinding"]>;
};

export class RevisionLaneRetryRuntime {
  private readonly evidence: RevisionLaneEvidenceStore;
  private readonly adapter: EngineSessionAdapter;
  private readonly active = new Map<
    string,
    Map<string, { handle: AttemptHandle; controller: AbortController }>
  >();

  constructor(
    private readonly options: ConversationRuntimeOptions,
    private readonly handoffs: ContextHandoffStore,
  ) {
    this.adapter = options.sessionAdapter;
    this.evidence = new RevisionLaneEvidenceStore(
      options.artifactRoot ?? options.artifactStore.rootPath(),
    );
  }

  async retry(input: {
    operation: RevisionOperationV1;
    plan: RevisionPreparationPlanV1;
    generations: ReadonlyMap<string, number>;
    attempt_keys: ReadonlyMap<string, string>;
    prior_receipts: ReadonlyMap<string, readonly ParticipantStartReceiptV1[]>;
    now(): string;
  }): Promise<RevisionLaneRetryResultV1[]> {
    if (this.active.has(input.operation.operation_id))
      throw new Error("revision retry already has active participant lanes");
    const { record, bindings } = await rehydrateConversation(
      input.operation.child.conversation_id,
      this.options.artifactStore,
      this.options.rehydrateBinding,
    );
    const handoff = this.handoffs.read(input.operation.handoff_digest);
    if (!handoff || handoff.prompt_projection_digest !== input.operation.prompt_projection_digest)
      throw new Error("revision retry handoff authority changed");
    const sharedPrompt = contextHandoffSharedPromptBytes(handoff.prompt_projection).toString(
      "utf8",
    );
    const active = new Map<string, { handle: AttemptHandle; controller: AbortController }>();
    this.active.set(input.operation.operation_id, active);
    const terminatePeers = async (failedParticipant: string) => {
      await Promise.all(
        [...active.entries()]
          .filter(([participantId]) => participantId !== failedParticipant)
          .map(async ([, lane]) => {
            lane.controller.abort("revision retry barrier failed");
            await lane.handle.terminate("revision retry barrier failed").catch(() => undefined);
          }),
      );
    };
    const starts = input.plan.participant_starts.map((participant) => {
      const index = record.manifest.bindings.findIndex(
        ({ participant_id }) => participant_id === participant.participant_id,
      );
      const binding = bindings[index];
      const generation = input.generations.get(participant.participant_id);
      const attemptKey = input.attempt_keys.get(participant.participant_id);
      if (!binding || generation === undefined || !attemptKey)
        throw new Error("revision retry participant binding is absent");
      const priorNativeSessions = new Set<string>();
      const history = input.prior_receipts.get(participant.participant_id) ?? [];
      if (
        history.length === 0 ||
        history.at(-1)?.start_generation !== generation - 1 ||
        history.some(
          (receipt) =>
            receipt.operation_id !== input.operation.operation_id ||
            receipt.participant_id !== participant.participant_id ||
            receipt.start_generation >= generation,
        )
      )
        throw new Error("revision retry prior lane evidence is incomplete");
      for (const receipt of history) {
        const reference = receipt.private_native_session_ref ?? receipt.private_process_lease_ref;
        const producer =
          receipt.private_native_session_producer_receipt_digest ??
          receipt.private_process_lease_producer_receipt_digest;
        if (
          !reference &&
          !producer &&
          (receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.PREPARED ||
            receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.EFFECT_IN_PROGRESS)
        )
          continue;
        if (
          !reference &&
          !producer &&
          receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED
        ) {
          const authority = readRevisionStartAuthority({
            reader: this.adapter.startAuthority,
            attemptKey: receipt.attempt_key,
            participant,
          });
          if (
            authority?.outcome !== ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT ||
            authority.native_session_id !== null
          )
            throw new Error("revision retry failed-lane absence proof changed");
          continue;
        }
        if (!reference || !producer)
          throw new Error("revision retry prior lane authority is absent");
        const evidence = this.evidence.read(reference, producer);
        const authority = readRevisionStartAuthority({
          reader: this.adapter.startAuthority,
          attemptKey: receipt.attempt_key,
          participant,
        });
        if (
          !evidence ||
          evidence.operation_id !== input.operation.operation_id ||
          evidence.participant_id !== participant.participant_id ||
          evidence.start_generation !== receipt.start_generation ||
          evidence.attempt_key !== receipt.attempt_key ||
          !authority ||
          authority.record_digest !== evidence.adapter_evidence_ref ||
          (receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED &&
            authority.outcome !== ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT)
        )
          throw new Error("revision retry private lane evidence changed");
        if (evidence.native_session_id) priorNativeSessions.add(evidence.native_session_id);
      }
      if (
        binding.resolved.engine !== participant.engine ||
        binding.resolved.model !== participant.model ||
        Buffer.byteLength(sharedPrompt, "utf8") > participant.max_shared_prompt_bytes
      )
        throw new Error("revision retry participant authority changed");
      const controller = new AbortController();
      try {
        const handle = this.adapter.start({
          attemptId: attemptKey,
          spawn: createSpawnOptionsProjection({
            ...binding.spawn,
            sessionMode: ENGINE_SESSION_MODE.FRESH,
            rendered_prompt: `${binding.spawn.rendered_prompt.trimEnd()}\n\n${sharedPrompt}\n`,
          }),
          signal: controller.signal,
        });
        active.set(participant.participant_id, { handle, controller });
        return handle.completion
          .then(async (result): Promise<InternalRevisionLaneRetryResultV1> => {
            const observedAt = input.now();
            const resume = handle.readResumeBinding();
            const adapterEvidence = handle.readEvidenceBinding();
            const startAuthority = readRevisionStartAuthority({
              reader: this.adapter.startAuthority,
              attemptKey,
              participant,
            });
            const outcome = classifyRevisionLaneRetryResult({
              participant,
              attemptKey,
              result,
              resume,
              adapterEvidence,
              startAuthority,
              priorNativeSessionIds: priorNativeSessions,
            });
            const accepted = outcome === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED;
            if (!accepted) await terminatePeers(participant.participant_id);
            const stored = startAuthority
              ? this.evidence.write({
                  root_session_id: input.operation.root_session_id,
                  operation_id: input.operation.operation_id,
                  participant_id: participant.participant_id,
                  start_generation: generation,
                  attempt_key: attemptKey,
                  native_session_id: resume?.nativeSessionId ?? null,
                  adapter_evidence_ref: startAuthority.record_digest,
                  reconciliation_mode: participant.reconciliation_mode,
                  adapter_reference_utf8: startAuthority.evidence_ref,
                  absence_proved:
                    startAuthority.outcome === ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT,
                  recorded_at: observedAt,
                })
              : null;
            return {
              participant_id: participant.participant_id,
              start_generation: generation,
              attempt_key: attemptKey,
              outcome,
              private_evidence_ref: stored?.ref ?? null,
              private_evidence_digest: stored?.digest ?? null,
              observed_at: observedAt,
              resume,
            };
          })
          .finally(() => {
            active.delete(participant.participant_id);
          });
      } catch {
        void terminatePeers(participant.participant_id);
        const authority = readRevisionStartAuthority({
          reader: this.adapter.startAuthority,
          attemptKey,
          participant,
        });
        const stored = authority
          ? this.evidence.write({
              root_session_id: input.operation.root_session_id,
              operation_id: input.operation.operation_id,
              participant_id: participant.participant_id,
              start_generation: generation,
              attempt_key: attemptKey,
              native_session_id: null,
              adapter_evidence_ref: authority.record_digest,
              reconciliation_mode: participant.reconciliation_mode,
              adapter_reference_utf8: authority.evidence_ref,
              absence_proved: authority.outcome === ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT,
              recorded_at: input.now(),
            })
          : null;
        return Promise.resolve({
          participant_id: participant.participant_id,
          start_generation: generation,
          attempt_key: attemptKey,
          outcome:
            authority?.outcome === ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT
              ? PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED
              : PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN,
          private_evidence_ref: stored?.ref ?? null,
          private_evidence_digest: stored?.digest ?? null,
          observed_at: input.now(),
          resume: undefined,
        });
      }
    });
    try {
      const settled = await Promise.all(starts);
      const allAccepted = settled.every(
        ({ outcome }) => outcome === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED,
      );
      if (allAccepted && settled.some((result) => !result.resume))
        throw new Error("accepted retry lane lost its resume binding");
      return settled.map(({ resume: _resume, ...result }) => ({
        ...result,
        outcome:
          !allAccepted && result.outcome === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED
            ? PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN
            : result.outcome,
      }));
    } finally {
      await Promise.all(
        [...active.values()].map(async ({ handle, controller }) => {
          controller.abort("revision retry authority closed");
          await handle.terminate("revision retry authority closed").catch(() => undefined);
        }),
      );
      this.active.delete(input.operation.operation_id);
    }
  }

  isQuiescent(operationId: string): boolean {
    return (this.active.get(operationId)?.size ?? 0) === 0;
  }
}

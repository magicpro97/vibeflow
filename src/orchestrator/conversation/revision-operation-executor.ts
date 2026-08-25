import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { BindingAuthoritySnapshot } from "./artifact-validation.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ContextHandoffV1 } from "./handoff-types.js";
import type { LineageActionPlanBindingV1 } from "./lineage-action-authority.js";
import { publishedRevisionAuthorityMap } from "./lineage-published-transition.js";
import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { type RevisionCrashPointV1, runRevisionCrashFault } from "./revision-crash-fault.js";
import {
  ConversationRevisionConflictError,
  ConversationRevisionCorruptError,
} from "./revision-errors.js";
import { foldRevisionOperation } from "./revision-fold.js";
import { runOwnedRevisionStart } from "./revision-owned-start-runtime.js";
import {
  type RevisionOperationEventV1,
  materializeRevisionEvent,
  materializeRevisionHead,
} from "./revision-planner.js";
import { reconcilePublishedRevisionReservation } from "./revision-reservation-reconciliation.js";
import * as revisionStart from "./revision-start-finalizer.js";
import {
  RevisionStartOwnerAuthority,
  type RevisionStartOwnerTokenV1,
} from "./revision-start-owner.js";
import { materializeRevisionStateTransition } from "./revision-state-transition.js";
import type { ConversationRuntime } from "./runtime.js";
import { readConversationSourceInventory } from "./source-inventory.js";
import type { ConversationCreateResult, ConversationManifest, MessageRequest } from "./types.js";

export interface PreparedConversationRevisionV1 {
  operation: RevisionOperationV1;
  revisionPlan: RevisionPreparationPlanV1;
  reservation: RevisionReservationRecordV1;
  actionPlan: LineageActionPlanBindingV1;
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  manifest: ConversationManifest;
  bindings: MaterializedAgentBinding[];
  bindingAuthorities: BindingAuthoritySnapshot[];
  manifestRecordDigest: string;
  handoff: ContextHandoffV1;
  sharedPrompt: string;
  request: (MessageRequest & { target_participants: "all" | string[] }) | null;
  messageKey: string;
  priorPublished: readonly PublishedRevisionTransitionInputV1[];
}

export interface ConversationRevisionExecutorOptions {
  runtime: ConversationRuntime;
  artifactStore: ConversationArtifactStore;
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
  schedule(task: () => void): void;
  executeConfigured(
    manifest: ConversationManifest,
    operationId: string,
  ): Promise<ConversationCreateResult>;
  revisionFault?(point: RevisionCrashPointV1): void;
}

export class ConversationRevisionOperationExecutor {
  private readonly startOwners: RevisionStartOwnerAuthority;

  constructor(private readonly options: ConversationRevisionExecutorOptions) {
    this.startOwners = new RevisionStartOwnerAuthority(options.artifactRoot);
  }

  private append(
    operation: RevisionOperationV1,
    event: RevisionOperationEventV1,
  ): RevisionOperationEventV1 {
    this.options.home.revisions.appendEvent(operation, event);
    return event;
  }

  private ensurePreparing(operation: RevisionOperationV1): RevisionOperationEventV1[] {
    const events = this.options.home.revisions.readEvents(operation.operation_id);
    if (events.length === 0)
      events.push(
        this.append(
          operation,
          materializeRevisionStateTransition(operation, events, "created", "preparing"),
        ),
      );
    if (foldRevisionOperation(operation, events).state !== "preparing") return events;
    return events;
  }

  private dispatch(
    prepared: PreparedConversationRevisionV1,
    events: RevisionOperationEventV1[],
  ): ActionDispatchRecordV1 {
    const first = events[0];
    if (!first) throw new ConversationRevisionCorruptError("revision sequence zero is absent");
    this.options.home.actions.bindHeader(
      prepared.proposal.proposal_id,
      prepared.operation.header_digest,
    );
    return this.options.home.actions.dispatch(
      prepared.proposal.proposal_id,
      prepared.approval.approval_id,
      { digest: first.event_digest, recorded_at: first.recorded_at },
    );
  }

  abandon(prepared: PreparedConversationRevisionV1, reasonCode: string): void {
    let events = this.options.home.revisions.readEvents(prepared.operation.operation_id);
    const state = foldRevisionOperation(prepared.operation, events).state;
    if (state === "preparing" || state === "prepared") {
      events = [
        ...events,
        this.append(
          prepared.operation,
          materializeRevisionEvent(
            prepared.operation,
            events,
            {
              kind: "state-transition",
              from: state,
              to: "abandoned",
              authorized_by_action_operation_id: prepared.operation.operation_id,
              effect_action_operation_id: prepared.operation.operation_id,
              action_terminals: [
                {
                  action_operation_id: prepared.operation.operation_id,
                  outcome: "failed",
                  reason_code: reasonCode,
                },
              ],
              reason_code: reasonCode,
            },
            prepared.operation.created_at,
          ),
        ),
      ];
    }
    this.options.runtime.finish(prepared.manifest.conversation_id);
    this.options.home.actions.terminal(
      prepared.proposal.proposal_id,
      prepared.operation.operation_id,
      {
        outcome: "failed",
        digest: events.at(-1)?.event_digest ?? prepared.operation.header_digest,
        recorded_at: prepared.operation.created_at,
      },
    );
  }

  private async prepareChild(prepared: PreparedConversationRevisionV1): Promise<void> {
    this.options.artifactStore.prepareRevision(prepared.manifest, prepared.bindingAuthorities, {
      operation_id: prepared.operation.operation_id,
      manifest_record_digest: prepared.manifestRecordDigest,
      updated_at: prepared.operation.created_at,
    });
    if (!this.options.runtime.operationId(prepared.manifest.conversation_id)) {
      this.options.runtime.begin(
        prepared.manifest,
        prepared.bindings,
        [],
        false,
        0,
        prepared.operation.operation_id,
        false,
        prepared.sharedPrompt,
      );
    }
    try {
      await this.options.runtime.configure(prepared.manifest.conversation_id);
      if (prepared.request)
        await this.options.runtime.userMessage(
          prepared.manifest.conversation_id,
          prepared.request,
          `revision-message:${prepared.messageKey}`,
        );
    } catch (error) {
      this.options.runtime.finish(prepared.manifest.conversation_id);
      throw error;
    }
  }

  async execute(
    prepared: PreparedConversationRevisionV1,
    priorHead: Parameters<typeof materializeRevisionHead>[0],
  ): Promise<{ childId: string; committedHere: boolean }> {
    let events = this.ensurePreparing(prepared.operation);
    const dispatch = this.dispatch(prepared, events);
    await this.prepareChild(prepared);
    if (foldRevisionOperation(prepared.operation, events).state === "preparing") {
      events = [
        ...events,
        this.append(
          prepared.operation,
          materializeRevisionStateTransition(prepared.operation, events, "preparing", "prepared"),
        ),
      ];
    }
    runRevisionCrashFault(this.options.revisionFault, "after-prepared");
    const committedHead = materializeRevisionHead(priorHead, prepared.operation);
    if (foldRevisionOperation(prepared.operation, events).state === "prepared") {
      events = [
        ...events,
        this.append(
          prepared.operation,
          materializeRevisionEvent(
            prepared.operation,
            events,
            {
              kind: "head-commit",
              authorized_by_action_operation_id: prepared.operation.operation_id,
              effect_action_operation_id: prepared.operation.operation_id,
              prior_head_digest: priorHead.content_digest,
              prior_head_checkpoint_digest: priorHead.content_digest,
              committed_head_digest: committedHead.content_digest,
              directory_fsync_completed: true,
            },
            prepared.operation.created_at,
          ),
        ),
      ];
    }
    const publicationEvents = events.slice(0, 3);
    const transition: PublishedRevisionTransitionInputV1 = {
      committed_head: committedHead,
      authority: {
        kind: "child-commit",
        prior_head: priorHead,
        reservation: prepared.reservation,
        revision_plan: prepared.revisionPlan,
        operation: prepared.operation,
        operation_events: publicationEvents,
        action_plan: prepared.actionPlan,
        proposal: prepared.proposal,
        approval: prepared.approval,
        dispatch,
      },
    };
    this.options.home.revisions.writePreparation(
      prepared.operation,
      prepared.revisionPlan,
      transition,
    );
    runRevisionCrashFault(this.options.revisionFault, "after-publication-prepared");
    const prospective = [...prepared.priorPublished, transition];
    const inventory = readConversationSourceInventory({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
      actionAuthority: this.options.home.reviewedActionAuthority(),
      includeHiddenRevisions: true,
      includeHiddenRevisionOperationIds: new Set([prepared.operation.operation_id]),
    });
    const derivation = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: prospective,
    });
    const lineage = derivation.lineages.find(
      (candidate) => candidate.root_session_id === prepared.operation.root_session_id,
    );
    if (!inventory.authoritative || !derivation.authoritative || !lineage)
      throw new ConversationRevisionCorruptError("prepared child lineage is not authoritative");
    const priorOwnerStatus = this.startOwners.status(prepared.operation.operation_id);
    const owner =
      priorOwnerStatus === "dead"
        ? this.startOwners.claimDead(prepared.operation.operation_id)
        : priorOwnerStatus === "absent"
          ? this.startOwners.acquire(prepared.operation.operation_id)
          : null;
    if (!owner) throw new ConversationRevisionConflictError("revision start is already owned");
    let committedHere = true;
    let headCommitted = false;
    let ownerTransferred = false;
    try {
      try {
        owner.assertHeld();
        this.options.home.lineage.commitHead(
          lineage,
          priorHead,
          committedHead,
          publishedRevisionAuthorityMap(prospective),
        );
      } catch (error) {
        const current = this.options.home.lineage.readHead(prepared.operation.root_session_id);
        if (current?.content_digest === priorHead.content_digest) throw error;
        if (
          current?.content_digest !== committedHead.content_digest ||
          current.updated_by_operation_id !== prepared.operation.operation_id
        ) {
          await this.options.runtime.abandon(
            prepared.manifest.conversation_id,
            "revision head CAS lost",
          );
          throw new ConversationRevisionConflictError(
            "revision head CAS lost to another operation",
            { cause: error },
          );
        }
        committedHere = false;
      }
      headCommitted = true;
      // An exact pre-existing head is recoverable only from its durable dead owner.
      if (!committedHere && priorOwnerStatus !== "dead")
        return { childId: prepared.manifest.conversation_id, committedHere };
      owner.assertHeld();
      this.options.home.revisions.publish(prepared.operation.operation_id);
      owner.assertHeld();
      this.options.artifactStore.publishRevision(
        prepared.manifest.conversation_id,
        prepared.operation.operation_id,
        prepared.operation.created_at,
      );
      owner.assertHeld();
      reconcilePublishedRevisionReservation({
        lineage: this.options.home.lineage,
        reservation: prepared.reservation,
        consumedAt: prepared.operation.created_at,
      });
      if (committedHere) {
        this.start(prepared, owner);
        ownerTransferred = true;
      } else
        revisionStart.interruptPublishedRevisionStart({
          prepared,
          home: this.options.home,
          owner,
        });
      return { childId: prepared.manifest.conversation_id, committedHere };
    } catch (error) {
      if (headCommitted)
        try {
          revisionStart.interruptPublishedRevisionStart({
            prepared,
            home: this.options.home,
            owner,
          });
        } catch {
          // Retaining the live token is safer than publishing owner absence without a terminal.
          ownerTransferred = true;
        }
      throw error;
    } finally {
      if (!ownerTransferred) owner.release();
    }
  }

  private start(prepared: PreparedConversationRevisionV1, owner: RevisionStartOwnerTokenV1): void {
    const releaseIfTerminal = () => {
      const state = foldRevisionOperation(
        prepared.operation,
        this.options.home.revisions.readEvents(prepared.operation.operation_id),
      ).state;
      if (["started", "start_failed", "needs_recovery"].includes(state)) owner.release();
    };
    let events = this.options.home.revisions.readEvents(prepared.operation.operation_id);
    try {
      if (foldRevisionOperation(prepared.operation, events).state === "published") {
        owner.assertHeld();
        events = [
          ...events,
          this.append(
            prepared.operation,
            materializeRevisionStateTransition(prepared.operation, events, "published", "starting"),
          ),
        ];
      }
      this.options.schedule(() => {
        void (async () => {
          try {
            await runOwnedRevisionStart({ prepared, options: this.options, owner });
          } finally {
            releaseIfTerminal();
          }
        })();
      });
    } catch {
      try {
        revisionStart.interruptPublishedRevisionStart({
          prepared,
          home: this.options.home,
          owner,
        });
      } finally {
        releaseIfTerminal();
      }
    }
  }
}

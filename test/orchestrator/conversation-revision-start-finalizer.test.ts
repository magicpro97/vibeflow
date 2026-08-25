import { describe, expect, test } from "bun:test";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import type { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import type { PreparedConversationRevisionV1 } from "../../src/orchestrator/conversation/revision-operation-executor.js";
import {
  type RevisionOperationEventV1,
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import {
  finalizePublishedRevisionStart,
  reconcilePublishedRevisionStartTerminal,
  recoverInterruptedPublishedRevisionStart,
  retryPublishedRevisionStart,
} from "../../src/orchestrator/conversation/revision-start-finalizer.js";
import type { RevisionStartOwnerAuthority } from "../../src/orchestrator/conversation/revision-start-owner.js";
import type { ConversationRuntime } from "../../src/orchestrator/conversation/runtime.js";

const createdAt = "2026-08-25T00:00:00.000Z";
const terminalAt = "2026-08-25T00:00:05.000Z";
const operationId = `vf-operation-${"1".repeat(64)}`;
const proposalId = `vf-proposal-${"2".repeat(64)}`;
const retryOperationId = `vf-operation-${"4".repeat(64)}`;
const digest = (label: string) => digestV1("REVISION-START-FINALIZER-TEST\0v1\0", { label });
const owner = { assertHeld() {}, release() {} };

function operation() {
  return materializeRevisionOperation({
    operation_id: operationId,
    proposal_id: proposalId,
    proposal_digest: digest("proposal"),
    approval_id: `vf-approval-${"3".repeat(64)}`,
    approval_digest: digest("approval"),
    plan_digest: digest("plan"),
    authority_epoch: 0,
    authority_head_digest: digest("authority"),
    root_session_id: "conversation-root",
    parent: {
      conversation_id: "conversation-root",
      revision_id: "revision-root",
      revision_ordinal: 0,
    },
    child: {
      conversation_id: "conversation-child",
      revision_id: "revision-child",
      revision_ordinal: 1,
    },
    expected_head_digest: digest("head"),
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    revision_claim_epoch: 1,
    expected_parent_last_seq: 1,
    expected_parent_lock_digest: digest("lock"),
    permission_digest: digest("permission"),
    binding_set_digest: digest("bindings"),
    handoff_digest: digest("handoff"),
    handoff_selection_digest: digest("selection"),
    prompt_projection_digest: digest("prompt"),
    created_at: createdAt,
  });
}

function startingPrefix(target: ReturnType<typeof operation>): RevisionOperationEventV1[] {
  const events: RevisionOperationEventV1[] = [];
  const append = (payload: RevisionOperationEventV1["payload"], recordedAt = createdAt): void => {
    events.push(materializeRevisionEvent(target, events, payload, recordedAt));
  };
  append({
    kind: "state-transition",
    from: "created",
    to: "preparing",
    authorized_by_action_operation_id: operationId,
    effect_action_operation_id: operationId,
    action_terminals: [],
    reason_code: null,
  });
  append({
    kind: "state-transition",
    from: "preparing",
    to: "prepared",
    authorized_by_action_operation_id: operationId,
    effect_action_operation_id: operationId,
    action_terminals: [],
    reason_code: null,
  });
  append({
    kind: "head-commit",
    authorized_by_action_operation_id: operationId,
    effect_action_operation_id: operationId,
    prior_head_digest: target.expected_head_digest,
    prior_head_checkpoint_digest: target.expected_head_digest,
    committed_head_digest: digest("child-head"),
    directory_fsync_completed: true,
  });
  append(
    {
      kind: "state-transition",
      from: "published",
      to: "starting",
      authorized_by_action_operation_id: operationId,
      effect_action_operation_id: operationId,
      action_terminals: [],
      reason_code: null,
    },
    terminalAt,
  );
  return events;
}

describe("revision start finalization", () => {
  test("replay reconciles the exact durable terminal after two Action Authority failures", async () => {
    const target = operation();
    const events = startingPrefix(target);
    const terminalPayload = {
      kind: "state-transition" as const,
      from: "starting" as const,
      to: "started" as const,
      authorized_by_action_operation_id: operationId,
      effect_action_operation_id: operationId,
      action_terminals: [
        {
          action_operation_id: operationId,
          outcome: "succeeded" as const,
          reason_code: null,
        },
      ],
      reason_code: null,
    };
    const expectedTerminal = materializeRevisionEvent(target, events, terminalPayload, terminalAt);
    let appended = 0;
    let finalized = 0;
    let executed = 0;
    let actionState = "committing";
    const terminalCalls: Array<{
      proposalId: string;
      operationId: string;
      terminal: { outcome: string; digest: string; recorded_at: string };
    }> = [];
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        appendEvent: (_operation: typeof target, event: RevisionOperationEventV1) => {
          appended += 1;
          events.push(structuredClone(event));
        },
      },
      revisionLanes: {
        finalize: () => {
          finalized += 1;
          return "started" as const;
        },
      },
      actions: {
        terminal: (
          receivedProposalId: string,
          receivedOperationId: string,
          terminal: { outcome: string; digest: string; recorded_at: string },
        ) => {
          terminalCalls.push({
            proposalId: receivedProposalId,
            operationId: receivedOperationId,
            terminal: structuredClone(terminal),
          });
          if (terminalCalls.length <= 2) throw new Error("injected Action Authority failure");
          actionState = "succeeded";
        },
      },
    } as unknown as ConversationHomeAuthorities;
    const prepared = {
      operation: target,
      proposal: { proposal_id: proposalId },
      revisionPlan: {},
    } as unknown as PreparedConversationRevisionV1;
    const input = {
      prepared,
      resultStatus: "completed" as const,
      home,
      artifactStore: {} as ConversationArtifactStore,
      owner,
    };

    expect(() => finalizePublishedRevisionStart(input)).toThrow(
      "injected Action Authority failure",
    );
    expect(actionState).toBe("committing");
    expect(events.at(-1)).toEqual(expectedTerminal);
    expect(foldRevisionOperation(target, events).state).toBe("started");

    expect(
      await retryPublishedRevisionStart(prepared, {
        home,
        artifactStore: input.artifactStore,
        owner,
        executeConfigured: async () => {
          executed += 1;
          return {};
        },
      }),
    ).toBeTrue();
    finalizePublishedRevisionStart(input);

    expect(actionState).toBe("succeeded");
    expect(executed).toBe(1);
    expect(appended).toBe(1);
    expect(finalized).toBe(1);
    expect(events).toHaveLength(5);
    expect(terminalCalls).toHaveLength(4);
    expect(terminalCalls).toEqual(
      Array.from({ length: 4 }, () => ({
        proposalId,
        operationId,
        terminal: {
          outcome: "succeeded",
          digest: expectedTerminal.event_digest,
          recorded_at: terminalAt,
        },
      })),
    );
  });

  test("replay never borrows a later retry action terminal", () => {
    const target = operation();
    const events = startingPrefix(target);
    const originalTerminal = materializeRevisionEvent(
      target,
      events,
      {
        kind: "state-transition",
        from: "starting",
        to: "start_failed",
        authorized_by_action_operation_id: operationId,
        effect_action_operation_id: operationId,
        action_terminals: [
          {
            action_operation_id: operationId,
            outcome: "failed",
            reason_code: "child_start_failed",
          },
        ],
        reason_code: "child_start_failed",
      },
      terminalAt,
    );
    events.push(originalTerminal);
    events.push(
      materializeRevisionEvent(
        target,
        events,
        {
          kind: "state-transition",
          from: "start_failed",
          to: "starting",
          authorized_by_action_operation_id: retryOperationId,
          effect_action_operation_id: retryOperationId,
          action_terminals: [],
          reason_code: null,
        },
        "2026-08-25T00:00:06.000Z",
      ),
    );
    const retryTerminal = materializeRevisionEvent(
      target,
      events,
      {
        kind: "state-transition",
        from: "starting",
        to: "started",
        authorized_by_action_operation_id: retryOperationId,
        effect_action_operation_id: retryOperationId,
        action_terminals: [
          {
            action_operation_id: retryOperationId,
            outcome: "succeeded",
            reason_code: null,
          },
        ],
        reason_code: null,
      },
      "2026-08-25T00:00:07.000Z",
    );
    events.push(retryTerminal);
    const terminals: Array<{ outcome: string; digest: string; recorded_at: string }> = [];
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        appendEvent: () => {
          throw new Error("replay appended a duplicate terminal");
        },
      },
      revisionLanes: {
        finalize: () => {
          throw new Error("replay reopened the terminal lane");
        },
      },
      actions: {
        terminal: (
          _proposalId: string,
          _operationId: string,
          terminal: (typeof terminals)[number],
        ) => terminals.push(structuredClone(terminal)),
      },
    } as unknown as ConversationHomeAuthorities;

    finalizePublishedRevisionStart({
      prepared: {
        operation: target,
        proposal: { proposal_id: proposalId },
      } as unknown as PreparedConversationRevisionV1,
      resultStatus: "completed",
      home,
      artifactStore: {} as ConversationArtifactStore,
      owner,
    });

    expect(foldRevisionOperation(target, events).state).toBe("started");
    expect(terminals).toEqual([
      {
        outcome: "failed",
        digest: originalTerminal.event_digest,
        recorded_at: originalTerminal.recorded_at,
      },
    ]);
    expect(terminals[0]?.digest).not.toBe(retryTerminal.event_digest);
  });

  test("a lost owner token cannot finalize lanes or append a terminal", () => {
    const target = operation();
    const events = startingPrefix(target);
    let laneCalls = 0;
    let appends = 0;
    let terminals = 0;
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        appendEvent: () => {
          appends += 1;
        },
      },
      revisionLanes: {
        finalize: () => {
          laneCalls += 1;
          return "started" as const;
        },
      },
      actions: {
        terminal: () => {
          terminals += 1;
        },
      },
    } as unknown as ConversationHomeAuthorities;

    expect(() =>
      finalizePublishedRevisionStart({
        prepared: {
          operation: target,
          proposal: { proposal_id: proposalId },
          revisionPlan: {},
        } as unknown as PreparedConversationRevisionV1,
        resultStatus: "completed",
        home,
        artifactStore: {} as ConversationArtifactStore,
        owner: {
          assertHeld: () => {
            throw new Error("revision start owner was lost");
          },
          release() {},
        },
      }),
    ).toThrow("revision start owner was lost");
    expect(laneCalls).toBe(0);
    expect(appends).toBe(0);
    expect(terminals).toBe(0);
    expect(events).toHaveLength(4);
  });

  test("a proven dead owner closes to needs_recovery without replaying lanes or effects", async () => {
    const target = operation();
    const events = startingPrefix(target);
    let reservation = materializeRevisionReservation(target);
    let ownerAssertions = 0;
    let ownerReleases = 0;
    let revisionPublishes = 0;
    let artifactPublishes = 0;
    let laneCalls = 0;
    let terminalCalls = 0;
    const recoveryOwner = {
      assertHeld: () => {
        ownerAssertions += 1;
      },
      release: () => {
        ownerReleases += 1;
      },
    };
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        publish: () => {
          revisionPublishes += 1;
        },
        appendEvent: (_operation: typeof target, event: RevisionOperationEventV1) => {
          events.push(structuredClone(event));
        },
      },
      lineage: {
        readReservation: () => structuredClone(reservation),
        readReservationHistory: () => new Map(),
        commitReservation: (_prior: typeof reservation, next: typeof reservation) => {
          reservation = structuredClone(next);
        },
      },
      revisionLanes: {
        finalize: () => {
          laneCalls += 1;
          throw new Error("recovery replayed a lane");
        },
      },
      actions: {
        terminal: () => {
          terminalCalls += 1;
          if (terminalCalls <= 2) throw new Error("injected recovery mirror failure");
        },
      },
    } as unknown as ConversationHomeAuthorities;
    await expect(
      recoverInterruptedPublishedRevisionStart({
        operation: target,
        revisionPlan: {
          root_session_id: target.root_session_id,
          parent: target.parent,
        } as PreparedConversationRevisionV1["revisionPlan"],
        reservation,
        proposalId,
        runtime: {
          operationOwnerState: () => "absent",
        } as unknown as ConversationRuntime,
        home,
        artifactStore: {
          publishRevision: () => {
            artifactPublishes += 1;
          },
        } as unknown as ConversationArtifactStore,
        startOwners: {
          claimDead: () => recoveryOwner,
        } as unknown as RevisionStartOwnerAuthority,
      }),
    ).rejects.toThrow("injected recovery mirror failure");

    expect(
      reconcilePublishedRevisionStartTerminal({ operation: target, proposalId, home }),
    ).toBeTrue();
    expect(foldRevisionOperation(target, events).state).toBe("needs_recovery");
    expect(events.filter((event) => event.payload.kind === "participant-start")).toHaveLength(0);
    expect(laneCalls).toBe(0);
    expect(revisionPublishes).toBe(1);
    expect(artifactPublishes).toBe(1);
    expect(reservation.status).toBe("consumed");
    expect(ownerAssertions).toBeGreaterThanOrEqual(4);
    expect(ownerReleases).toBe(1);
    expect(terminalCalls).toBe(3);
  });
});

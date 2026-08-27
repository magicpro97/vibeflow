const { describe, expect, test } = await import(String("bun:test"));
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
} from "../../../actions/public-operation-contract.js";
import {
  assertUniqueSorted,
  nullableShortText,
} from "../conversation-home-action-boundary-shared.js";
import {
  parseHomeActionViewResponse,
  parseHomeTimelineResponse,
} from "../conversation-home-action-boundary.js";
import {
  parseActionOperation,
  parseActionTargetBinding,
} from "../conversation-home-action-operation-boundary.js";
import { parsePreview } from "../conversation-home-action-preview-boundary.js";
import { parseActionProposal } from "../conversation-home-action-proposal-boundary.js";
import { watchHomeOperation } from "../conversation-home-operation-stream.js";
import { ActivationEpoch, ActivationResourceRegistry } from "../conversation-home-state.js";
import type { HomeActionView } from "../conversation-home-types.js";
import {
  approval,
  at,
  deniedOperation,
  digest,
  id,
  needsRecoveryOperation,
  preview,
  progress,
  proposal,
  succeededOperation,
  target,
} from "./ui-action-boundary-coverage-last.fixtures.js";
import { exerciseCapturedHomeStreamAuthority } from "./ui-action-boundary-stream-coverage-last.fixtures.js";

describe("last Home action boundary coverage", () => {
  test("accepts rich canonical action contracts and all disposition families", () => {
    expect(nullableShortText(null)).toBeTrue();
    expect(nullableShortText("bounded")).toBeTrue();
    expect(() => assertUniqueSorted(["a", "b"], "ordered")).not.toThrow();
    expect(() => assertUniqueSorted(["b", "a"], "ordered")).toThrow("ordered");
    expect(parsePreview(preview(), "capability.install").health_plan).toHaveLength(1);
    expect(() => parseActionTargetBinding(target(false))).not.toThrow();
    expect(() =>
      parseActionTargetBinding({
        ...target(),
        subject: { kind: "future", package_id: "acme/tool", component_id: "component-a" },
      }),
    ).toThrow(/subject kind/i);
    expect(
      parseActionProposal(proposal("c", "conversation.add_participant", "conversation")).domain,
    ).toBe("conversation");
    const approved = {
      schema_version: "1.0",
      proposal: proposal("a"),
      approval: approval("a", "approved"),
      operation: succeededOperation("a"),
    };
    expect(parseHomeActionViewResponse(approved).operation.targets[0]?.outcome).toBe("applied");
    const denied = {
      schema_version: "1.0",
      proposal: proposal("b"),
      approval: approval("b", "denied"),
      operation: deniedOperation("b"),
    };
    expect(parseHomeActionViewResponse(denied).operation.state).toBe("denied");
    const failed = {
      ...succeededOperation("f"),
      state: "failed",
      phase_sequence: 1,
      progress: [
        progress(
          0,
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
        ),
        progress(
          1,
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
          PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
        ),
      ],
      targets: [],
      delivery: "failed",
      error: {
        code: "pre_effect_refused",
        message: "The approved capability action was refused because a pre-effect check changed.",
        correlation_id: id("correlation", "f"),
        retryable: false,
        recovery_action: "refresh-proposal",
        details: {
          operation_id: id("operation", "f"),
          reason_code: "policy-stale",
          frontier_kind: "operation",
        },
      },
      recovery_actions: ["refresh-proposal"],
      updated_at: at(3),
    };
    expect(parseActionOperation(failed).error?.code).toBe("pre_effect_refused");
    expect(parseActionOperation(needsRecoveryOperation()).state).toBe("needs_recovery");
  });

  test("normalizes revision boundaries and conversation events", () => {
    const page = {
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      proposal_set_watermark: digest("a"),
    };
    const node = {
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      revision_ordinal: 0,
    };
    const result = parseHomeTimelineResponse({
      schema_version: "1.0",
      root_session_id: "root-a",
      head: node,
      head_epoch: 1,
      head_digest: digest("b"),
      items: [
        {
          kind: "revision-boundary",
          boundary_id: "boundary-a",
          from: node,
          to: {
            ...node,
            conversation_id: "conversation-b",
            revision_id: "revision-b",
            revision_ordinal: 1,
          },
          handoff_id: "handoff-a",
          prompt_projection_digest: digest("c"),
        },
        {
          kind: "conversation-event",
          revision_ordinal: 1,
          event: {},
          interaction: {},
          action_operations: page,
        },
      ],
      next_cursor: null,
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "revision-boundary",
      "conversation-event",
    ]);
  });
});

test("operation stream rejects a replay target absent from the current aggregate", () => {
  type Listener = (event: Event) => void;
  class FakeEventSource {
    static instance: FakeEventSource;
    private listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) {
      FakeEventSource.instance = this;
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, value: unknown, lastEventId: string) {
      const event = new MessageEvent(type, { data: JSON.stringify(value), lastEventId });
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    close() {}
  }
  const epoch = new ActivationEpoch();
  const token = epoch.begin("root-a");
  const streams = new ActivationResourceRegistry<EventSource>();
  const current = {
    ...succeededOperation("d"),
    state: "succeeded",
    phase_sequence: 1,
    progress: succeededOperation("d").progress.slice(0, 2),
    targets: [{ ...target(), target_id: "target-other" }],
    updated_at: at(3),
  };
  let invalid = 0;
  try {
    watchHomeOperation(
      {
        token,
        conversationId: "conversation-a",
        view: {
          proposal: proposal("d"),
          operation: { ...current, state: "committing" },
        } as unknown as HomeActionView,
        streams,
        operationFor: () => current as unknown as HomeActionView["operation"],
        reload: async () => {},
        invalidUpdate: () => {
          invalid += 1;
        },
      },
      {
        eventSourceConstructor: FakeEventSource as unknown as new (url: string) => EventSource,
        operationEventsUrl: () => "/operation-events",
      },
    );
    const binding = target();
    const update = {
      schema_version: "1.0",
      operation_id: current.operation_id,
      phase_sequence: 1,
      state: current.state,
      progress: current.progress[1],
      target: { ...binding, outcome: "applied", health: "ready", evidence_digest: digest("e") },
      error: null,
      occurred_at: at(3),
      event_cursor: current.latest_event_cursor,
    };
    FakeEventSource.instance.emit("operation", update, current.latest_event_cursor);
    expect(invalid).toBe(1);
  } finally {
    streams.close();
    epoch.close();
  }
});

test("query runtime streams queued work and reloads from a newer snapshot", async () => {
  expect(await exerciseCapturedHomeStreamAuthority()).toEqual({
    instanceCount: 1,
    headCalls: 2,
    parsedLastSeq: 2,
    operationStateAccepted: true,
    terminalQueueStreams: true,
  });
});

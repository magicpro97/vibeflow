import { expect, test } from "bun:test";
import { digestV1 } from "../../src/durability/index.js";
import {
  StaleTimelineCursorError,
  TimelineCursorCodec,
} from "../../src/orchestrator/conversation/catalog-timeline-cursor.js";
import { createInitialLineageHead } from "../../src/orchestrator/conversation/lineage-types.js";
import {
  ConversationTimelineService,
  TimelineHeadUnresolvedError,
} from "../../src/orchestrator/conversation/timeline-service.js";
import type { InternalTraceStoreRecord } from "../../src/orchestrator/trace/types.js";

const ISO = "2026-08-25T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function record(
  id: string,
  revision: string,
  seq: number,
  event: unknown,
): InternalTraceStoreRecord {
  return {
    stored_event: {
      workflow_id: "workflow",
      conversation_id: id,
      revision_id: revision,
      run_id: `run-${id}`,
      turn_id: `turn-${seq}`,
      operation_id: `operation-${seq}`,
      attempt_id: `attempt-${seq}`,
      event_id: `event-${id}-${seq}`,
      seq,
      ts: `2026-08-25T00:00:0${seq}.000Z`,
      idempotency_key: `${id}:${seq}`,
      event: event as never,
    },
    native_session_id: null,
  };
}

function node(
  id: string,
  ordinal: number,
  parent: string | null,
  events: InternalTraceStoreRecord[],
) {
  const revision = `revision-${id}`;
  return {
    node: { conversation_id: id, revision_id: revision, revision_ordinal: ordinal },
    root_session_id: "root",
    parent:
      parent === null
        ? null
        : {
            conversation_id: parent,
            revision_id: `revision-${parent}`,
            revision_ordinal: ordinal - 1,
          },
    manifest_digest: DIGEST,
    ancestry_digest: DIGEST,
    source: {
      manifest: {
        version: "1.0",
        conversation_id: id,
        workflow_id: "workflow",
        revision_id: revision,
        run_id: `run-${id}`,
        parent_conversation_id: parent,
        parent_revision_id: parent ? `revision-${parent}` : null,
        topic: id,
        policy: "direct",
        max_rounds: 1,
        baseline_enabled: true,
        evaluator_auto_added: false,
        repo_root: "/private/repo",
        phase: 1,
        task_text: "private",
        bindings: [],
        created_at: ISO,
      },
      manifest_record: { child_revisions: {} },
      manifest_digest: DIGEST,
      journal_head: {
        schema_version: "1.0",
        record_id: id,
        record_digest: DIGEST,
        last_seq: events.at(-1)?.stored_event.seq ?? 0,
        updated_at: events.at(-1)?.stored_event.ts ?? ISO,
        lifecycle: "ACTIVE",
        health: "healthy",
        participants: [],
      },
      journal_records: events,
    },
  } as any;
}

function resolved(headOverride?: any) {
  const rootEvents = [
    record("root", "revision-root", 1, {
      type: "conversation_configured",
      payload: { topic: "root", participants: [], policy: "direct", max_rounds: 1 },
    }),
    record("root", "revision-root", 2, {
      type: "user_message",
      payload: { content: "hello", target_participants: "all" },
    }),
    record("root", "revision-root", 3, {
      type: "capability_action_projection",
      payload: { private: "must-not-be-base-timeline" },
    }),
  ];
  const childEvents = [
    record("child", "revision-child", 1, {
      type: "conversation_configured",
      payload: { topic: "child", participants: [], policy: "direct", max_rounds: 1 },
    }),
  ];
  const root = node("root", 0, null, rootEvents);
  const child = node("child", 1, "root", childEvents);
  const head =
    headOverride ??
    createInitialLineageHead("root", [
      {
        node: child.node,
        manifest_digest: child.manifest_digest,
        ancestry_digest: child.ancestry_digest,
        updated_at: child.source.journal_head.updated_at,
      },
    ]);
  return {
    inventory: {},
    derivation: {},
    lineage: { root_session_id: "root", nodes: [root, child] },
    requested: root,
    head,
    revision_claim_epoch: 0,
    selected_nodes: [root, child],
  } as any;
}

const artifactRegistry = {
  register: () => `vf-artifact-${"b".repeat(64)}` as any,
  resolve: () => null,
};

test("root timeline orders boundaries, starts and semantic revision events without projection tails", async () => {
  const codec = new TimelineCursorCodec(Buffer.alloc(32, 6));
  const lineage = { resolve: () => resolved() };
  const service = new ConversationTimelineService({
    scopeId: "project:test",
    cursorCodec: codec,
    lineage: lineage as any,
    artifactRegistry,
    boundary(from, to) {
      return {
        from,
        to,
        handoff_id: `vf-handoff-${"c".repeat(64)}`,
        prompt_projection_digest: `sha256:${"d".repeat(64)}`,
      };
    },
  });
  const first = await service.read("root", { limit: 3 });
  expect(first.items.map((item) => item.kind)).toEqual([
    "conversation-start",
    "conversation-event",
    "conversation-event",
  ]);
  expect(JSON.stringify(first)).not.toContain("must-not-be-base-timeline");
  expect(first.next_cursor).not.toBeNull();
  const second = await service.read("root", { limit: 3, cursor: first.next_cursor as string });
  expect(second.items.map((item) => item.kind)).toEqual([
    "revision-boundary",
    "conversation-start",
    "conversation-event",
  ]);
  expect(second.next_cursor).toBeNull();
  expect(second.head).toEqual({
    conversation_id: "child",
    revision_id: "revision-child",
    revision_ordinal: 1,
  });
});

test("timeline cursor is limit-bound and a head change returns an exact stale restart", async () => {
  const codec = new TimelineCursorCodec(Buffer.alloc(32, 7));
  const firstService = new ConversationTimelineService({
    scopeId: "project:test",
    cursorCodec: codec,
    lineage: { resolve: () => resolved() } as any,
    artifactRegistry,
    boundary: (from, to) => ({
      from,
      to,
      handoff_id: `vf-handoff-${"c".repeat(64)}`,
      prompt_projection_digest: `sha256:${"d".repeat(64)}`,
    }),
  });
  const page = await firstService.read("root", { limit: 1 });
  await expect(
    firstService.read("root", { limit: 2, cursor: page.next_cursor as string }),
  ).rejects.toThrow("request changed");

  const prior = resolved().head;
  const { content_digest: _priorContentDigest, ...priorPreimage } = prior;
  const changedPreimage = {
    ...priorPreimage,
    head_epoch: 1,
    previous_head_digest: prior.content_digest,
    updated_by_operation_id: `vf-operation-${"e".repeat(64)}`,
    updated_at: "2026-08-25T00:01:00.000Z",
  };
  const changed = {
    ...changedPreimage,
    content_digest: digestV1("VF-LINEAGE-HEAD\0v1\0", changedPreimage),
  };
  const changedService = new ConversationTimelineService({
    scopeId: "project:test",
    cursorCodec: codec,
    lineage: { resolve: () => resolved(changed) } as any,
    artifactRegistry,
    boundary: (from, to) => ({
      from,
      to,
      handoff_id: `vf-handoff-${"c".repeat(64)}`,
      prompt_projection_digest: `sha256:${"d".repeat(64)}`,
    }),
  });
  try {
    await changedService.read("root", { limit: 1, cursor: page.next_cursor as string });
    throw new Error("expected a stale timeline cursor");
  } catch (error) {
    expect(error).toBeInstanceOf(StaleTimelineCursorError);
    expect(error).toMatchObject({
      head_digest: changed.content_digest,
      head_epoch: 1,
      head: changed.active,
    });
  }
});

test("unresolved lineage never invents a timeline head", async () => {
  const value = resolved();
  const unresolvedPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "unclaimed" as const,
    active: null,
    candidate_heads: [value.head.active],
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: value.head.updated_at,
  };
  const unresolved = {
    ...unresolvedPreimage,
    content_digest: digestV1("VF-LINEAGE-HEAD\0v1\0", unresolvedPreimage),
  };
  const service = new ConversationTimelineService({
    scopeId: "project:test",
    cursorCodec: new TimelineCursorCodec(Buffer.alloc(32, 9)),
    lineage: { resolve: () => resolved(unresolved) } as any,
    artifactRegistry,
  });
  await expect(service.read("root")).rejects.toBeInstanceOf(TimelineHeadUnresolvedError);
});

import { expect, test } from "bun:test";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { ConversationReceiptEffectExecutor } from "../../src/orchestrator/conversation/conversation-receipt-effect-executor.js";
import { materializeSelectionPlan } from "../../src/orchestrator/conversation/conversation-receipt-native-plans.js";
import type {
  ConversationLineageService,
  ResolvedConversationLineageV1,
} from "../../src/orchestrator/conversation/lineage-service.js";
import { ConversationServiceQueueWakeV1 } from "../../src/orchestrator/conversation/service-queue-wake.js";
import { ConversationOrchestrator } from "../../src/orchestrator/conversation/service.js";

const now = "2026-08-26T00:00:00.000Z";
const marker = (label: string): string =>
  digestV1("VF-QUEUE-WAKE-RUNTIME-BOUNDARY-TEST\0v1\0", { label });

function queueWakeHarness() {
  const order: string[] = [];
  const wake = new ConversationServiceQueueWakeV1(
    {} as never,
    () =>
      ({
        rootSessionId: (conversationId: string) =>
          conversationId === "conversation-child" ? "conversation-root" : null,
        kick: (rootSessionId: string) => order.push(`kick:${rootSessionId}`),
      }) as never,
  );
  return { order, wake };
}

test("stop wakes the mapped queue root after terminal settlement without a manual kick", async () => {
  const { order, wake } = queueWakeHarness();
  const runtime = {
    controlState: async () => ({ lifecycle: "ACTIVE", health: "healthy" }),
    operationId: () => "operation-active",
    terminal: async () => {
      order.push("terminal");
      return "STOPPED";
    },
    finish: () => order.push("finish"),
  };
  const service = Object.assign(Object.create(ConversationOrchestrator.prototype), {
    runtime,
    queueWake: wake,
  }) as ConversationOrchestrator;

  await expect(service.stop("conversation-child")).resolves.toEqual({
    stopped: true,
    terminal_state: "STOPPED",
  });
  expect(order).toEqual(["terminal", "finish", "kick:conversation-root"]);
});

test("selection receipt wakes the mapped queue root after head commit without a manual kick", async () => {
  const { order, wake } = queueWakeHarness();
  const node = {
    conversation_id: "conversation-child",
    revision_id: "revision-child",
    revision_ordinal: 1,
  };
  const selected = {
    node,
    parent: null,
    source: {},
    manifest_digest: marker("manifest"),
    ancestry_digest: marker("ancestry"),
  };
  const resolved = {
    lineage: {
      root_session_id: "conversation-root",
      nodes: [selected],
    },
    requested: selected,
    head: {
      schema_version: "1.0",
      root_session_id: "conversation-root",
      head_status: "unclaimed",
      active: null,
      candidate_heads: [node],
      head_epoch: 0,
      previous_head_digest: null,
      updated_by_operation_id: null,
      updated_at: now,
      content_digest: marker("head"),
    },
  } as unknown as ResolvedConversationLineageV1;
  const action = {
    type: "conversation.select_lineage_head" as const,
    root_session_id: "conversation-root",
    candidate_conversation_id: node.conversation_id,
    candidate_revision_id: node.revision_id,
  };
  const selection = materializeSelectionPlan(resolved, action, now);
  const home = {
    publishedRevisionTransitions: () => [],
    headTransitions: {
      readAll: () => new Map(),
      write: () => undefined,
    },
    actionReceipts: {
      readPlan: () => ({ action_plan: { step: "selection" } }),
    },
    lineage: {
      commitHead: () => order.push("commit"),
    },
  } as unknown as ConversationHomeAuthorities;
  const executor = new ConversationReceiptEffectExecutor({
    lineages: { resolve: () => resolved } as unknown as ConversationLineageService,
    home,
    service: {
      wakeMessageQueue: (conversationId: string) => wake.wake(conversationId),
    } as never,
  });

  await expect(
    executor.execute({
      plan: {
        action_type: action.type,
        expected: { conversation_id: node.conversation_id },
        effect_binding: selection,
      } as never,
      proposal: { proposal_id: `vf-proposal-${"1".repeat(64)}` } as never,
      approval: {} as never,
      dispatch: {
        operation_id: `vf-operation-${"2".repeat(64)}`,
        created_at: now,
      } as never,
    }),
  ).resolves.toMatchObject({ facts: [{ kind: "lineage-head" }] });
  expect(order).toEqual(["commit", "kick:conversation-root"]);
});

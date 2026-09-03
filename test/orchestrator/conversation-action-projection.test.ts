import { describe, expect, test } from "bun:test";
import type { ActionAuthoritySnapshotV1 } from "../../src/actions/index.js";
import { validateOperationBatches } from "../../src/actions/operation-batch-validation.js";
import { projectRevisionActionEvents } from "../../src/orchestrator/conversation/conversation-action-projection.js";
import type { RevisionOperationEventV1 } from "../../src/orchestrator/conversation/revision-planner.js";

const operationId = `vf-operation-${"a".repeat(64)}`;
const effectOperationId = `vf-operation-${"b".repeat(64)}`;
const digest = `sha256:${"c".repeat(64)}`;
const at = "2026-08-25T00:00:00.000Z";

describe("conversation action projection", () => {
  test("projects an inconclusive reconciliation result as the failed terminal boundary", () => {
    const snapshot = {
      operation_id: operationId,
      approval: { decided_at: at, approval_digest: digest },
      proposal: { action: { type: "conversation.reconcile_revision_operation" } },
    } as unknown as ActionAuthoritySnapshotV1;
    const reconciliation = {
      schema_version: "1.0",
      operation_id: effectOperationId,
      sequence: 3,
      previous_event_digest: digest,
      payload: {
        kind: "reconciliation-result",
        authorized_by_action_operation_id: operationId,
        effect_action_operation_id: effectOperationId,
        observed_state_digest: digest,
        outcome: "failed",
        action_terminals: [
          { action_operation_id: operationId, outcome: "failed", reason_code: "inconclusive" },
        ],
        reason_code: "inconclusive",
      },
      recorded_at: at,
      event_digest: digest,
    } as RevisionOperationEventV1;

    const projected = projectRevisionActionEvents(snapshot, [reconciliation]);
    expect(projected.map((event) => [event.progress?.phase, event.state])).toEqual([
      ["dispatch", "committing"],
      ["revision:needs_recovery", "failed"],
    ]);
    expect(() => validateOperationBatches(snapshot, projected)).not.toThrow();
  });
});

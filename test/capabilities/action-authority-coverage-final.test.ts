import { describe, expect, test } from "bun:test";
import {
  ActionAuthorityStaleError,
  type ActionProposalV1,
  materializeProposal,
} from "../../src/actions/index.js";
import { CapabilityActionAuthorityResolverV1 } from "../../src/capabilities/action-domain/authority-resolver.js";
import {
  assertConversationCapabilityTargets,
  materializeConversationCapabilityAction,
} from "../../src/capabilities/action-domain/conversation-target-authority.js";
import { CapabilityRuntimeError } from "../../src/capabilities/operations/errors.js";
import { ConversationRevisionConflictError } from "../../src/orchestrator/conversation/revision-errors.js";
import { proposalDraft } from "../actions/fixtures.js";

const now = "2026-08-26T00:00:00.000Z";
const CONVERSATION_LOCK_DIGEST = `sha256:${"1".repeat(64)}`;
const LINEAGE_HEAD_DIGEST = `sha256:${"2".repeat(64)}`;
const PARTICIPANT_BINDING_SET_DIGEST = `sha256:${"3".repeat(64)}`;

function capabilityProposal(): ActionProposalV1 {
  const proposal = materializeProposal(proposalDraft());
  return {
    ...proposal,
    base: { ...proposal.base, capability_scope: "project" },
  } as ActionProposalV1;
}

function resolverThrowing(error: Error): CapabilityActionAuthorityResolverV1 {
  return new CapabilityActionAuthorityResolverV1({} as never, () => ({}) as never, {
    authority: { reader: {} as never },
    capabilityDispatches: {} as never,
    resolveCapabilityActionRoot: () => ({ root_session_id: "root-1" }),
    resolveCapabilityProposalBase: () => {
      throw error;
    },
  });
}

describe("capability action authority terminal coverage", () => {
  test("normalizes revision and revocable capability drift into stable stale authority", () => {
    for (const [error, reason] of [
      [new ConversationRevisionConflictError("revision moved"), "conversation-source-changed"],
      [new CapabilityRuntimeError("policy changed", "policy-stale"), "policy-stale"],
    ] as const) {
      try {
        resolverThrowing(error).prevalidateDispatch({
          proposal: capabilityProposal(),
          approval: {} as never,
          now,
        });
        throw new Error("expected stale authority");
      } catch (caught) {
        expect(caught).toBeInstanceOf(ActionAuthorityStaleError);
        expect((caught as ActionAuthorityStaleError).reason_code).toBe(reason);
        expect((caught as ActionAuthorityStaleError).recorded_at).toBe(now);
      }
    }
  });

  test("preserves non-revocable integrity failures instead of misclassifying them as stale", () => {
    for (const failure of [
      new CapabilityRuntimeError("broken proof", "integrity-failure"),
      new Error("unexpected resolver failure"),
    ]) {
      expect(() =>
        resolverThrowing(failure).prevalidateDispatch({
          proposal: capabilityProposal(),
          approval: {} as never,
          now,
        }),
      ).toThrow(failure);
    }
  });

  test("requires live participant authority, rejects duplicate selectors, and canonicalizes targets", () => {
    const target = {
      type: "capability.retarget" as const,
      package_id: "acme.reviewer",
      scope: "project" as const,
      requested_targets: [
        { engine: "codex" as const, participant_id: "participant-b" },
        { engine: "claude" as const, participant_id: "participant-a" },
      ],
    };
    expect(() =>
      assertConversationCapabilityTargets(target, {
        root_session_id: "root",
        conversation_id: "conversation",
        revision_id: "revision",
        last_seq: 1,
        conversation_lock_digest: CONVERSATION_LOCK_DIGEST,
        lineage_head_digest: LINEAGE_HEAD_DIGEST,
        lineage_head_epoch: 1,
        participant_binding_set_digest: PARTICIPANT_BINDING_SET_DIGEST,
      }),
    ).toThrow("participant authority is unavailable");

    const conversation = {
      root_session_id: "root",
      conversation_id: "conversation",
      revision_id: "revision",
      last_seq: 1,
      conversation_lock_digest: CONVERSATION_LOCK_DIGEST,
      lineage_head_digest: LINEAGE_HEAD_DIGEST,
      lineage_head_epoch: 1,
      participant_binding_set_digest: PARTICIPANT_BINDING_SET_DIGEST,
      participants: [
        { participant_id: "participant-a", engine: "claude" as const },
        { participant_id: "participant-b", engine: "codex" as const },
      ],
    };
    const duplicateTarget = target.requested_targets[0];
    if (!duplicateTarget) throw new Error("target fixture must contain one selector");
    expect(() =>
      assertConversationCapabilityTargets(
        { ...target, requested_targets: [duplicateTarget, duplicateTarget] },
        conversation,
      ),
    ).toThrow("selectors are duplicated");

    const materialized = materializeConversationCapabilityAction(target, conversation);
    expect(materialized).toMatchObject({
      requested_targets: [
        { engine: "claude", participant_id: "participant-a" },
        { engine: "codex", participant_id: "participant-b" },
      ],
    });
  });
});

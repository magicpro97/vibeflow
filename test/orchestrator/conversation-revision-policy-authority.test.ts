import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { EMPTY_PERMISSION_DIGEST } from "../../src/actions/index.js";
import { AGENT_ENGINE } from "../../src/core/agent-contract.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import { materializeConversationRevisionAction } from "../../src/orchestrator/conversation/conversation-action-planner.js";
import { CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE } from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import { conversationRevisionPolicyAuthorityDigest } from "../../src/orchestrator/conversation/conversation-revision-policy-authority.js";
import {
  assertDeferredRevisionPolicyAuthority,
  commitDeferredRevision,
} from "../../src/orchestrator/conversation/revision-deferred-commit.js";
import { deferredRevisionRequiresPolicyAuthority } from "../../src/orchestrator/conversation/revision-deferred-validation.js";
import { materializeRevisionPreparationPlan } from "../../src/orchestrator/conversation/revision-planner.js";
import {
  DEFERRED_REVISION_PROPOSAL_DIGEST_DOMAIN,
  DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION,
  DeferredRevisionProposalStore,
} from "../../src/orchestrator/conversation/revision-proposal-store.js";
import { authority } from "../actions/fixtures.js";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T01:00:00.000Z";
const ROOT_SESSION_ID = "root-1";
const digest = (label: string): string =>
  digestV1("VF-CONVERSATION-REVISION-POLICY-TEST\0v1\0", { label });

function preparationPlan() {
  return materializeRevisionPreparationPlan({
    root_session_id: ROOT_SESSION_ID,
    parent: {
      conversation_id: "conversation-root",
      revision_id: "revision-root",
      revision_ordinal: 0,
    },
    expected_head_digest: digest("head"),
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 3,
    expected_parent_lock_digest: digest("lock"),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    revision_claim_epoch: 1,
    binding_delta_digest: digest("binding-delta"),
    resulting_binding_set_digest: digest("binding-set"),
    handoff_selection_plan_digest: digest("handoff-selection"),
    participant_starts: [],
    created_at: NOW,
    expires_at: LATER,
  });
}

const addExecutor = {
  type: "conversation.add_participant" as const,
  participant: {
    role_ref: "coordination-executor",
    engine: "codex" as const,
    model: null,
    skill_refs: [],
  },
};

describe("conversation revision topology policy authority", () => {
  test("proposal and approval bind root, lock, normalized topology, and resolved role authority", () => {
    const topology = {
      before: {
        policy: "direct",
        participants: [
          {
            participant_id: "participant-lead",
            role_ref: "direct",
            role_source: "builtin",
            engine: "claude",
            model: "claude-sonnet",
            model_override: null,
            session_mode: "fresh",
            sandbox: "read-only",
            skill_refs: [],
            native_tool_intents: ["read"],
            host_tools: ["propose_action"],
          },
        ],
      },
      after: {
        policy: "coordinate",
        participants: [
          {
            participant_id: "participant-lead",
            role_ref: "coordination-coordinator",
            role_source: "builtin",
            engine: "claude",
            model: "claude-sonnet",
            model_override: null,
            session_mode: "fresh",
            sandbox: "read-only",
            skill_refs: [],
            native_tool_intents: ["read"],
            host_tools: [],
          },
          {
            participant_id: "participant-executor",
            role_ref: "coordination-executor",
            role_source: "builtin",
            engine: "codex",
            model: "gpt-5.4",
            model_override: null,
            session_mode: "fresh",
            sandbox: "workspace-write",
            skill_refs: [],
            native_tool_intents: ["read", "write", "test"],
            host_tools: [],
          },
        ],
      },
      before_topology_digest: digest("topology-before"),
      topology_digest: digest("topology-after"),
      resolved_binding_set_digest: digest("resolved-bindings-after"),
    };
    const lock = digest("conversation-lock");
    const planned = materializeConversationRevisionAction({
      root_session_id: ROOT_SESSION_ID,
      conversation_id: "conversation-root",
      revision_id: "revision-root",
      last_seq: 3,
      conversation_lock_digest: lock,
      head: { content_digest: digest("lineage-head"), head_epoch: 0 } as never,
      action: addExecutor,
      message_key: "add-executor",
      authority,
      revision_plan: preparationPlan(),
      topology_authority: topology,
      created_at: NOW,
    });
    const expected = conversationRevisionPolicyAuthorityDigest({
      root_session_id: ROOT_SESSION_ID,
      conversation_lock_digest: lock,
      topology_digest: topology.topology_digest,
      resolved_binding_set_digest: topology.resolved_binding_set_digest,
    });

    expect(planned.proposal.policy_digest).toBe(expected);
    expect(planned.approval.policy_digest).toBe(expected);
    expect(planned.proposal.permission_digest).toBe(EMPTY_PERMISSION_DIGEST);
    expect(planned.proposal.preview.review_fields.map(({ json_pointer }) => json_pointer)).toEqual([
      "/derived_topology",
      "/participant",
    ]);
    expect(planned.proposal.preview.review_fields[0]).toEqual({
      json_pointer: "/derived_topology",
      label: "Derived policy, roles, sandbox, and tools",
      before: topology.before,
      after: topology.after,
      private_binding_digest: expected,
    });
    expect(
      conversationRevisionPolicyAuthorityDigest({
        root_session_id: ROOT_SESSION_ID,
        conversation_lock_digest: lock,
        topology_digest: topology.topology_digest,
        resolved_binding_set_digest: digest("drifted-role-authority"),
      }),
    ).not.toBe(expected);
    const deferred = {
      schema_version: DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY,
      proposal_id: planned.proposal.proposal_id,
      proposal_digest: planned.proposal.proposal_digest,
      policy_authority_digest: expected,
      topology_digest: topology.topology_digest,
      revision_plan: preparationPlan(),
      handoff_digest: digest("handoff"),
      content_digest: digest("deferred-record"),
    } as const;
    const commitAuthority = {
      deferred,
      proposal_policy_digest: planned.proposal.policy_digest,
      approval_policy_digest: planned.approval.policy_digest,
      root_session_id: ROOT_SESSION_ID,
      conversation_lock_digest: lock,
      topology_digest: topology.topology_digest,
      resolved_binding_set_digest: topology.resolved_binding_set_digest,
    };
    expect(() => assertDeferredRevisionPolicyAuthority(commitAuthority)).not.toThrow();
    expect(() =>
      assertDeferredRevisionPolicyAuthority({
        ...commitAuthority,
        resolved_binding_set_digest: digest("drifted-role-authority"),
      }),
    ).toThrow("deferred revision topology authority changed");
  });

  test("reads legacy v1.0 records but permits only topology-neutral continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-revision-policy-legacy-"));
    try {
      const store = new DeferredRevisionProposalStore(root);
      const current = store.write({
        proposal_id: `vf-proposal-${"d".repeat(64)}`,
        proposal_digest: digest("current-proposal"),
        policy_authority_digest: digest("current-policy-authority"),
        topology_digest: digest("current-topology"),
        revision_plan: preparationPlan(),
        handoff_digest: digest("current-handoff"),
      });
      expect(current.schema_version).toBe(
        DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY,
      );
      expect(store.read(current.proposal_id)).toEqual(current);
      const proposalId = `vf-proposal-${"a".repeat(64)}`;
      const preimage = {
        schema_version: DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.LEGACY,
        proposal_id: proposalId,
        proposal_digest: digest("legacy-proposal"),
        revision_plan: preparationPlan(),
        handoff_digest: digest("legacy-handoff"),
      };
      const legacy = {
        ...preimage,
        content_digest: digestV1(DEFERRED_REVISION_PROPOSAL_DIGEST_DOMAIN, preimage),
      };
      const proposalRoot = join(root, "revisions", "v1", "proposals");
      await mkdir(proposalRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(proposalRoot, `${proposalId}.json`), canonicalJsonBytes(legacy), {
        mode: 0o600,
      });

      expect(store.read(proposalId)).toEqual(legacy);
      expect(
        [
          addExecutor,
          {
            type: HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
            participant_id: "participant-executor",
          },
          {
            type: HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT,
            participant_id: "participant-executor",
            changes: { engine: AGENT_ENGINE.CODEX },
          },
          {
            type: HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS,
            changes: { policy: CONVERSATION_POLICY.COORDINATE },
          },
        ].every((action) => deferredRevisionRequiresPolicyAuthority(action)),
      ).toBeTrue();
      expect(
        deferredRevisionRequiresPolicyAuthority({
          type: HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
          content: "Continue with approved authority.",
          target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
        }),
      ).toBeFalse();
      await expect(
        commitDeferredRevision({
          options: {
            home: {
              revisions: {
                readOperation: () => null,
                readPlan: () => null,
                readPreparedTransition: () => null,
              },
            },
          } as never,
          executor: {} as never,
          proposals: store,
          commit: {
            conversationId: "conversation-root",
            proposalId,
            proposalDigest: legacy.proposal_digest,
            approvalId: `vf-approval-${"b".repeat(64)}`,
            authority,
          },
          validated: {
            actionState: {} as never,
            deferred: legacy,
            action: addExecutor,
            operationId: `vf-operation-${"c".repeat(64)}`,
          },
        }),
      ).rejects.toThrow("legacy deferred revision lacks topology authority");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

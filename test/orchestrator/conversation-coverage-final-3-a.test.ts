import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalActionRequestDigest, materializeProposal } from "../../src/actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import { createConversationBootstrap } from "../../src/orchestrator/conversation/bootstrap.js";
import { ConversationActionReceiptStore } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import { ConversationActionService } from "../../src/orchestrator/conversation/conversation-action-service.js";
import { stageAgentActionCandidate } from "../../src/orchestrator/conversation/conversation-agent-action-candidate-stage.js";
import { assertNoActiveConversationCapabilityDispatch } from "../../src/orchestrator/conversation/conversation-capability-dispatch-reservation.js";
import { assertNoLineageMutationAuthority } from "../../src/orchestrator/conversation/conversation-lineage-mutation-guard.js";
import {
  lineageMutationReservationDigest,
  lineageMutationReservationPath,
} from "../../src/orchestrator/conversation/conversation-lineage-mutation-reservation-records.js";
import { ConversationLineageMutationReservationStoreV1 } from "../../src/orchestrator/conversation/conversation-lineage-mutation-reservation.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "../actions/fixtures.js";

const roots: string[] = [];
const NOW = "2026-08-25T00:02:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const libraries = {
  plan: {
    create: async () => ({ content: "unused" }),
    update: async ({ revision }: { revision: { content: string } }) => ({
      content: revision.content,
    }),
  },
  review: {
    currentHead: async () => "a".repeat(40),
    review: async () => ({
      reviewed_head: "a".repeat(40),
      reviewer: "human:coverage",
      outcome: "approved" as const,
      evidence_refs: ["coverage-review.json"],
    }),
  },
  verify: { run: async () => ({}) },
  orchestrate: {
    dryRun: async () => ({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: true,
    }),
    execute: async () => ({ units: [], reviews: [] }),
  },
};

describe("final assigned conversation authority coverage", () => {
  test("bootstrap queue lineage consults the durable revision recovery pair", async () => {
    const root = await temporaryRoot("vf-bootstrap-recovery-final-3-a-");
    const bootstrap = createConversationBootstrap({
      repoRoot: root,
      stateDir: join(root, "state"),
      readiness: () => [],
      libraries: libraries as never,
      now: () => NOW,
    });
    const queueLineage = (
      bootstrap.authorities.messageQueue as unknown as {
        input: {
          messages: {
            input: {
              lineage: {
                options: {
                  revisionRecoveryAuthority(operationId: string): unknown;
                };
              };
            };
          };
        };
      }
    ).input.messages.input.lineage;

    expect(
      queueLineage.options.revisionRecoveryAuthority(`vf-operation-${"a".repeat(64)}`),
    ).toBeNull();
  });

  test("prepared dispatch uses its authoritative timestamp and publishes the committing state", async () => {
    const root = await temporaryRoot("vf-action-service-prepared-final-3-a-");
    const revisions = new ConversationRevisionStore({ artifactRoot: root });
    const receipts = new ConversationActionReceiptStore(root);
    const baseResolver = testAuthorityResolver();
    const preparedTimestamps: string[] = [];
    const resolver = {
      ...baseResolver,
      prepareDispatch: (input: Parameters<typeof baseResolver.prepareDispatch>[0]) => {
        preparedTimestamps.push(input.now);
        return baseResolver.prepareDispatch(input);
      },
    };
    const service = new ConversationActionService(
      root,
      () => new Date(fixedNow).toISOString(),
      revisions,
      receipts,
      undefined,
      resolver,
    );
    const base = proposalDraft();
    const capabilityAction = {
      type: "capability.install" as const,
      package: { id: "coverage.package" },
      scope: "project" as const,
      requested_targets: [{ engine: "codex" as const, participant_id: null }],
      inputs: [],
    };
    const request = canonicalRequest({
      request: {
        ...canonicalRequest().request,
        candidate: capabilityAction,
      },
    });
    const proposal = materializeProposal(
      proposalDraft({
        domain: "capability",
        producer_request_binding: {
          kind: "canonical-action-request",
          digest: canonicalActionRequestDigest(request),
        },
        execution_object_closure_digest: testDigest("execution-closure-final-3-a"),
        base: { ...base.base, capability_scope: "project" },
        action: capabilityAction,
        preview: { ...base.preview, action_type: "capability.install" },
      }),
    );
    service.authority.createProposal({
      authority,
      canonical_request: request,
      proposal,
    });
    const approval = service.authority.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    let invalidations = 0;
    const unsubscribe = service.authority.subscribe(proposal.proposal_id, () => {
      invalidations += 1;
    });
    if (!unsubscribe) throw new Error("prepared dispatch subscription was not admitted");

    const dispatch = service.authority.beginPreparedDispatch(
      proposal.proposal_id,
      approval.approval_id,
      NOW,
    );

    expect(preparedTimestamps).toEqual([NOW]);
    expect(dispatch.created_at).toBe(approval.decided_at);
    expect(service.authority.get(proposal.proposal_id)?.state).toBe("committing");
    expect(invalidations).toBe(1);
    unsubscribe();
  });

  test("a granted candidate with no durable conversation origin is rejected as invalid origin", async () => {
    const root = await temporaryRoot("vf-agent-candidate-origin-final-3-a-");
    const participantId = "participant-coverage";
    const result = stageAgentActionCandidate({
      artifactRoot: join(root, "artifacts"),
      traceRoot: join(root, "traces"),
      home: {} as never,
      store: {
        writeStage: () => {
          throw new Error("invalid-origin candidate must not reach durable stage publication");
        },
      } as never,
      actions: null,
      manifest: {
        conversation_id: "conversation-missing",
        revision_id: "revision-missing",
        bindings: [
          {
            participant_id: participantId,
            input: { roleRef: "direct" },
            host_tools: ["propose_action"],
          },
        ],
      } as never,
      participant_id: participantId,
      response_idempotency_key: "response-missing",
      candidate: {
        schema_version: "1.0",
        candidate: {
          type: "conversation.add_participant",
          participant: {
            role_ref: "direct",
            engine: "codex",
            model: null,
            skill_refs: [],
          },
        },
      },
    });

    expect(result).toEqual({ accepted: false, diagnostic_code: "invalid_action_origin" });
  });

  test("lineage guards accept an empty authority and reject a canonical active mutation", async () => {
    const root = await temporaryRoot("vf-lineage-mutation-guard-final-3-a-");
    const rootSessionId = "conversation-root";
    new ConversationLineageMutationReservationStoreV1(root);

    expect(() => assertNoActiveConversationCapabilityDispatch(root, rootSessionId)).not.toThrow();

    const preimage = {
      schema_version: "1.0" as const,
      root_session_id: rootSessionId,
      reservation_epoch: 1,
      previous_reservation_digest: null,
      status: "active" as const,
      mutation_kind: "context-compaction" as const,
      proposal_id: `vf-proposal-${"a".repeat(64)}`,
      proposal_digest: digestV1("VF-FINAL-3-A-PROPOSAL\0v1\0", {}),
      approval_id: `vf-approval-${"b".repeat(64)}`,
      approval_digest: digestV1("VF-FINAL-3-A-APPROVAL\0v1\0", {}),
      operation_id: `vf-operation-${"c".repeat(64)}`,
      source: {
        root_session_id: rootSessionId,
        conversation_id: "conversation-active",
        revision_id: "revision-active",
        last_seq: 7,
        conversation_lock_digest: digestV1("VF-FINAL-3-A-LOCK\0v1\0", {}),
        lineage_head_digest: digestV1("VF-FINAL-3-A-HEAD\0v1\0", {}),
        lineage_head_epoch: 2,
      },
      release_outcome: null,
      terminal_digest: null,
      created_at: NOW,
      updated_at: NOW,
    };
    const record = {
      ...preimage,
      content_digest: lineageMutationReservationDigest(preimage),
    };
    await writeFile(
      lineageMutationReservationPath(root, rootSessionId),
      canonicalJsonBytes(record),
      { mode: 0o600 },
    );

    expect(() => assertNoLineageMutationAuthority(root, rootSessionId)).toThrow(
      "conversation lineage has an active same-revision mutation",
    );
  });
});

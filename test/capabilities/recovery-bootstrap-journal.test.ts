import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_PERMISSION_DIGEST } from "../../src/actions/index.js";
import type { ActionProposalDraftV1 } from "../../src/actions/types.js";
import {
  activateRecoveryBootstrapForTrustedInstall,
  readActivatedRecoveryBootstrap,
} from "../../src/capabilities/authority-repair/bootstrap-activation.js";
import {
  appendRecoveryBootstrapEvent,
  readRecoveryBootstrapJournalBytes,
} from "../../src/capabilities/authority-repair/bootstrap-journal.js";
import {
  AUTHORITY_REPAIR_EVENT_STATE,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
} from "../../src/capabilities/authority-repair/contract.js";
import { recoveryBootstrapPaths } from "../../src/capabilities/authority-repair/paths.js";
import {
  materializeAuthorityRepairEvent,
  materializeAuthorityRepairOperation,
  materializeRecoveryBootstrapApproval,
  materializeRecoveryBootstrapProposal,
} from "../../src/capabilities/authority-repair/records.js";
import { acquireProcessLock, digestHex, digestV1 } from "../../src/durability/index.js";
import { proposalDraft, testDigest } from "../actions/fixtures.js";

const CREATED_AT = "2026-08-25T00:00:00.000Z";
const DECIDED_AT = "2026-08-25T00:01:00.000Z";
const APPROVAL_EXPIRES_AT = "2026-08-25T00:06:00.000Z";
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vf-recovery-bootstrap-journal-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function repairDraft(bootstrapIdentityDigest: string): ActionProposalDraftV1 {
  const original = proposalDraft();
  const scopeIdentityDigest = testDigest("bootstrap-repair-scope");
  const repairBindingDigest = testDigest("bootstrap-repair-authorization");
  const planPreimage = {
    schema_version: "1.0" as const,
    domain: "authority-epoch" as const,
    authority_scope: "project" as const,
    scope_id: scopeIdentityDigest,
    target_preimage: {
      presence: "present" as const,
      corrupt_bytes_sha256: "a".repeat(64),
      quarantine_ref: testDigest("bootstrap-repair-quarantine"),
      absence_evidence_digest: null,
    },
    last_valid_record_digest: testDigest("bootstrap-repair-last-valid"),
    proposed_restored_authority_digest: testDigest("bootstrap-repair-restored"),
    lost_tail_digest: testDigest("bootstrap-repair-lost-tail"),
    journal_identity_digest: testDigest("bootstrap-repair-journal"),
    repair_steps_digest: testDigest("bootstrap-repair-steps"),
    repair_authorization_binding_digest: repairBindingDigest,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    risk: "critical" as const,
    created_at: CREATED_AT,
    expires_at: "2026-08-25T00:30:00.000Z",
  };
  const nativePlanDigest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", planPreimage);
  const plan = {
    ...planPreimage,
    repair_id: `vf-authority-repair-${digestHex(nativePlanDigest)}`,
    plan_digest: nativePlanDigest,
  };
  return proposalDraft({
    idempotency_key: "bootstrap-repair-1",
    origin_event_id: null,
    domain: "capability",
    action_root_locator: {
      kind: "recovery-bootstrap",
      bootstrap_identity_digest: bootstrapIdentityDigest,
    },
    producer_request_binding: {
      kind: "recovery-bootstrap-repair-plan",
      digest: plan.plan_digest,
    },
    base: {
      ...original.base,
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: "project",
      authority_binding_mode: "recovery-checkpoint",
      repair_authorization_binding_digest: repairBindingDigest,
    },
    action: { type: "authority.repair", plan },
    requested_by: {
      kind: "human-cli",
      public_actor_id: "vf-authority-cli",
      credential_class: "recovery",
    },
    risk: "critical",
    permission_digest: EMPTY_PERMISSION_DIGEST,
    preview: { ...original.preview, action_type: "authority.repair" },
    created_at: CREATED_AT,
    expires_at: "2026-08-25T00:30:00.000Z",
  });
}

describe("isolated recovery bootstrap journal", () => {
  test("persists the complete proposal, approval, dispatch, and terminal chain", () => {
    const userRoot = root();
    const activated = activateRecoveryBootstrapForTrustedInstall(userRoot, {
      now: () => CREATED_AT,
      random_bytes: (size) => new Uint8Array(size).fill(9),
    });
    const paths = recoveryBootstrapPaths(userRoot);
    const proposal = materializeRecoveryBootstrapProposal(
      repairDraft(activated.identity.content_digest),
    );
    const approval = materializeRecoveryBootstrapApproval({
      proposal,
      decision: "approved",
      decided_at: DECIDED_AT,
      expires_at: APPROVAL_EXPIRES_AT,
    });
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const terminal = materializeAuthorityRepairEvent(operation, {
      sequence: 0,
      previous_event_digest: null,
      state: AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
      observed_authority_digest:
        proposal.action.type === "authority.repair"
          ? proposal.action.plan.proposed_restored_authority_digest
          : null,
      reason_code: null,
      recorded_at: "2026-08-25T00:02:00.000Z",
    });

    const lock = acquireProcessLock(paths.writerLock, {
      operation: operation.operation_id,
      coverageRoot: paths.root,
    });
    try {
      let fold = readRecoveryBootstrapJournalBytes(activated.identity, readFileSync(paths.journal));
      fold = appendRecoveryBootstrapEvent({
        path: paths.journal,
        lock,
        identity: activated.identity,
        prior: fold,
        payload: {
          kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED,
          proposal,
          repair_plan_digest:
            proposal.action.type === "authority.repair" ? proposal.action.plan.plan_digest : "",
        },
        recorded_at: proposal.created_at,
      });
      fold = appendRecoveryBootstrapEvent({
        path: paths.journal,
        lock,
        identity: activated.identity,
        prior: fold,
        payload: {
          kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.APPROVAL_DECISION,
          proposal_id: proposal.proposal_id,
          from: "pending_review",
          to: "approved",
          approval,
        },
        recorded_at: approval.decided_at,
      });
      fold = appendRecoveryBootstrapEvent({
        path: paths.journal,
        lock,
        identity: activated.identity,
        prior: fold,
        payload: {
          kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH,
          proposal_id: proposal.proposal_id,
          operation,
        },
        recorded_at: operation.created_at,
      });
      fold = appendRecoveryBootstrapEvent({
        path: paths.journal,
        lock,
        identity: activated.identity,
        prior: fold,
        payload: {
          kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.TERMINAL_MIRROR,
          proposal_id: proposal.proposal_id,
          repair_id: operation.repair_id,
          operation_id: operation.operation_id,
          header_digest: operation.header_digest,
          outcome: "verified",
          authority_repair_event_digest: terminal.event_digest,
          previous_mirrored_event_digest: null,
        },
        recorded_at: terminal.recorded_at,
      });
      expect(fold.events).toHaveLength(4);
      expect(fold.proposals.get(proposal.proposal_id)?.terminal).toBe("verified");
    } finally {
      lock.release();
    }

    const replayed = readRecoveryBootstrapJournalBytes(
      activated.identity,
      readFileSync(paths.journal),
    );
    expect(replayed.event_head_digest).toBe(replayed.events.at(-1)?.event_digest ?? null);
    expect(readActivatedRecoveryBootstrap(userRoot).identity).toEqual(activated.identity);
  });

  test("rejects dispatch without approval and any tampered journal byte", () => {
    const userRoot = root();
    const activated = activateRecoveryBootstrapForTrustedInstall(userRoot, {
      now: () => CREATED_AT,
      random_bytes: (size) => new Uint8Array(size).fill(7),
    });
    const paths = recoveryBootstrapPaths(userRoot);
    const proposal = materializeRecoveryBootstrapProposal(
      repairDraft(activated.identity.content_digest),
    );
    const approval = materializeRecoveryBootstrapApproval({
      proposal,
      decision: "approved",
      decided_at: DECIDED_AT,
      expires_at: APPROVAL_EXPIRES_AT,
    });
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const lock = acquireProcessLock(paths.writerLock, {
      operation: "bootstrap-journal-negative-test",
      coverageRoot: paths.root,
    });
    try {
      let fold = readRecoveryBootstrapJournalBytes(activated.identity, readFileSync(paths.journal));
      fold = appendRecoveryBootstrapEvent({
        path: paths.journal,
        lock,
        identity: activated.identity,
        prior: fold,
        payload: {
          kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED,
          proposal,
          repair_plan_digest:
            proposal.action.type === "authority.repair" ? proposal.action.plan.plan_digest : "",
        },
        recorded_at: proposal.created_at,
      });
      expect(() =>
        appendRecoveryBootstrapEvent({
          path: paths.journal,
          lock,
          identity: activated.identity,
          prior: fold,
          payload: {
            kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH,
            proposal_id: proposal.proposal_id,
            operation,
          },
          recorded_at: operation.created_at,
        }),
      ).toThrow(/approved proposal/i);
    } finally {
      lock.release();
    }

    const bytes = readFileSync(paths.journal);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    writeFileSync(paths.journal, bytes, { mode: 0o600 });
    expect(() => readRecoveryBootstrapJournalBytes(activated.identity, bytes)).toThrow();
  });
});

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationCoordinationWorkspaceObservationV1 } from "./conversation-coordination-contract.js";
import type { ConversationDelegationWorkspaceIdentityV1 } from "./conversation-delegation-workspace-contract.js";
import type { ConversationDelegationWorkspaceGitV1 } from "./conversation-delegation-workspace-git.js";
import {
  CONVERSATION_DELEGATION_OWNER_STATUS,
  type ConversationDelegationWorkspaceOwnershipV1,
} from "./conversation-delegation-workspace-ownership.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_STATE,
  type ConversationDelegationWorkspaceRecordStoreV1,
  type ConversationDelegationWorkspaceRecordV1,
} from "./conversation-delegation-workspace-records.js";
import {
  type canonicalTaskBinding,
  taskBindingMatches,
} from "./conversation-delegation-workspace-task.js";

const fail = (message: string): never => {
  throw new Error(message);
};

export class ConversationDelegationWorkspaceLifecycleV1 {
  constructor(
    readonly records: ConversationDelegationWorkspaceRecordStoreV1,
    private readonly git: ConversationDelegationWorkspaceGitV1,
    private readonly ownership: ConversationDelegationWorkspaceOwnershipV1,
    private readonly now: () => string,
  ) {}

  absent(workspaceKey: string): ConversationCoordinationWorkspaceObservationV1 {
    return Object.freeze({
      workspace_key: workspaceKey,
      quiescent: true,
      dirty: false,
      verified_head: null,
      branch_ref: null,
      head: null,
      evidence_refs: Object.freeze([]),
    });
  }

  observation(record: ConversationDelegationWorkspaceRecordV1) {
    return Object.freeze({
      workspace_key: record.workspace_key,
      quiescent: record.lease_count === 0 && record.review_count === 0,
      dirty: record.dirty,
      verified_head: record.verified_head,
      branch_ref: record.branch_ref,
      head: record.head,
      // Lease/review bookkeeping changes the workspace record digest. Only immutable
      // verification proofs can cross an agent turn as stable review authority.
      evidence_refs: Object.freeze([...record.verification_evidence_refs]),
    });
  }

  identity(input: ConversationDelegationWorkspaceIdentityV1) {
    if (!input.workflowId.trim() || !input.workspaceKey.trim())
      fail("workspace identity is required");
    const repoRoot = realpathSync(resolve(input.repoRoot));
    const repoRootDigest = digestV1("VF-CONVERSATION-COORDINATION-REPO\0v1\0", {
      repo_root: repoRoot,
    });
    const workspaceKeyDigest = digestV1("VF-CONVERSATION-COORDINATION-WORKSPACE-KEY\0v1\0", {
      schema_version: "1.0",
      workflow_id: input.workflowId,
      workspace_key: input.workspaceKey,
      repo_root_digest: repoRootDigest,
    });
    const hex = digestHex(workspaceKeyDigest);
    return {
      repoRoot,
      repoRootDigest,
      workspaceKeyDigest,
      workspaceId: `vf-coordinate-workspace-${hex}`,
      branchRef: `refs/heads/vf/coordinate/${hex.slice(0, 24)}`,
    };
  }

  readBound(
    input: ConversationDelegationWorkspaceIdentityV1,
  ): ConversationDelegationWorkspaceRecordV1 | null {
    const identity = this.identity(input);
    const record = this.records.read(identity.workspaceId);
    if (record) this.assertIdentity(record, input, identity);
    return record;
  }

  loadForUse(
    input: ConversationDelegationWorkspaceIdentityV1,
  ): ConversationDelegationWorkspaceRecordV1 {
    const found = this.readBound(input) ?? fail("coordination workspace is missing");
    const record = this.reconcileVerifying(found);
    if (record.state !== CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE)
      fail("coordination workspace authority is unavailable");
    return record;
  }

  ensureActive(
    input: ConversationDelegationWorkspaceIdentityV1,
  ): ConversationDelegationWorkspaceRecordV1 {
    const identity = this.identity(input);
    const found = this.records.read(identity.workspaceId);
    if (!found) return this.create(input, identity);
    this.assertIdentity(found, input, identity);
    let current = this.reconcileVerifying(found);
    if (
      current.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.SETTLED ||
      current.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY ||
      current.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.PROMOTING
    )
      fail("coordination workspace authority is unavailable");
    if (current.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.PENDING) {
      this.git.recoverPending(current, identity.repoRoot);
      current = this.records.write({
        ...current,
        state: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
        updated_at: this.now(),
      });
    }
    try {
      this.git.inspect(current, identity.repoRoot);
      return current;
    } catch (error) {
      this.records.write({
        ...current,
        state: CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
        updated_at: this.now(),
      });
      throw error;
    }
  }

  bindTask(
    record: ConversationDelegationWorkspaceRecordV1,
    task: ReturnType<typeof canonicalTaskBinding>,
    live: { head: string; dirty: boolean },
  ): ConversationDelegationWorkspaceRecordV1 {
    if (taskBindingMatches(record, task)) return record;
    if (record.task_id === task.task_id) fail("coordination task binding changed");
    const priorTaskVerified = record.verified_head === live.head;
    const priorTaskUntouched = record.verified_head === null && record.task_base_head === live.head;
    if (
      record.task_id !== null &&
      (live.dirty ||
        (!priorTaskVerified && !priorTaskUntouched) ||
        record.lease_count > 0 ||
        record.review_count > 0)
    )
      fail("a new coordination task requires a verified or untouched prior checkpoint");
    return this.records.write({
      ...record,
      task_id: task.task_id,
      task_contract_digest: task.contract_digest,
      task_scope: task.scope,
      task_forbidden: task.forbidden,
      task_verify_oracles: task.verify_oracles,
      task_base_head: live.head,
      verified_head: null,
      verification_evidence_refs: [],
      updated_at: this.now(),
    });
  }

  reconcileDurableOwners(
    record: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): ConversationDelegationWorkspaceRecordV1 {
    let next = record;
    if (next.lease_owner) {
      const status = this.ownership.status(next.lease_owner);
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN)
        fail("coordination workspace lease owner is uncertain");
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.STALE)
        next = this.records.write({
          ...next,
          lease_owner: null,
          lease_count: 0,
          updated_at: this.now(),
        });
    }
    if (next.review_owner) {
      const status = this.ownership.status(next.review_owner);
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN)
        fail("coordination review lease owner is uncertain");
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.STALE) {
        this.git.removeReview(next.workspace_id, repoRoot);
        next = this.records.write({
          ...next,
          review_owner: null,
          review_count: 0,
          review_head: null,
          updated_at: this.now(),
        });
      }
    }
    return next;
  }

  reconcileVerifying(
    record: ConversationDelegationWorkspaceRecordV1,
  ): ConversationDelegationWorkspaceRecordV1 {
    if (record.state !== CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING) return record;
    if (record.verification_owner) {
      const status = this.ownership.status(record.verification_owner);
      if (
        status === CONVERSATION_DELEGATION_OWNER_STATUS.SELF ||
        status === CONVERSATION_DELEGATION_OWNER_STATUS.LIVE
      )
        fail("coordination workspace verification is owned by a live authority");
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN)
        fail("coordination workspace verifier owner is uncertain");
    }
    return this.records.write({
      ...record,
      state: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
      verified_head: null,
      verification_evidence_refs: [],
      verification_owner: null,
      verification_attempt_id: null,
      verification_changed_paths: [],
      verification_expected_oracles: [],
      updated_at: this.now(),
    });
  }

  releaseExecutor(workspaceId: string): void {
    this.records.withLock(() => {
      const record = this.records.read(workspaceId);
      if (!record?.lease_owner) return;
      if (this.ownership.status(record.lease_owner) !== CONVERSATION_DELEGATION_OWNER_STATUS.SELF)
        fail("coordination workspace lease release authority changed");
      const remaining = record.lease_count - 1;
      this.records.write({
        ...record,
        lease_owner: remaining === 0 ? null : record.lease_owner,
        lease_count: remaining,
        updated_at: this.now(),
      });
    });
  }

  releaseReview(workspaceId: string, repoRoot: string): void {
    this.records.withLock(() => {
      const record = this.records.read(workspaceId);
      if (!record?.review_owner) return;
      if (this.ownership.status(record.review_owner) !== CONVERSATION_DELEGATION_OWNER_STATUS.SELF)
        fail("coordination review lease release authority changed");
      const remaining = record.review_count - 1;
      if (remaining === 0) this.git.removeReview(workspaceId, repoRoot);
      this.records.write({
        ...record,
        review_owner: remaining === 0 ? null : record.review_owner,
        review_count: remaining,
        review_head: remaining === 0 ? null : record.review_head,
        updated_at: this.now(),
      });
    });
  }

  finishPromotion(
    record: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): ConversationCoordinationWorkspaceObservationV1 {
    try {
      this.git.promoteAndRemove(record, repoRoot);
      return this.observation(
        this.records.write({
          ...record,
          dirty: false,
          state: CONVERSATION_DELEGATION_WORKSPACE_STATE.SETTLED,
          updated_at: this.now(),
        }),
      );
    } catch (error) {
      this.records.write({
        ...record,
        state: CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
        updated_at: this.now(),
      });
      throw error;
    }
  }

  private create(
    input: ConversationDelegationWorkspaceIdentityV1,
    identity: ReturnType<ConversationDelegationWorkspaceLifecycleV1["identity"]>,
  ): ConversationDelegationWorkspaceRecordV1 {
    const base = this.git.primaryBase(identity.repoRoot);
    const timestamp = this.now();
    const pending = this.records.write({
      schema_version: "1.0",
      workspace_id: identity.workspaceId,
      workflow_id: input.workflowId,
      workspace_key: input.workspaceKey,
      workspace_key_digest: identity.workspaceKeyDigest,
      repo_root_digest: identity.repoRootDigest,
      base_head: base.head,
      primary_ref: base.primaryRef,
      head: base.head,
      branch_ref: identity.branchRef,
      state: CONVERSATION_DELEGATION_WORKSPACE_STATE.PENDING,
      dirty: false,
      lease_owner: null,
      lease_count: 0,
      review_owner: null,
      review_count: 0,
      review_head: null,
      task_id: null,
      task_contract_digest: null,
      task_scope: [],
      task_forbidden: [],
      task_verify_oracles: [],
      task_base_head: null,
      verified_head: null,
      verification_evidence_refs: [],
      verification_owner: null,
      verification_attempt_id: null,
      verification_changed_paths: [],
      verification_expected_oracles: [],
      created_at: timestamp,
      updated_at: timestamp,
    });
    this.git.create(pending, identity.repoRoot);
    this.git.inspect(pending, identity.repoRoot);
    return this.records.write({
      ...pending,
      state: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
      updated_at: this.now(),
    });
  }

  private assertIdentity(
    record: ConversationDelegationWorkspaceRecordV1,
    input: ConversationDelegationWorkspaceIdentityV1,
    identity: ReturnType<ConversationDelegationWorkspaceLifecycleV1["identity"]>,
  ): void {
    if (
      record.workflow_id !== input.workflowId ||
      record.workspace_key !== input.workspaceKey ||
      record.workspace_key_digest !== identity.workspaceKeyDigest ||
      record.repo_root_digest !== identity.repoRootDigest ||
      record.branch_ref !== identity.branchRef
    )
      fail("coordination workspace identity changed");
  }
}

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createIsolationLease } from "../../dispatch/isolation.js";
import { ENGINE_ISOLATION_KIND } from "../../dispatch/session-contract.js";
import type { IsolationLeaseProjection } from "../../dispatch/session-types.js";
import {
  CONVERSATION_COORDINATION_SETTLEMENT,
  type ConversationCoordinationSettlementV1,
  type ConversationCoordinationWorkspaceObservationV1,
} from "./conversation-coordination-contract.js";
import type {
  ConversationDelegationWorkspaceAuthorityOptionsV1,
  ConversationDelegationWorkspaceIdentityV1,
  ConversationDelegationWorkspaceLeaseInputV1,
  ConversationDelegationWorkspaceVerifyInputV1,
} from "./conversation-delegation-workspace-contract.js";
import { ConversationDelegationWorkspaceGitV1 } from "./conversation-delegation-workspace-git.js";
import { ConversationDelegationWorkspaceLifecycleV1 } from "./conversation-delegation-workspace-lifecycle.js";
import {
  CONVERSATION_DELEGATION_OWNER_STATUS,
  ConversationDelegationWorkspaceOwnershipV1,
} from "./conversation-delegation-workspace-ownership.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_STATE,
  ConversationDelegationWorkspaceRecordStoreV1,
} from "./conversation-delegation-workspace-records.js";
import { canonicalTaskBinding } from "./conversation-delegation-workspace-task.js";
import { ConversationDelegationWorkspaceVerificationStoreV1 } from "./conversation-delegation-workspace-verification.js";
import { ConversationDelegationWorkspaceVerifyRuntimeV1 } from "./conversation-delegation-workspace-verify-runtime.js";

export {
  CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT,
  type ConversationDelegationWorkspaceAuthorityOptionsV1,
  type ConversationDelegationWorkspaceFaultPointV1,
  type ConversationDelegationWorkspaceIdentityV1,
  type ConversationDelegationWorkspaceLeaseInputV1,
  type ConversationDelegationWorkspaceVerifyInputV1,
} from "./conversation-delegation-workspace-contract.js";
export type {
  ConversationDelegationTaskBindingV1,
  ConversationDelegationTaskCompletionV1,
} from "./conversation-delegation-workspace-task.js";

const fail = (message: string): never => {
  throw new Error(message);
};

/** Durable cross-process authority for executor worktrees and detached coordinator review views. */
export class ConversationDelegationWorkspaceAuthorityV1 {
  private readonly records: ConversationDelegationWorkspaceRecordStoreV1;
  private readonly git: ConversationDelegationWorkspaceGitV1;
  private readonly ownership: ConversationDelegationWorkspaceOwnershipV1;
  private readonly lifecycle: ConversationDelegationWorkspaceLifecycleV1;
  private readonly verifier: ConversationDelegationWorkspaceVerifyRuntimeV1;
  private readonly now: () => string;

  constructor(options: ConversationDelegationWorkspaceAuthorityOptionsV1) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.records = new ConversationDelegationWorkspaceRecordStoreV1(options.artifactRoot);
    this.git = new ConversationDelegationWorkspaceGitV1(options);
    this.ownership = new ConversationDelegationWorkspaceOwnershipV1({
      platform: options.ownedProcessPlatform,
      pid: options.ownerPid,
      authorityId: options.authorityId,
      createAttemptId: options.createVerificationAttemptId,
    });
    this.lifecycle = new ConversationDelegationWorkspaceLifecycleV1(
      this.records,
      this.git,
      this.ownership,
      this.now,
    );
    this.verifier = new ConversationDelegationWorkspaceVerifyRuntimeV1(
      this.records,
      this.git,
      this.ownership,
      this.lifecycle,
      new ConversationDelegationWorkspaceVerificationStoreV1(
        resolve(options.artifactRoot),
        this.now,
      ),
      options.verify,
      this.now,
      options.fault ?? (() => {}),
    );
  }

  lease(input: ConversationDelegationWorkspaceLeaseInputV1): IsolationLeaseProjection {
    const task = canonicalTaskBinding(input.task);
    const record = this.records.withLock(() => {
      let current = this.lifecycle.ensureActive(input);
      current = this.lifecycle.reconcileDurableOwners(current, input.repoRoot);
      if (current.review_count > 0) fail("coordination workspace review lease is active");
      const live = this.git.inspect(current, input.repoRoot);
      current = this.lifecycle.bindTask(current, task, live);
      const status = current.lease_owner
        ? this.ownership.status(current.lease_owner)
        : CONVERSATION_DELEGATION_OWNER_STATUS.STALE;
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.LIVE)
        fail("coordination workspace lease is owned by another live authority");
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN)
        fail("coordination workspace lease owner is uncertain");
      const owner =
        status === CONVERSATION_DELEGATION_OWNER_STATUS.SELF
          ? current.lease_owner
          : this.ownership.current();
      return this.records.write({
        ...current,
        ...live,
        lease_owner: owner,
        lease_count:
          status === CONVERSATION_DELEGATION_OWNER_STATUS.SELF ? current.lease_count + 1 : 1,
        updated_at: this.now(),
      });
    });
    try {
      return this.isolationLease(
        this.git.path(record.workspace_id),
        input.repoRoot,
        `coordination-workspace:${record.record_digest}`,
        () => this.lifecycle.releaseExecutor(record.workspace_id),
      );
    } catch (error) {
      this.lifecycle.releaseExecutor(record.workspace_id);
      throw error;
    }
  }

  reviewLease(input: ConversationDelegationWorkspaceIdentityV1): IsolationLeaseProjection {
    const record = this.records.withLock(() => {
      let current = this.lifecycle.loadForUse(input);
      current = this.lifecycle.reconcileDurableOwners(current, input.repoRoot);
      if (current.lease_count > 0) fail("coordination workspace executor lease is active");
      const live = this.git.inspect(current, input.repoRoot);
      if (live.dirty || !current.verified_head || current.verified_head !== live.head)
        fail("coordination review requires an exact verified workspace head");
      const status = current.review_owner
        ? this.ownership.status(current.review_owner)
        : CONVERSATION_DELEGATION_OWNER_STATUS.STALE;
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.LIVE)
        fail("coordination review lease is owned by another live authority");
      if (status === CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN)
        fail("coordination review lease owner is uncertain");
      this.git.createReview(current, input.repoRoot);
      return this.records.write({
        ...current,
        review_owner:
          status === CONVERSATION_DELEGATION_OWNER_STATUS.SELF
            ? current.review_owner
            : this.ownership.current(),
        review_count:
          status === CONVERSATION_DELEGATION_OWNER_STATUS.SELF ? current.review_count + 1 : 1,
        review_head: current.verified_head,
        updated_at: this.now(),
      });
    });
    try {
      return this.isolationLease(
        this.git.reviewPath(record.workspace_id),
        input.repoRoot,
        `coordination-review:${record.verified_head}:${record.record_digest}`,
        () => this.lifecycle.releaseReview(record.workspace_id, input.repoRoot),
      );
    } catch (error) {
      this.lifecycle.releaseReview(record.workspace_id, input.repoRoot);
      throw error;
    }
  }

  observe(
    input: ConversationDelegationWorkspaceIdentityV1,
  ): ConversationCoordinationWorkspaceObservationV1 {
    return this.records.withLock(() => {
      const found = this.lifecycle.readBound(input);
      if (!found) return this.lifecycle.absent(input.workspaceKey);
      let record = this.lifecycle.reconcileVerifying(found);
      if (record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.PROMOTING)
        fail("coordination workspace promotion is active");
      record = this.lifecycle.reconcileDurableOwners(record, input.repoRoot);
      const live = this.git.inspect(record, input.repoRoot);
      const verified = record.verified_head === live.head && !live.dirty;
      return this.lifecycle.observation(
        this.records.write({
          ...record,
          ...live,
          verified_head: verified ? record.verified_head : null,
          verification_evidence_refs: verified ? record.verification_evidence_refs : [],
          updated_at: this.now(),
        }),
      );
    });
  }

  settle(
    input: ConversationDelegationWorkspaceIdentityV1,
    outcome: ConversationCoordinationSettlementV1,
  ): ConversationCoordinationWorkspaceObservationV1 {
    return this.records.withLock(() => {
      const found = this.lifecycle.readBound(input);
      if (!found) return this.lifecycle.absent(input.workspaceKey);
      if (found.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.SETTLED)
        return this.lifecycle.observation(found);
      let record = this.lifecycle.reconcileVerifying(found);
      record = this.lifecycle.reconcileDurableOwners(record, input.repoRoot);
      if (record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.PROMOTING)
        return this.lifecycle.finishPromotion(record, input.repoRoot);
      const live = this.git.inspect(record, input.repoRoot);
      if (outcome === CONVERSATION_COORDINATION_SETTLEMENT.NEEDS_INPUT)
        return this.lifecycle.observation(
          this.records.write({ ...record, ...live, updated_at: this.now() }),
        );
      if (
        outcome === CONVERSATION_COORDINATION_SETTLEMENT.FAILED ||
        live.dirty ||
        record.verified_head !== live.head ||
        record.lease_count > 0 ||
        record.review_count > 0
      ) {
        const recovery = this.records.write({
          ...record,
          ...live,
          state: CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
          updated_at: this.now(),
        });
        if (outcome === CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED)
          fail("coordination workspace is not clean and quiescent");
        return this.lifecycle.observation(recovery);
      }
      return this.lifecycle.finishPromotion(
        this.records.write({
          ...record,
          ...live,
          state: CONVERSATION_DELEGATION_WORKSPACE_STATE.PROMOTING,
          updated_at: this.now(),
        }),
        input.repoRoot,
      );
    });
  }

  verify(
    input: ConversationDelegationWorkspaceVerifyInputV1,
  ): Promise<ConversationCoordinationWorkspaceObservationV1> {
    return this.verifier.verify(input);
  }

  private isolationLease(
    path: string,
    repoRoot: string,
    evidenceRef: string,
    release: () => void,
  ): IsolationLeaseProjection {
    return createIsolationLease({
      kind: ENGINE_ISOLATION_KIND.WORKTREE,
      root: path,
      cwd: path,
      repoRoot: realpathSync(resolve(repoRoot)),
      evidence_ref: evidenceRef,
      release,
    });
  }
}

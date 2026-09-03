import type { ConversationCoordinationWorkspaceObservationV1 } from "./conversation-coordination-contract.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT,
  type ConversationDelegationWorkspaceFaultPointV1,
  type ConversationDelegationWorkspaceVerifyInputV1,
} from "./conversation-delegation-workspace-contract.js";
import type { ConversationDelegationWorkspaceGitV1 } from "./conversation-delegation-workspace-git.js";
import type { ConversationDelegationWorkspaceLifecycleV1 } from "./conversation-delegation-workspace-lifecycle.js";
import type { ConversationDelegationWorkspaceOwnershipV1 } from "./conversation-delegation-workspace-ownership.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_STATE,
  type ConversationDelegationWorkspaceRecordStoreV1,
  type ConversationDelegationWorkspaceRecordV1,
} from "./conversation-delegation-workspace-records.js";
import {
  assertChangedPathsInScope,
  assertChangedPathsNotForbidden,
  canonicalTaskCompletion,
} from "./conversation-delegation-workspace-task.js";
import type {
  ConversationDelegationWorkspaceVerificationStoreV1,
  ConversationDelegationWorkspaceVerifierV1,
} from "./conversation-delegation-workspace-verification.js";

const fail = (message: string): never => {
  throw new Error(message);
};
const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export class ConversationDelegationWorkspaceVerifyRuntimeV1 {
  constructor(
    private readonly records: ConversationDelegationWorkspaceRecordStoreV1,
    private readonly git: ConversationDelegationWorkspaceGitV1,
    private readonly ownership: ConversationDelegationWorkspaceOwnershipV1,
    private readonly lifecycle: ConversationDelegationWorkspaceLifecycleV1,
    private readonly verifications: ConversationDelegationWorkspaceVerificationStoreV1,
    private readonly verifier: ConversationDelegationWorkspaceVerifierV1 | undefined,
    private readonly now: () => string,
    private readonly fault: (point: ConversationDelegationWorkspaceFaultPointV1) => void,
  ) {}

  async verify(
    input: ConversationDelegationWorkspaceVerifyInputV1,
  ): Promise<ConversationCoordinationWorkspaceObservationV1> {
    const verifier = this.verifier ?? fail("coordination workspace verifier is unavailable");
    const completion = canonicalTaskCompletion(input.completion);
    const prepared = this.records.withLock(() => this.prepare(input, completion));
    this.fault(CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT.VERIFYING_PERSISTED);
    let verification: Awaited<ReturnType<ConversationDelegationWorkspaceVerifierV1>>;
    try {
      verification = await verifier({
        cwd: prepared.cwd,
        expected_oracles: prepared.record.verification_expected_oracles,
      });
    } catch (error) {
      this.restoreFailure(prepared.record, input.repoRoot);
      throw error;
    }
    let proof: ReturnType<ConversationDelegationWorkspaceVerificationStoreV1["write"]>;
    try {
      proof = this.records.withLock(() => {
        const current = this.assertCheckpoint(prepared.record, input.repoRoot);
        return this.verifications.write(current, verification);
      });
    } catch (error) {
      this.recoverCheckpointFailure(prepared.record, input.repoRoot);
      throw error;
    }
    this.fault(CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT.VERIFICATION_PROOF_PERSISTED);
    try {
      return this.records.withLock(() => {
        const current = this.assertCheckpoint(prepared.record, input.repoRoot);
        const evidence = `coordination-workspace-verification:${proof.proof_digest}`;
        return this.lifecycle.observation(
          this.records.write({
            ...current,
            state: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
            verified_head: proof.passed ? current.head : null,
            verification_evidence_refs: proof.passed ? [evidence] : [],
            verification_owner: null,
            verification_attempt_id: null,
            verification_changed_paths: [],
            verification_expected_oracles: [],
            updated_at: this.now(),
          }),
        );
      });
    } catch (error) {
      this.recoverCheckpointFailure(prepared.record, input.repoRoot);
      throw error;
    }
  }

  private prepare(
    input: ConversationDelegationWorkspaceVerifyInputV1,
    completion: ReturnType<typeof canonicalTaskCompletion>,
  ): { record: ConversationDelegationWorkspaceRecordV1; cwd: string } {
    let record = this.lifecycle.loadForUse(input);
    record = this.lifecycle.reconcileDurableOwners(record, input.repoRoot);
    if (record.lease_count > 0 || record.review_count > 0)
      fail("coordination workspace is not clean and quiescent");
    if (!record.task_id || completion.task_id !== record.task_id)
      fail("coordination completion does not match the active task");
    if (!sameList(completion.commands, record.task_verify_oracles))
      fail("coordination completion commands do not match the bound verification oracles");
    const live = this.git.inspect(record, input.repoRoot);
    if (live.dirty) fail("coordination workspace is not clean and quiescent");
    if (!record.task_base_head || live.head === record.task_base_head)
      fail("coordination workspace has no delegated commit for the active task");
    const changed = this.git.changedPaths(record, live.head);
    if (!sameList(changed, completion.changed_paths))
      fail("coordination completion paths do not match the exact Git diff");
    assertChangedPathsInScope(changed, record.task_scope);
    assertChangedPathsNotForbidden(changed, record.task_forbidden);
    const verifying = this.records.write({
      ...record,
      ...live,
      verified_head: null,
      verification_evidence_refs: [],
      verification_owner: this.ownership.current(),
      verification_attempt_id: this.ownership.attemptId(),
      verification_changed_paths: changed,
      verification_expected_oracles: [...record.task_verify_oracles],
      state: CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING,
      updated_at: this.now(),
    });
    return { record: verifying, cwd: this.git.path(verifying.workspace_id) };
  }

  private assertCheckpoint(
    prepared: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): ConversationDelegationWorkspaceRecordV1 {
    const current =
      this.records.read(prepared.workspace_id) ??
      fail("coordination workspace verification authority changed");
    if (
      current.state !== CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING ||
      current.head !== prepared.head ||
      current.verification_attempt_id !== prepared.verification_attempt_id ||
      current.verification_owner?.authority_id !== prepared.verification_owner?.authority_id
    )
      fail("coordination workspace verification authority changed");
    const live = this.git.inspect(current, repoRoot);
    const changed = this.git.changedPaths(current, live.head);
    if (
      live.dirty ||
      live.head !== prepared.head ||
      current.lease_count > 0 ||
      current.review_count > 0 ||
      !sameList(changed, current.verification_changed_paths) ||
      !sameList(current.verification_expected_oracles, prepared.verification_expected_oracles) ||
      !sameList(current.verification_expected_oracles, current.task_verify_oracles)
    )
      fail("coordination workspace changed during verification");
    assertChangedPathsInScope(changed, current.task_scope);
    assertChangedPathsNotForbidden(changed, current.task_forbidden);
    return current;
  }

  private restoreFailure(
    prepared: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): void {
    this.records.withLock(() => {
      const current = this.records.read(prepared.workspace_id);
      const exactAttempt =
        current?.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING &&
        current.verification_attempt_id === prepared.verification_attempt_id;
      if (!current || !exactAttempt) return;
      let live: { head: string; dirty: boolean };
      try {
        live = this.git.inspect(current, repoRoot);
      } catch {
        const uncertain = { head: current.head, dirty: true };
        live = uncertain;
      }
      const unchanged = live.head === prepared.head && !live.dirty;
      this.records.write({
        ...current,
        ...live,
        state: unchanged
          ? CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE
          : CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
        verified_head: null,
        verification_evidence_refs: [],
        verification_owner: null,
        verification_attempt_id: null,
        verification_changed_paths: [],
        verification_expected_oracles: [],
        updated_at: this.now(),
      });
    });
  }

  private recoverCheckpointFailure(
    prepared: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): void {
    this.records.withLock(() => {
      const current = this.records.read(prepared.workspace_id);
      if (
        !current ||
        current.state !== CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING ||
        current.verification_attempt_id !== prepared.verification_attempt_id
      )
        return;
      let live: { head: string; dirty: boolean };
      try {
        live = this.git.inspect(current, repoRoot);
      } catch {
        live = { head: current.head, dirty: true };
      }
      this.records.write({
        ...current,
        ...live,
        state: CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
        verified_head: null,
        verification_evidence_refs: [],
        verification_owner: null,
        verification_attempt_id: null,
        verification_changed_paths: [],
        verification_expected_oracles: [],
        updated_at: this.now(),
      });
    });
  }
}

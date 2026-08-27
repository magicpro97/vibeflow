import {
  ACTION_OPERATION_STATE,
  assertApproval,
  assertProposal,
  deriveOperationId,
} from "../../actions/index.js";
import { canonicalJson } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { assertCurrentOrdinaryAuthorityProposal } from "./binding.js";
import { materializeOperationHeader } from "./contracts.js";
import { prevalidateOrdinaryAuthorityExecution } from "./execution-prevalidation.js";
import { recordOrdinaryAuthorityTerminalReceipt } from "./execution-terminalization.js";
import type { StagedOrdinaryAuthorityTransitionV1 } from "./frames.js";
import { OrdinaryAuthorityProposalPlannerV1 } from "./planner.js";
import { policySettingsRawSha256 } from "./policy.js";
import { recoverOrdinaryAuthorityPrefixes } from "./recovery.js";
import { OrdinaryAuthorityActionResolverV1 } from "./resolver.js";
import { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import type {
  AuthorityChangeOperationV1,
  AuthorityChangeTerminalReceiptV1,
  OrdinaryAuthorityMutationDomainV1,
  OrdinaryAuthorityMutationOptionsV1,
  OrdinaryAuthorityTerminalEvidenceV1,
} from "./types.js";
import {
  AUTHORITY_CHANGE_TERMINAL_OUTCOME,
  AUTHORITY_CHANGE_TERMINAL_REASON,
  ORDINARY_AUTHORITY_MUTATION_FAULT_POINT,
} from "./types.js";

function fail(message: string, path = "authority.mutation"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isExactPrefix<T>(observed: readonly T[], expected: readonly T[]): boolean {
  return (
    observed.length <= expected.length &&
    observed.every((row, index) => exact(row, expected[index]))
  );
}

function tailsAreEmpty(snapshot: ReturnType<typeof recoverOrdinaryAuthorityPrefixes>): boolean {
  return (
    snapshot.event_tail.length === 0 &&
    snapshot.grant_tail.length === 0 &&
    snapshot.policy_tail.length === 0 &&
    snapshot.secret_tail.length === 0 &&
    snapshot.trust_tail.length === 0
  );
}

export class OrdinaryAuthorityMutationServiceV1 implements OrdinaryAuthorityMutationDomainV1 {
  readonly store: OrdinaryAuthorityDurableStoreV1;
  readonly resolver: OrdinaryAuthorityActionResolverV1;
  private readonly planner: OrdinaryAuthorityProposalPlannerV1;

  constructor(readonly options: OrdinaryAuthorityMutationOptionsV1) {
    this.store = new OrdinaryAuthorityDurableStoreV1(
      options.paths,
      options.authority_transition_resolver,
    );
    this.planner = new OrdinaryAuthorityProposalPlannerV1(this.store, options);
    this.resolver = new OrdinaryAuthorityActionResolverV1(this.store, options, (operationId) =>
      this.readTerminal(operationId),
    );
  }

  prepareProposal: OrdinaryAuthorityMutationDomainV1["prepareProposal"] = (input) =>
    this.planner.prepare(input);

  prepareApproved(
    proposal: import("../../actions/index.js").ActionProposalV1,
    approval: import("../../actions/index.js").ActionApprovalV1,
  ): AuthorityChangeOperationV1 {
    assertProposal(proposal);
    assertApproval(proposal, approval);
    return this.store.withAuthorityLock("ordinary-authority-prepare-approved", (store, lock) => {
      const closure = assertCurrentOrdinaryAuthorityProposal({
        store,
        proposal,
        options: this.options,
        now: this.options.now?.() ?? new Date().toISOString(),
      });
      const recorded = this.options.action_authority().getRecorded(proposal.proposal_id);
      if (
        !recorded ||
        recorded.state !== ACTION_OPERATION_STATE.APPROVED ||
        !recorded.approval ||
        recorded.approval.approval_id !== approval.approval_id ||
        !exact(recorded.proposal, proposal) ||
        !exact(recorded.approval, approval)
      )
        return fail("operation header requires exact approved Action authority");
      const header = materializeOperationHeader({
        schema_version: "1.0",
        operation_id: deriveOperationId(proposal, approval.approval_id),
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        approval_id: approval.approval_id,
        approval_digest: approval.approval_digest,
        action_type: closure.plan.authority_action.type,
        action_root_locator: structuredClone(closure.action_plan.action_root_locator),
        action_plan_binding_digest: proposal.plan_digest,
        authority_change_plan_digest: closure.plan.plan_digest,
        scope: closure.plan.scope,
        scope_identity_digest: closure.plan.scope_identity_digest,
        change: closure.plan.change,
        authority_subject_id: closure.plan.authority_subject_id,
        expected_authority_epoch: closure.plan.expected_authority_epoch,
        expected_authority_head_digest: closure.plan.expected_authority_head_digest,
        expected_domain_head_digest: closure.plan.expected_domain_head_digest,
        proposed_effect_digest: closure.plan.proposed_effect_digest,
        recovery_plan_digest: closure.effect.plan_digest,
        permission_digest: closure.plan.permission_digest,
        created_at: approval.decided_at,
      });
      store.writeOperationHeaderHeld(header, lock);
      this.options.fault?.("after-operation-header");
      return header;
    });
  }

  private terminalReceipt(
    header: AuthorityChangeOperationV1,
    outcome: AuthorityChangeTerminalReceiptV1["outcome"],
    reason: AuthorityChangeTerminalReceiptV1["reason_code"],
    observedHead: string,
    lock: import("../../durability/index.js").ProcessLock,
  ): OrdinaryAuthorityTerminalEvidenceV1 {
    return recordOrdinaryAuthorityTerminalReceipt({
      store: this.store,
      header,
      outcome,
      reason,
      observed_authority_head_digest: observedHead,
      recorded_at: this.options.now?.() ?? new Date().toISOString(),
      lock,
    });
  }

  private ownsEveryTail(
    snapshot: ReturnType<typeof recoverOrdinaryAuthorityPrefixes>,
    staged: StagedOrdinaryAuthorityTransitionV1,
  ): boolean {
    const expectedGrant = staged.grant ? [staged.grant] : [];
    const expectedPolicy = staged.policy ? [...staged.policy] : [];
    const expectedSecret = staged.secret ? [staged.secret] : [];
    const expectedTrust = staged.trust ? [staged.trust] : [];
    return !(
      !isExactPrefix(snapshot.grant_tail, expectedGrant) ||
      !isExactPrefix(snapshot.policy_tail, expectedPolicy) ||
      !isExactPrefix(snapshot.secret_tail, expectedSecret) ||
      !isExactPrefix(snapshot.trust_tail, expectedTrust) ||
      !isExactPrefix(snapshot.event_tail, [staged.event])
    );
  }

  private appendStaged(
    staged: StagedOrdinaryAuthorityTransitionV1,
    snapshot: ReturnType<typeof recoverOrdinaryAuthorityPrefixes>,
    lock: import("../../durability/index.js").ProcessLock,
    policyBytes: { preimage: Buffer | null; replacement: Buffer | null },
  ): void {
    if (staged.grant && snapshot.grant_tail.length === 0)
      this.store.appendGrantHeld(staged.grant, lock);
    if (staged.secret && snapshot.secret_tail.length === 0)
      this.store.appendSecretHeld(staged.secret, lock);
    if (staged.trust && snapshot.trust_tail.length === 0)
      this.store.appendTrustHeld(staged.trust, lock);
    if (staged.grant || staged.secret || staged.trust) this.options.fault?.("after-domain-frame");
    if (staged.policy) {
      if (snapshot.policy_tail.length === 0) this.store.appendPolicyHeld(staged.policy[0], lock);
      if (snapshot.policy_tail.length < 2) this.store.appendPolicyHeld(staged.policy[1], lock);
      this.options.fault?.("after-policy-effect-in-progress");
      const preimage = policyBytes.preimage ?? fail("policy preimage bytes are absent");
      const replacement = policyBytes.replacement ?? fail("policy replacement bytes are absent");
      const live = this.store.readRaw().settings;
      if (live.equals(preimage)) this.store.replaceSettings(preimage, replacement);
      else if (!live.equals(replacement))
        fail(
          "policy settings are neither the approved preimage nor replacement",
          "authority.recovery",
        );
      this.options.fault?.("after-policy-settings-cas");
      if (snapshot.policy_tail.length < 3) this.store.appendPolicyHeld(staged.policy[2], lock);
      this.options.fault?.("after-policy-observed");
    }
    if (snapshot.event_tail.length === 0) this.store.appendEventHeld(staged.event, lock);
    this.options.fault?.("after-epoch-event");
  }

  execute(operationId: string): OrdinaryAuthorityTerminalEvidenceV1 {
    return this.store.withAuthorityLock(
      `ordinary-authority-execute:${operationId}`,
      (store, lock) => {
        const existing = this.readTerminal(operationId);
        if (existing) return existing;
        const header = store.readOperationHeader(operationId);
        if (!header) return fail("authority operation header is absent");
        const raw = store.readRaw();
        let snapshot: ReturnType<typeof recoverOrdinaryAuthorityPrefixes>;
        try {
          this.options.fault?.(ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_RECOVERY_PREFIX_READ);
          snapshot = recoverOrdinaryAuthorityPrefixes(store, raw);
        } catch {
          return this.terminalReceipt(
            header,
            AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
            AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
            raw.current.content_digest,
            lock,
          );
        }
        const prior = snapshot.committed.current;
        let recorded: import("../../actions/index.js").ActionAuthoritySnapshotV1 | null;
        try {
          this.options.fault?.(ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_ACTION_CLOSURE_READ);
          recorded = this.options.action_authority().getRecorded(header.proposal_id);
          const dispatch = this.options.action_authority().getDispatch(operationId);
          if (!recorded?.approval || !dispatch || recorded.operation_id !== operationId)
            return fail("committing Action authority/dispatch closure is absent");
          if (
            recorded.state !== ACTION_OPERATION_STATE.COMMITTING &&
            recorded.state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY
          )
            return fail("ordinary authority execution requires committing Action authority");
          if (dispatch.domain_header_digest !== header.header_digest)
            return fail("dispatch does not bind the authority operation header");
        } catch {
          return this.terminalReceipt(
            header,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED
              : AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_REASON.PRE_EFFECT_REVALIDATION_FAILED
              : AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
            prior.content_digest,
            lock,
          );
        }
        if (
          prior.content_digest !== header.expected_authority_head_digest ||
          prior.authority_epoch !== header.expected_authority_epoch
        )
          return this.terminalReceipt(
            header,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED
              : AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_REASON.AUTHORITY_STALE
              : AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
            prior.content_digest,
            lock,
          );
        let prepared: ReturnType<typeof prevalidateOrdinaryAuthorityExecution>;
        try {
          this.options.fault?.(
            ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_PRE_EFFECT_REVALIDATION,
          );
          prepared = prevalidateOrdinaryAuthorityExecution({
            store,
            options: this.options,
            recorded,
            header,
            snapshot,
          });
        } catch {
          return this.terminalReceipt(
            header,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED
              : AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
            tailsAreEmpty(snapshot)
              ? AUTHORITY_CHANGE_TERMINAL_REASON.PRE_EFFECT_REVALIDATION_FAILED
              : AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
            prior.content_digest,
            lock,
          );
        }
        const { closure, staged } = prepared;
        if (!this.ownsEveryTail(snapshot, staged))
          return this.terminalReceipt(
            header,
            AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
            AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
            prior.content_digest,
            lock,
          );
        if (closure.preimage && closure.replacement) {
          const liveHash = policySettingsRawSha256(snapshot.committed.settings);
          if (
            liveHash !== policySettingsRawSha256(closure.preimage) &&
            liveHash !== policySettingsRawSha256(closure.replacement)
          )
            return this.terminalReceipt(
              header,
              AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY,
              AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN,
              prior.content_digest,
              lock,
            );
        }
        store.checkpointHeld(prior, lock);
        this.appendStaged(staged, snapshot, lock, {
          preimage: closure.preimage,
          replacement: closure.replacement,
        });
        store.replaceHeadHeld(prior, staged.next, lock);
        this.options.fault?.("after-epoch-head");
        return {
          operation_id: operationId,
          outcome: ACTION_OPERATION_STATE.SUCCEEDED,
          domain_terminal_digest: staged.event.event_digest,
          recorded_at: staged.event.recorded_at,
          authority_head: staged.next,
          event: staged.event,
          receipt: null,
        };
      },
    );
  }

  readTerminal(operationId: string): OrdinaryAuthorityTerminalEvidenceV1 | null {
    const header = this.store.readOperationHeader(operationId);
    if (!header) return null;
    const raw = this.store.readRaw();
    const committedEvents = raw.events.slice(0, raw.current.authority_epoch);
    const event = committedEvents.find((row) => row.operation_id === operationId);
    if (event) {
      if (
        event.operation_header_digest !== header.header_digest ||
        event.proposal_id !== header.proposal_id ||
        event.approval_id !== header.approval_id ||
        event.plan_digest !== header.authority_change_plan_digest
      )
        return fail("committed authority terminal event escaped its operation header");
      return {
        operation_id: operationId,
        outcome: ACTION_OPERATION_STATE.SUCCEEDED,
        domain_terminal_digest: event.event_digest,
        recorded_at: event.recorded_at,
        authority_head:
          raw.current.updated_by_operation_id === operationId ? structuredClone(raw.current) : null,
        event,
        receipt: null,
      };
    }
    const receipt = this.store.readTerminalReceipts(operationId).at(-1);
    if (!receipt) return null;
    if (
      receipt.operation_header_digest !== header.header_digest ||
      receipt.proposal_id !== header.proposal_id ||
      receipt.approval_id !== header.approval_id ||
      receipt.plan_digest !== header.authority_change_plan_digest
    )
      return fail("authority terminal receipt escaped its operation header");
    return {
      operation_id: operationId,
      outcome: receipt.outcome,
      domain_terminal_digest: receipt.receipt_digest,
      recorded_at: receipt.recorded_at,
      authority_head: null,
      event: null,
      receipt,
    };
  }
}

export function createOrdinaryAuthorityMutationDomain(
  options: OrdinaryAuthorityMutationOptionsV1,
): OrdinaryAuthorityMutationDomainV1 {
  return new OrdinaryAuthorityMutationServiceV1(options);
}

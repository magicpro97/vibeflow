import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isCapabilityHostActionKind } from "../actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  type DurableActionAuthorityReaderV1,
  type PrivateActionRootLocatorV1,
  assertApproval,
  assertDurableActionAuthorityReaderV1,
  assertProposal,
  isActionOperationDispatchReplayState,
  materializeDispatchRecord,
} from "../actions/index.js";
import { ACTION_DOMAIN } from "../actions/public-action-contract.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
  type CapabilityScope,
} from "../core/capability-contract.js";
import { canonicalJson } from "../durability/index.js";
import type { CapabilityActionObjectStoreV1 } from "./action-domain/object-store.js";
import type { CapabilityActionRootResolverV1 } from "./adapters/types.js";
import { CapabilityRuntimeError } from "./operations/errors.js";
import type { CapabilityOperationActionAuthorityV1 } from "./operations/types.js";
import { capabilityClosurePackagePins } from "./planning/closure-packages.js";
import type { CapabilityFabricPlanV1 } from "./planning/types.js";
import type { DurableActionAuthorityHostV1 } from "./source/durable-authority-transition-resolver.js";
import type { CapabilityOperationV1 } from "./wire/operation.js";

type ExecutableLocatorV1 = Exclude<
  PrivateActionRootLocatorV1,
  { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
>;

function key(locator: ExecutableLocatorV1): string {
  return canonicalJson(locator);
}

function fail(
  message: string,
  code: Extract<
    CapabilityRuntimeErrorCodeV1,
    | typeof CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE
    | typeof CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH
    | typeof CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE
  > = CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
): never {
  throw new CapabilityRuntimeError(message, code);
}

/** Host-owned registry: only branded readers for exact logical roots may be installed. */
export class CapabilityRuntimeActionRootsV1 {
  readonly #readers = new Map<string, DurableActionAuthorityReaderV1>();
  readonly #capabilityRoots: Record<CapabilityScope, string>;
  readonly #scopeIdentities = new Map<CapabilityScope, string>();

  constructor(roots: { project: string; user: string }) {
    this.#capabilityRoots = {
      project: resolve(roots.project),
      user: resolve(roots.user),
    };
  }

  bindScope(scope: CapabilityScope, scopeIdentityDigest: string): void {
    const prior = this.#scopeIdentities.get(scope);
    if (prior && prior !== scopeIdentityDigest)
      fail(
        "capability action-root identity changed",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    this.#scopeIdentities.set(scope, scopeIdentityDigest);
  }

  bind(locator: ExecutableLocatorV1, reader: DurableActionAuthorityReaderV1): void {
    assertDurableActionAuthorityReaderV1(reader);
    const root = realpathSync(reader.action_root_path);
    if (root !== resolve(reader.action_root_path))
      fail(
        "action authority reader root is not canonical",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
      const identity = this.#scopeIdentities.get(locator.scope);
      if (
        !identity ||
        locator.scope_identity_digest !== identity ||
        root !== this.#capabilityRoots[locator.scope]
      )
        fail(
          "capability action authority belongs to another scope",
          CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
        );
    }
    const bindingKey = key(locator);
    const prior = this.#readers.get(bindingKey);
    if (prior && prior !== reader && realpathSync(prior.action_root_path) !== root)
      fail(
        "action authority root already has another owner",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    this.#readers.set(bindingKey, reader);
  }

  reader(locator: PrivateActionRootLocatorV1): DurableActionAuthorityReaderV1 {
    if (locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
      return fail(
        "recovery bootstrap is not an executable action root",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const reader = this.#readers.get(key(locator));
    if (!reader)
      return fail(
        "durable action authority is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    assertDurableActionAuthorityReaderV1(reader);
    return reader;
  }

  path(locator: ExecutableLocatorV1): string {
    if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
      if (this.#scopeIdentities.get(locator.scope) !== locator.scope_identity_digest)
        return fail(
          "capability action-root locator is stale",
          CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
        );
      return this.#capabilityRoots[locator.scope];
    }
    return this.reader(locator).action_root_path;
  }

  durableHost(): DurableActionAuthorityHostV1 {
    return Object.freeze({
      resolve: (locator: PrivateActionRootLocatorV1) => this.reader(locator),
    });
  }

  payloadRoots(): CapabilityActionRootResolverV1 {
    return Object.freeze({ resolve: (locator: ExecutableLocatorV1) => this.path(locator) });
  }
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function snapshotFor(
  roots: CapabilityRuntimeActionRootsV1,
  header: CapabilityOperationV1,
  plan: CapabilityFabricPlanV1,
) {
  const snapshot = roots.reader(header.action_root_locator).getRecorded(header.proposal_id);
  if (!snapshot?.approval)
    fail(
      "approved action authority is absent",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  assertProposal(snapshot.proposal);
  assertApproval(snapshot.proposal, snapshot.approval);
  const proposal = snapshot.proposal;
  if (
    proposal.domain !== ACTION_DOMAIN.CAPABILITY ||
    !isCapabilityHostActionKind(proposal.action.type) ||
    proposal.proposal_digest !== header.proposal_digest ||
    snapshot.approval.approval_id !== header.approval_id ||
    snapshot.approval.approval_digest !== header.approval_digest ||
    snapshot.approval.decided_at !== header.created_at ||
    !exact(proposal.action_root_locator, plan.action_root_locator) ||
    proposal.execution_object_closure_digest !== plan.execution_closure_digest ||
    proposal.adapter_set_digest !== plan.adapter_set_digest ||
    proposal.source_authority_set_digest !== plan.source_authority_set_digest ||
    proposal.policy_digest !== plan.runtime_closure.authority.policy_digest ||
    proposal.grant_digest !== plan.runtime_closure.authority.grant_digest ||
    proposal.permission_digest !== plan.permission_digest ||
    !exact(proposal.target_set, plan.targets) ||
    !exact(
      proposal.package_pins,
      capabilityClosurePackagePins(
        plan.runtime_closure.packages,
        plan.runtime_closure.effect_packages,
      ),
    )
  )
    fail(
      "durable action authority does not bind the capability plan",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  return snapshot;
}

/** Exact shared ActionAuthorityStore verifier used by the production executor. */
export class CapabilityOperationActionAuthorityReaderV1
  implements CapabilityOperationActionAuthorityV1
{
  constructor(
    readonly roots: CapabilityRuntimeActionRootsV1,
    readonly objects: CapabilityActionObjectStoreV1,
  ) {}

  resolvePlanningGraph(header: CapabilityOperationV1) {
    const snapshot = this.roots.reader(header.action_root_locator).getRecorded(header.proposal_id);
    if (
      !snapshot ||
      snapshot.proposal.proposal_digest !== header.proposal_digest ||
      snapshot.approval?.approval_id !== header.approval_id ||
      snapshot.approval.approval_digest !== header.approval_digest
    )
      return fail(
        "durable action authority is absent for operation graph",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    return this.objects.readGraph(snapshot.proposal);
  }

  verifyPrepared(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void {
    const snapshot = snapshotFor(this.roots, header, plan);
    if (snapshot.state !== ACTION_OPERATION_STATE.APPROVED)
      fail(
        "capability action is not approved for preparation",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
  }

  verifyDispatched(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void {
    const reader = this.roots.reader(header.action_root_locator);
    const snapshot = snapshotFor(this.roots, header, plan);
    const dispatch = reader.getDispatch(header.operation_id);
    if (!dispatch || !snapshot.approval)
      fail(
        "capability action dispatch authority is absent",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const expected = materializeDispatchRecord(
      snapshot.proposal,
      snapshot.approval,
      header.header_digest,
    );
    if (
      !exact(dispatch, expected) ||
      !isActionOperationDispatchReplayState(snapshot.state) ||
      snapshot.operation_id !== header.operation_id ||
      snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest
    )
      fail(
        "capability action dispatch authority is inconsistent",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
  }

  verifyReadable(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void {
    const snapshot = snapshotFor(this.roots, header, plan);
    if (snapshot.state === ACTION_OPERATION_STATE.APPROVED) {
      this.verifyPrepared(header, plan);
      return;
    }
    this.verifyDispatched(header, plan);
  }
}

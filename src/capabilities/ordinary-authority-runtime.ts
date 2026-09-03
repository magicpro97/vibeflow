import type { DurableActionAuthorityReaderV1 } from "../actions/index.js";
import {
  ACTION_OPERATION_STATE,
  ActionAuthorityStore,
  type ActionAuthorityStoreFaultV1,
  createDurableActionAuthorityReaderV1,
} from "../actions/index.js";
import { isAuthorityAction } from "../actions/proposal-content-validation.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../actions/protocol-contract.js";
import type { CapabilityScope } from "../core/capability-contract.js";
import {
  FilesystemSecretRevocationCandidateAuthorityV1,
  type OrdinaryAuthorityMutationFaultPointV1,
  OrdinaryAuthorityMutationServiceV1,
  capabilityAuthorityApprovalChallengeKey,
} from "./authority-mutation/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./operations/errors.js";
import type { CapabilityRuntimeActionRootsV1 } from "./runtime-action-authority.js";
import type { DurableAuthorityTransitionResolverV1 } from "./source/durable-authority-transition-resolver.js";
import type { CapabilityStorePathsV1 } from "./storage/paths.js";
import { CapabilityStorageV1 } from "./storage/store.js";

export interface CapabilityOrdinaryAuthorityRuntimeV1 {
  readonly service: CapabilityOrdinaryAuthorityServiceContextV1;
  readonly domain: OrdinaryAuthorityMutationServiceV1;
  readonly actionStore: ActionAuthorityStore;
  readonly secretCandidates: FilesystemSecretRevocationCandidateAuthorityV1;
}

export interface CapabilityOrdinaryAuthorityServiceContextV1 {
  readonly options: { readonly storage: CapabilityStorageV1 };
  clockNow(): string;
}

export type CapabilityOrdinaryAuthorityCoreV1 = Omit<
  CapabilityOrdinaryAuthorityRuntimeV1,
  "service"
>;

/** Binds the durable authority action root without advancing persisted recovery state. */
export function composeCapabilityOrdinaryAuthorityCoreV1(input: {
  scope: CapabilityScope;
  paths: CapabilityStorePathsV1;
  scopeIdentityDigest: string;
  transitionResolver: DurableAuthorityTransitionResolverV1;
  actionRoots: CapabilityRuntimeActionRootsV1;
  now: () => string;
  fault?: (point: OrdinaryAuthorityMutationFaultPointV1) => void;
  action_fault?: ActionAuthorityStoreFaultV1;
}): CapabilityOrdinaryAuthorityCoreV1 {
  const storage = new CapabilityStorageV1(input.paths, input.scopeIdentityDigest, {
    now: input.now,
    authorityTransitionResolver: input.transitionResolver,
  });
  const secretCandidates = new FilesystemSecretRevocationCandidateAuthorityV1({
    storage,
    action_root_path: (locator) => input.actionRoots.path(locator),
  });
  const domain: OrdinaryAuthorityMutationServiceV1 = new OrdinaryAuthorityMutationServiceV1({
    paths: input.paths,
    authority_transition_resolver: input.transitionResolver,
    action_authority: (): DurableActionAuthorityReaderV1 =>
      createDurableActionAuthorityReaderV1(actionStore),
    now: input.now,
    secret_candidate_authority: secretCandidates,
    ...(input.fault ? { fault: input.fault } : {}),
  });
  const actionStore: ActionAuthorityStore = new ActionAuthorityStore(input.paths.privateRoot, {
    authority_resolver: domain.resolver,
    now: () => Date.parse(input.now()),
    hmac_key: () => capabilityAuthorityApprovalChallengeKey(input.paths.privateRoot),
    ...(input.action_fault ? { fault: input.action_fault } : {}),
  });
  const actionReader: DurableActionAuthorityReaderV1 =
    createDurableActionAuthorityReaderV1(actionStore);
  input.actionRoots.bind(
    {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: input.scope,
      scope_identity_digest: input.scopeIdentityDigest,
    },
    actionReader,
  );
  return { domain, actionStore, secretCandidates };
}

/** Resumes already-COMMITTING authority actions only on an execution-capable path. */
export function resumeCapabilityOrdinaryAuthorityCoreV1(
  runtime: CapabilityOrdinaryAuthorityCoreV1,
): void {
  const { actionStore, domain } = runtime;
  for (const snapshot of actionStore.listRecordedForRecovery().reverse()) {
    if (
      snapshot.state !== ACTION_OPERATION_STATE.COMMITTING ||
      !isAuthorityAction(snapshot.proposal.action.type)
    )
      continue;
    if (!snapshot.operation_id)
      throw new CapabilityRuntimeError(
        "committing ordinary authority action omitted its operation identity",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    domain.execute(snapshot.operation_id);
    actionStore.recordTerminal(snapshot.proposal.proposal_id);
  }
}

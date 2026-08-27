import type { DurableActionAuthorityReaderV1 } from "../../actions/index.js";
import type { NonRecoveryActionRootLocatorV1 } from "../../actions/types.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityTransitionEvidenceV1,
} from "../authority/index.js";

export interface DurableAuthorityTransitionVerificationInputV1 {
  private_root: string;
  prior: AuthorityEpochHeadV1;
  event: AuthorityEpochEventV1;
  evidence: AuthorityTransitionEvidenceV1;
  next: AuthorityEpochHeadV1;
}

export interface DurableActionAuthorityHostV1 {
  resolve(locator: NonRecoveryActionRootLocatorV1): DurableActionAuthorityReaderV1;
}

export interface DurableAuthorityTransitionResolverV1 {
  verify(input: DurableAuthorityTransitionVerificationInputV1): void;
}

export interface DurableAuthorityRepairTransitionVerifierV1 {
  /** Dedicated typed verifier; ordinary authority changes never dispatch here. */
  verify(input: DurableAuthorityTransitionVerificationInputV1): void;
}

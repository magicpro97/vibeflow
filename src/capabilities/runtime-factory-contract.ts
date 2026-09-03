import type { ActionAuthorityStoreFaultV1 } from "../actions/index.js";
import type { CapabilityScope } from "../core/capability-contract.js";
import type { OrdinaryAuthorityMutationFaultPointV1 } from "./authority-mutation/index.js";
import type { AuthorityRepairDomainBackendSetV1 } from "./authority-repair/index.js";
import type { CapabilityDetailRequestV1, CapabilityQueryRequestV1 } from "./query/types.js";
import type { FilesystemCapabilityPackageCacheOptionsV1 } from "./source/package-cache-reader.js";
import type { CapabilityBrowserDetailResponseV1, CapabilityQueryResponseV1 } from "./wire/query.js";

export interface CapabilityRuntimeFactoryOptionsV1 {
  projectRoot: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  vfVersion?: string;
  engineVersions?: FilesystemCapabilityPackageCacheOptionsV1["engineVersions"];
  authorityRepairBackends?: AuthorityRepairDomainBackendSetV1;
  ordinaryAuthorityFault?: (
    scope: CapabilityScope,
    point: OrdinaryAuthorityMutationFaultPointV1,
  ) => void;
  ordinaryAuthorityActionFault?: (
    scope: CapabilityScope,
    point: Parameters<ActionAuthorityStoreFaultV1>[0],
  ) => void;
}

export interface CapabilityRuntimeScopeRouterV1 {
  query(request: CapabilityQueryRequestV1): CapabilityQueryResponseV1;
  detail(request: CapabilityDetailRequestV1): CapabilityBrowserDetailResponseV1;
}

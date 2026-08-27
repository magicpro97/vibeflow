import type { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { CapabilityRuntimeAuthorityReaderV1 } from "../operations/types.js";
import type { FilesystemCapabilityPackageCacheV1 } from "../source/package-cache-reader.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityPrivateInputAuthorityV1 } from "./input-materializer.js";
import type { CapabilityHostActionV1, CapabilityPlanningRequestV1 } from "./types.js";

export interface CapabilityAdoptCandidateAuthorityV1 {
  resolve(
    candidate: Extract<
      CapabilityHostActionV1,
      { type: typeof HOST_ACTION_KIND.CAPABILITY_ADOPT }
    >["candidate"],
    context: {
      scope: CapabilityScope;
      action_root_locator: CapabilityPlanningRequestV1["action_root_locator"];
    },
  ): StrictLegacyAdoptCandidateV1;
}

export interface CapabilityIntentMaterializerOptionsV1 {
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  packages: FilesystemCapabilityPackageCacheV1;
  privateInputs: CapabilityPrivateInputAuthorityV1;
  adopt?: CapabilityAdoptCandidateAuthorityV1;
  now: () => string;
}

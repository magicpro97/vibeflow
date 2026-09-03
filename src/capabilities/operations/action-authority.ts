import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import type {
  CapabilityOperationActionAuthorityV1,
  CapabilityOperationExecutorOptionsV1,
} from "./types.js";

export function requireCapabilityActionAuthority(
  options: Pick<CapabilityOperationExecutorOptionsV1, "actionAuthority">,
): CapabilityOperationActionAuthorityV1 {
  if (!options.actionAuthority)
    throw new CapabilityRuntimeError(
      "capability action authority is unavailable",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  return options.actionAuthority;
}

import { validateInternalHostAction } from "../../actions/internal-validation.js";
import type { HostActionRequestV1 } from "../../actions/request-types.js";
import { validateCapabilityIntentAction } from "../../capabilities/controller.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityHostActionV1 } from "../../capabilities/planning/types.js";
import type { FabricCliMutationRequestV1 } from "../../capabilities/wire/cli.js";

function isCapabilityHostAction(
  action: ReturnType<typeof validateInternalHostAction>,
): action is CapabilityHostActionV1 {
  return action.type.startsWith("capability.");
}

function validateCapabilityCliAction(
  action: ReturnType<typeof validateInternalHostAction>,
): CapabilityHostActionV1 {
  if (!isCapabilityHostAction(action))
    throw new CapabilityRuntimeError(
      "CLI mutation request escaped the capability domain",
      "authorization-mismatch",
    );
  return validateCapabilityIntentAction(action);
}

export function capabilityIntentAction(
  action: FabricCliMutationRequestV1["action"],
): CapabilityHostActionV1 {
  return validateCapabilityCliAction(validateInternalHostAction(action));
}

export function capabilityRequestAction(action: HostActionRequestV1): CapabilityHostActionV1 {
  return validateCapabilityCliAction(validateInternalHostAction(action));
}

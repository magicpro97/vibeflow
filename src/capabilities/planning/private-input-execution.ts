import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { emptyBindingDigest } from "../private-input/helpers.js";
import type { CapabilityPrivateInputAuthorityV1 } from "./input-materializer.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

export function bindCapabilityExecutionPrivateInputs(input: {
  packages: ResolvedCapabilityPackageV1[];
  scope: "project" | "user";
  scopeIdentityDigest: string;
  actionRootLocator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>;
  authority: CapabilityPrivateInputAuthorityV1;
}): ResolvedCapabilityPackageV1[] {
  return input.packages.map((pkg) => {
    const identity = {
      scope: input.scope,
      scope_identity_digest: input.scopeIdentityDigest,
      package_id: pkg.pin.id,
      package_pin_digest: pkg.pin.pin_digest,
      manifest_digest: pkg.manifest_digest,
    };
    const execution = input.authority.materializeExecutionBinding
      ? input.authority.materializeExecutionBinding({
          ...identity,
          input_ids: pkg.secret_input_ids,
          action_root_locator: input.actionRootLocator,
          preparation_digest: null,
        })
      : pkg.secret_input_ids.length === 0
        ? { binding_digest: emptyBindingDigest(identity), record: null }
        : null;
    if (!execution)
      throw new CapabilityRuntimeError(
        "private input execution binding authority is unavailable",
        "service-unavailable",
      );
    return {
      ...pkg,
      private_input_binding_digest: execution.binding_digest,
      private_input_execution: execution,
    };
  });
}

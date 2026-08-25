import { actionIdempotencyScopeDigest } from "../../actions/idempotency.js";
import type { ActionRequestAuthorityV1, EngineName } from "../../actions/types.js";
import { canonicalJson } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { FilesystemCapabilityPackageCacheV1 } from "../source/package-cache-reader.js";
import { bytewise } from "../wire/primitives.js";
import { capabilityClosurePackageSet } from "./closure-packages.js";
import type { CapabilityPrivateInputAuthorityV1 } from "./input-materializer.js";
import { bindCapabilityExecutionPrivateInputs } from "./private-input-execution.js";
import {
  capabilitySourceRequestContext,
  materializeCachedPackageSourceExecution,
} from "./source-execution.js";
import { capabilitySourceAuthoritySetDigest } from "./source-materialization.js";
import type {
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
  CapabilityRuntimeAuthorityV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

export function bindCapabilityIntentExecutionClosure(input: {
  desired: ResolvedCapabilityPackageV1[];
  effects: ResolvedCapabilityPackageV1[];
  targets: NonNullable<CapabilityPlanningRequestV1["selected_targets"]>;
  action: CapabilityHostActionV1;
  planningOptions: import("../../actions/types.js").ActionPlanningOptionsV1;
  actionRootLocator: NonNullable<CapabilityPlanningRequestV1["action_root_locator"]>;
  requestAuthority: ActionRequestAuthorityV1;
  runtimeAuthority: CapabilityRuntimeAuthorityV1;
  packages: FilesystemCapabilityPackageCacheV1;
  privateInputs: CapabilityPrivateInputAuthorityV1;
  now: string;
  legacyCandidateDigest: string | null;
}) {
  if (
    input.requestAuthority.authority_scope_digest !==
    actionIdempotencyScopeDigest(input.actionRootLocator)
  )
    throw new CapabilityRuntimeError(
      "source request authority belongs to another action root",
      "authorization-mismatch",
    );
  const context = capabilitySourceRequestContext({
    action: input.action,
    planningOptions: input.planningOptions,
    authority: input.requestAuthority,
    origin: input.actionRootLocator.kind === "conversation" ? "conversation" : "standalone",
  });
  const sourceBound = capabilityClosurePackageSet(input.desired, input.effects).map((pkg) => {
    const engines = input.targets
      .filter((target) => target.package_id === pkg.pin.id)
      .map((target) => target.engine as EngineName)
      .sort(bytewise);
    return materializeCachedPackageSourceExecution({
      cache: input.packages,
      pkg,
      requestContext: context,
      targetEngines: engines,
      policyDigest: input.runtimeAuthority.policy_digest,
      now: input.now,
      legacyCandidateDigest:
        pkg.pin.source.kind === "legacy-adopt" ? input.legacyCandidateDigest : null,
    });
  });
  const privateBound = bindCapabilityExecutionPrivateInputs({
    packages: sourceBound,
    scope: input.action.scope,
    scopeIdentityDigest: input.runtimeAuthority.scope_identity_digest,
    actionRootLocator: input.actionRootLocator,
    authority: input.privateInputs,
  });
  const byPin = new Map(privateBound.map((pkg) => [pkg.pin.pin_digest, pkg]));
  const select = (pkg: ResolvedCapabilityPackageV1) => {
    const bound = byPin.get(pkg.pin.pin_digest);
    if (!bound || canonicalJson(bound.pin) !== canonicalJson(pkg.pin))
      throw new CapabilityRuntimeError(
        "execution binding escaped the resolved package set",
        "integrity-failure",
      );
    return bound;
  };
  return {
    desired: input.desired.map(select),
    effects: input.effects.map(select),
    sourceAuthoritySetDigest: capabilitySourceAuthoritySetDigest(privateBound),
    sourceRequestContext: context,
  };
}

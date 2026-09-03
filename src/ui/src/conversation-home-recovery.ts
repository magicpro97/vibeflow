import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import type { BrowserActionCandidate } from "./conversation-home-api.js";
import type { HomeActionView, HomeCapabilityItem } from "./conversation-home-types.js";

export interface HomeRecoveryPlan {
  action: string;
  label: string;
  candidate: BrowserActionCandidate | null;
  blockedReason: string | null;
}

export function capabilityRepairCandidate(
  item: Pick<HomeCapabilityItem, "package_id" | "scope">,
): BrowserActionCandidate {
  return {
    type: HOST_ACTION_KIND.CAPABILITY_REPAIR,
    package_id: item.package_id,
    scope: item.scope === CAPABILITY_SCOPE.USER ? CAPABILITY_SCOPE.USER : CAPABILITY_SCOPE.PROJECT,
  };
}

export function planHomeRecovery(view: HomeActionView, action: string): HomeRecoveryPlan {
  if (action === "repair" && view.proposal.domain === "capability")
    return {
      action,
      label: "Prepare repair",
      candidate: {
        type: HOST_ACTION_KIND.CAPABILITY_REPAIR,
        package_id: view.proposal.package_pins[0]?.id ?? null,
        scope:
          view.proposal.scope === CAPABILITY_SCOPE.USER
            ? CAPABILITY_SCOPE.USER
            : CAPABILITY_SCOPE.PROJECT,
      },
      blockedReason: null,
    };
  return {
    action,
    label: action.replaceAll("-", " "),
    candidate: null,
    blockedReason:
      "This action does not expose its exact retry or repair binding in the public browser view yet.",
  };
}

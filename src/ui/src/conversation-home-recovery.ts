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
    type: "capability.repair" as const,
    package_id: item.package_id,
    scope: item.scope === "user" ? "user" : "project",
  };
}

export function planHomeRecovery(view: HomeActionView, action: string): HomeRecoveryPlan {
  if (action === "repair" && view.proposal.domain === "capability")
    return {
      action,
      label: "Prepare repair",
      candidate: {
        type: "capability.repair",
        package_id: view.proposal.package_pins[0]?.id ?? null,
        scope: view.proposal.scope === "user" ? "user" : "project",
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

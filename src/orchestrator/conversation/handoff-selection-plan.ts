import { digestHex, digestV1 } from "../../durability/index.js";
import type { HandoffOptionalGroupV1, HandoffSelectionPlanV1 } from "./handoff-types.js";

export const HANDOFF_OPTIONAL_GROUP_DIGEST_DOMAIN = "VF-HANDOFF-OPTIONAL-GROUP\0v1\0";
export const HANDOFF_SELECTION_PLAN_DIGEST_DOMAIN = "VF-HANDOFF-SELECTION-PLAN\0v1\0";

export type HandoffOptionalGroupPreimageV1 = Omit<HandoffOptionalGroupV1, "group_id">;
export type HandoffSelectionPlanPreimageV1 = Omit<HandoffSelectionPlanV1, "selection_digest">;

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function compareGroups(left: HandoffOptionalGroupV1, right: HandoffOptionalGroupV1): number {
  return (
    left.anchor_revision_ordinal - right.anchor_revision_ordinal ||
    left.anchor_public_seq - right.anchor_public_seq ||
    compareText(left.anchor_event_id, right.anchor_event_id)
  );
}

export function handoffOptionalGroupDigest(preimage: HandoffOptionalGroupPreimageV1): string {
  return digestV1(HANDOFF_OPTIONAL_GROUP_DIGEST_DOMAIN, preimage);
}

export function materializeHandoffOptionalGroup(
  input: Omit<HandoffOptionalGroupPreimageV1, "artifact_ids" | "event_ids"> & {
    artifact_ids: readonly string[];
    event_ids: readonly string[];
  },
): HandoffOptionalGroupV1 {
  const preimage: HandoffOptionalGroupPreimageV1 = {
    ...structuredClone(input),
    event_ids: [...input.event_ids].sort(compareText),
    artifact_ids: [...input.artifact_ids].sort(compareText),
  };
  return {
    group_id: `vf-handoff-group-${digestHex(handoffOptionalGroupDigest(preimage))}`,
    ...preimage,
  };
}

export function handoffSelectionPlanDigest(preimage: HandoffSelectionPlanPreimageV1): string {
  return digestV1(HANDOFF_SELECTION_PLAN_DIGEST_DOMAIN, preimage);
}

export function materializeHandoffSelectionPlan(
  input: Omit<HandoffSelectionPlanPreimageV1, "mandatory_artifact_ids" | "optional_groups"> & {
    mandatory_artifact_ids: readonly string[];
    optional_groups: readonly HandoffOptionalGroupV1[];
  },
): HandoffSelectionPlanV1 {
  const preimage: HandoffSelectionPlanPreimageV1 = {
    ...structuredClone(input),
    mandatory_artifact_ids: [...input.mandatory_artifact_ids].sort(compareText),
    optional_groups: [...structuredClone(input.optional_groups)].sort(compareGroups),
  };
  return {
    ...preimage,
    selection_digest: handoffSelectionPlanDigest(preimage),
  };
}

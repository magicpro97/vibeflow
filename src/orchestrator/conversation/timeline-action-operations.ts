import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import type { ActionOperationViewV1 } from "../../actions/public-types.js";
import { digestV1 } from "../../durability/index.js";
import { isLineageDigest } from "./lineage-types.js";

export interface AnchoredActionOperationsPageV1 {
  schema_version: "1.0";
  items: ActionOperationViewV1[];
  next_cursor: string | null;
  proposal_set_watermark: string;
}

export function emptyTimelineActionOperations(anchor: {
  conversation_id: string;
  revision_id: string;
  origin_event_id: string | null;
}): AnchoredActionOperationsPageV1 {
  return {
    schema_version: "1.0",
    items: [],
    next_cursor: null,
    proposal_set_watermark: digestV1("VF-ANCHORED-ACTION-PROPOSAL-SET\0v1\0", {
      schema_version: "1.0",
      ...anchor,
      proposals: [],
    }),
  };
}

export function assertTimelineActionOperations(
  value: AnchoredActionOperationsPageV1,
  fail: (message: string) => never,
): void {
  if (
    value.schema_version !== "1.0" ||
    !Array.isArray(value.items) ||
    (value.next_cursor !== null && typeof value.next_cursor !== "string") ||
    !isLineageDigest(value.proposal_set_watermark)
  )
    fail("invalid anchored action operation page");
  assertPublicProjectionSafe(value, "$.timeline.action_operations", { maxBytes: 8 * 1024 * 1024 });
}

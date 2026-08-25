import type { CapabilityQueryItemV1 } from "../../capabilities/wire/query.js";

export function statusQueryResult(
  items: CapabilityQueryItemV1[],
): "succeeded" | "degraded" | "needs-recovery" {
  if (items.some((item) => item.status === "needs-recovery")) return "needs-recovery";
  return items.some((item) => !["absent", "ready"].includes(item.status))
    ? "degraded"
    : "succeeded";
}

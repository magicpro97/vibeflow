import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import type { CapabilityQueryItemV1 } from "../../capabilities/wire/query.js";
import { CAPABILITY_STATUS } from "../../core/capability-contract.js";

type CapabilityStatusQueryResultV1 =
  | typeof ACTION_OPERATION_STATE.SUCCEEDED
  | typeof CAPABILITY_STATUS.DEGRADED
  | typeof CAPABILITY_STATUS.NEEDS_RECOVERY;

export function statusQueryResult(items: CapabilityQueryItemV1[]): CapabilityStatusQueryResultV1 {
  if (items.some((item) => item.status === CAPABILITY_STATUS.NEEDS_RECOVERY))
    return CAPABILITY_STATUS.NEEDS_RECOVERY;
  return items.some(
    (item) => item.status !== CAPABILITY_STATUS.ABSENT && item.status !== CAPABILITY_STATUS.READY,
  )
    ? CAPABILITY_STATUS.DEGRADED
    : ACTION_OPERATION_STATE.SUCCEEDED;
}

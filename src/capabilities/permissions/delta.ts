import { canonicalJson } from "../../durability/index.js";
import type { CapabilityPermissionKindScopeV1 } from "../manifest/types.js";
import { bytewise } from "../wire/primitives.js";
import { permissionContains, permissionRowSortKey } from "./containment.js";
import { publicPermissionScope } from "./scope.js";
import type { PermissionBindingRowV1, PermissionDeltaV1 } from "./types.js";

function sameGroup(left: PermissionBindingRowV1, right: PermissionBindingRowV1): boolean {
  return (
    left.permission_id === right.permission_id &&
    left.kind === right.kind &&
    left.enforcement === right.enforcement &&
    canonicalJson(left.target_ids) === canonicalJson(right.target_ids)
  );
}

function kindScope(value: PermissionBindingRowV1): CapabilityPermissionKindScopeV1 {
  switch (value.kind) {
    case "filesystem":
      return { kind: "filesystem", scope: value.scope };
    case "network":
      return { kind: "network", scope: value.scope };
    case "process":
      return { kind: "process", scope: value.scope };
    case "shell":
      return { kind: "shell", scope: value.scope };
    case "config":
      return { kind: "config", scope: value.scope };
    case "secret":
      return { kind: "secret", scope: value.scope };
    case "hook":
      return { kind: "hook", scope: value.scope };
  }
}

function row(
  value: PermissionBindingRowV1,
  change: PermissionDeltaV1["change"],
): PermissionDeltaV1 {
  return {
    permission_id: value.permission_id,
    change,
    public_scope: publicPermissionScope(kindScope(value)),
    enforcement: value.enforcement,
  };
}

export function permissionDelta(
  current: readonly PermissionBindingRowV1[],
  requested: readonly PermissionBindingRowV1[],
): PermissionDeltaV1[] {
  const oldRows = [...current].sort((a, b) =>
    bytewise(permissionRowSortKey(a), permissionRowSortKey(b)),
  );
  const newRows = [...requested].sort((a, b) =>
    bytewise(permissionRowSortKey(a), permissionRowSortKey(b)),
  );
  const used = new Set<number>();
  const output: PermissionDeltaV1[] = [];
  for (const next of newRows) {
    const candidates = oldRows
      .map((value, index) => ({ value, index }))
      .filter(({ value, index }) => !used.has(index) && sameGroup(value, next));
    const exact = candidates.find(
      ({ value }) => permissionContains(value, next) && permissionContains(next, value),
    );
    const narrower = candidates.find(({ value }) => permissionContains(value, next));
    const wider = candidates.find(({ value }) => permissionContains(next, value));
    const selected = exact ?? narrower ?? wider;
    if (!selected) {
      output.push(row(next, "add"));
      continue;
    }
    used.add(selected.index);
    output.push(row(next, exact ? "unchanged" : narrower ? "narrow" : "expand"));
  }
  oldRows.forEach((value, index) => {
    if (!used.has(index)) output.push(row(value, "remove"));
  });
  return output.sort((left, right) =>
    bytewise(
      `${left.permission_id}\0${left.public_scope}\0${left.change}`,
      `${right.permission_id}\0${right.public_scope}\0${right.change}`,
    ),
  );
}

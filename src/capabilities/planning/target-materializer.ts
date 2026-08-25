import type { CapabilityTargetSelectorV1 } from "../../actions/request-types.js";
import { canonicalJson } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import type { CapabilityPlanningRequestV1, ResolvedCapabilityPackageV1 } from "./types.js";

export type MaterializedCapabilityTargetV1 = NonNullable<
  CapabilityPlanningRequestV1["selected_targets"]
>[number];

function key(row: MaterializedCapabilityTargetV1): string {
  return `${row.package_id}\0${row.engine}\0${row.participant_id ?? ""}`;
}

export function canonicalCapabilityTargets(
  rows: readonly MaterializedCapabilityTargetV1[],
): MaterializedCapabilityTargetV1[] {
  const sorted = [...rows].sort((left, right) => bytewise(key(left), key(right)));
  if (new Set(sorted.map(key)).size !== sorted.length)
    throw new CapabilityRuntimeError("capability target selectors are duplicated", "invalid-plan");
  return sorted;
}

export function lockCapabilityTargets(
  lock: CapabilityLockV1 | null,
  packageId?: string,
): MaterializedCapabilityTargetV1[] {
  return canonicalCapabilityTargets(
    (lock?.packages ?? [])
      .filter((entry) => packageId === undefined || entry.package_id === packageId)
      .flatMap((entry) =>
        entry.targets.map((target) => {
          if (target.engine === null)
            throw new CapabilityRuntimeError(
              "locked target has no engine identity",
              "invalid-plan",
            );
          return {
            package_id: entry.package_id,
            engine: target.engine,
            participant_id: target.participant_id,
          };
        }),
      ),
  );
}

export function packageCapabilityTargets(
  pkg: ResolvedCapabilityPackageV1,
  selectors: readonly CapabilityTargetSelectorV1[],
): MaterializedCapabilityTargetV1[] {
  if (selectors.length === 0)
    throw new CapabilityRuntimeError(
      "capability package target selector set is empty",
      "invalid-plan",
    );
  const rows = selectors.map((selector) => {
    if (!pkg.manifest.components.some((component) => component.targets.includes(selector.engine)))
      throw new CapabilityRuntimeError(
        `capability package ${pkg.pin.id} has no component for ${selector.engine}`,
        "invalid-plan",
      );
    return { package_id: pkg.pin.id, ...selector };
  });
  return canonicalCapabilityTargets(rows);
}

export function replaceCapabilityTargets(
  current: readonly MaterializedCapabilityTargetV1[],
  packageIds: ReadonlySet<string>,
  replacements: readonly MaterializedCapabilityTargetV1[],
): MaterializedCapabilityTargetV1[] {
  return canonicalCapabilityTargets([
    ...current.filter((row) => !packageIds.has(row.package_id)),
    ...replacements,
  ]);
}

export function unionCapabilityTargets(
  ...sets: ReadonlyArray<readonly MaterializedCapabilityTargetV1[]>
): MaterializedCapabilityTargetV1[] {
  const rows = sets.flat();
  return canonicalCapabilityTargets(
    rows.filter(
      (row, index) =>
        rows.findIndex((other) => canonicalJson(other) === canonicalJson(row)) === index,
    ),
  );
}

export function inheritedDependencySelectors(
  rootSelectors: readonly CapabilityTargetSelectorV1[],
): CapabilityTargetSelectorV1[] {
  const engines = [...new Set(rootSelectors.map((target) => target.engine))].sort(bytewise);
  return engines.map((engine) => ({ engine, participant_id: null }));
}

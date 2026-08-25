import { canonicalJson } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

function sameResolvedPackage(
  left: ResolvedCapabilityPackageV1,
  right: ResolvedCapabilityPackageV1,
): boolean {
  const { files: leftFiles, ...leftPortable } = left;
  const { files: rightFiles, ...rightPortable } = right;
  if (
    canonicalJson(leftPortable) !== canonicalJson(rightPortable) ||
    leftFiles.size !== rightFiles.size
  )
    return false;
  const leftEntries = [...leftFiles].sort(([a], [b]) => bytewise(a, b));
  const rightEntries = [...rightFiles].sort(([a], [b]) => bytewise(a, b));
  return leftEntries.every(([path, bytes], index) => {
    const peer = rightEntries[index];
    return (
      peer !== undefined &&
      path === peer[0] &&
      bytes.length === peer[1].length &&
      bytes.every((byte, offset) => byte === peer[1][offset])
    );
  });
}

/** Exact set union used by the durable planning-closure producer. */
export function capabilityClosurePackageSet(
  desired: ResolvedCapabilityPackageV1[],
  effects: ResolvedCapabilityPackageV1[],
): ResolvedCapabilityPackageV1[] {
  const packages = new Map<string, ResolvedCapabilityPackageV1>();
  for (const pkg of [...desired, ...effects]) {
    const retained = packages.get(pkg.pin.id);
    if (retained && !sameResolvedPackage(retained, pkg))
      throw new CapabilityRuntimeError(
        "capability closure contains conflicting package identities",
        "invalid-plan",
      );
    packages.set(pkg.pin.id, pkg);
  }
  return [...packages.values()].sort((left, right) => bytewise(left.pin.id, right.pin.id));
}

export function capabilityClosurePackagePins(
  desired: ReadonlyArray<Pick<ResolvedCapabilityPackageV1, "pin">>,
  effects: ReadonlyArray<Pick<ResolvedCapabilityPackageV1, "pin">>,
) {
  const pins = new Map<string, ResolvedCapabilityPackageV1["pin"]>();
  for (const { pin } of [...desired, ...effects]) {
    const retained = pins.get(pin.id);
    if (retained && canonicalJson(retained) !== canonicalJson(pin))
      throw new CapabilityRuntimeError(
        "capability closure contains conflicting package pins",
        "integrity-failure",
      );
    pins.set(pin.id, pin);
  }
  return [...pins.values()]
    .map((pin) => structuredClone(pin))
    .sort((left, right) =>
      bytewise(
        `${left.id}\0${left.version}\0${left.source.kind}\0${left.pin_digest}`,
        `${right.id}\0${right.version}\0${right.source.kind}\0${right.pin_digest}`,
      ),
    );
}

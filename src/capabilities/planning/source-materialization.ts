import type { PackageSelectorV1 } from "../../actions/request-types.js";
import { digestV1 } from "../../durability/index.js";
import type { CachedResolutionCandidateV1 } from "../source/package-cache-reader.js";
import { bytewise } from "../wire/primitives.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

export function capabilitySourceAuthoritySetDigest(
  packages: readonly ResolvedCapabilityPackageV1[],
): string {
  const bindings = packages
    .map((pkg) => {
      const binding = pkg.source_execution?.resolved;
      if (!binding || binding.binding_digest !== pkg.source_authority_binding_digest)
        throw new Error("capability package lacks exact resolved source authority");
      return structuredClone(binding);
    })
    .sort((a, b) => bytewise(a.authenticity_digest, b.authenticity_digest));
  if (new Set(bindings.map((row) => row.authenticity_digest)).size !== bindings.length)
    throw new Error("resolved source authority set contains duplicate authenticity");
  return digestV1("VF-RESOLVED-SOURCE-AUTHORITY-SET\0v1\0", bindings);
}

export function capabilitySelectorMatches(
  selector: PackageSelectorV1,
  row: CachedResolutionCandidateV1,
): boolean {
  const pin = row.resolved.pin;
  return (
    pin.id === selector.id &&
    (selector.version === undefined || pin.version === selector.version) &&
    (selector.source_kind === undefined || pin.source.kind === selector.source_kind) &&
    (selector.content_sha256 === undefined || pin.content_sha256 === selector.content_sha256) &&
    (selector.package_pin_digest === undefined || pin.pin_digest === selector.package_pin_digest)
  );
}

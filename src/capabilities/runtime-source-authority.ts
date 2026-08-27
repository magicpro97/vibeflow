import { canonicalJson, digestV1 } from "../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./operations/errors.js";
import type { CapabilityRuntimeSourceAuthorityReaderV1 } from "./operations/types.js";
import type {
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
} from "./planning/execution-types.js";
import type { CapabilityDurablePlanningGraphV1 } from "./planning/types.js";
import type { FilesystemCapabilityPackageCacheV1 } from "./source/package-cache-reader.js";
import { bytewise } from "./wire/primitives.js";

/** Re-resolves fixed package bytes and trust heads against the retained source graph. */
export class FilesystemCapabilitySourceAuthorityReaderV1
  implements CapabilityRuntimeSourceAuthorityReaderV1
{
  constructor(readonly packages: FilesystemCapabilityPackageCacheV1) {}

  readSourceAuthoritySet(graph: CapabilityDurablePlanningGraphV1, checkedAt: string): string {
    const plan = graph.plan;
    const checked = Date.parse(checkedAt);
    if (!Number.isFinite(checked) || new Date(checked).toISOString() !== checkedAt)
      throw new CapabilityRuntimeError(
        "source authority frontier time is invalid",
        CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE,
      );
    if (
      plan.scope !== this.packages.options.scope ||
      plan.scope_identity_digest !== this.packages.options.scopeIdentityDigest
    )
      throw new CapabilityRuntimeError(
        "capability source authority belongs to another scope",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const resolvedRows = graph.ledger.json_objects
      .filter((row) => row.binding.object_schema_id === "vf.resolved-source-authority-binding/1")
      .map((row) => row.value as CapabilityResolvedSourceAuthorityBindingV1)
      .sort((left, right) => bytewise(left.authenticity_digest, right.authenticity_digest));
    const expectedPackages = [
      ...plan.runtime_closure.packages,
      ...plan.runtime_closure.effect_packages,
    ].filter(
      (pkg, index, all) =>
        all.findIndex((candidate) => candidate.pin.pin_digest === pkg.pin.pin_digest) === index,
    );
    if (resolvedRows.length !== expectedPackages.length)
      throw new CapabilityRuntimeError(
        "resolved source authority closure cardinality changed",
        CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE,
      );
    for (const expected of expectedPackages) {
      const current = this.packages.executionAuthority(expected.pin.pin_digest);
      const retained = resolvedRows.find(
        (row) => row.authenticity_digest === expected.authenticity_binding.authenticity_digest,
      );
      const authority = retained
        ? graph.ledger.json_objects
            .filter(
              (row) => row.binding.object_schema_id === "vf.source-access-authority-binding/1",
            )
            .map((row) => row.value as CapabilitySourceAccessAuthorityBindingV1)
            .find((row) => row.binding_digest === retained.source_access_authority_digest)
        : null;
      const authorizationExpiry =
        authority?.authorization.kind === "confirmation-free"
          ? null
          : authority?.authorization.expires_at;
      if (
        !retained ||
        canonicalJson(current.resolved.pin) !== canonicalJson(expected.pin) ||
        canonicalJson(current.record.package_pin) !== canonicalJson(expected.pin) ||
        current.resolved.manifest_digest !== expected.manifest_digest ||
        canonicalJson(current.resolved.authenticity_binding) !==
          canonicalJson(expected.authenticity_binding) ||
        current.resolved.authenticity_binding.authenticity_digest !==
          retained.authenticity_digest ||
        current.trust.trust_epoch !== retained.trust_epoch ||
        current.trust.trust_head_digest !== retained.trust_head_digest ||
        Date.parse(retained.expires_at) <= checked ||
        (authorizationExpiry !== null && Date.parse(authorizationExpiry ?? "") <= checked)
      )
        throw new CapabilityRuntimeError(
          "capability source authority cache or trust head changed",
          CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE,
        );
    }
    return digestV1("VF-RESOLVED-SOURCE-AUTHORITY-SET\0v1\0", resolvedRows);
  }
}

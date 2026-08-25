import { canonicalJson, digestV1 } from "../../durability/index.js";
import { foldTrustFrames } from "../authority/fold.js";
import type { AuthorityEpochHeadV1, RegistryTrustKeyFrameV1 } from "../authority/types.js";
import { validateAuthorityHead } from "../authority/validation.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  exactKeys,
  integer,
} from "../wire/primitives.js";
import type { RegistryTrustKeyV1, RegistryTrustSnapshotV1 } from "./types.js";

function state(frame: RegistryTrustKeyFrameV1): RegistryTrustKeyV1["state"] {
  return frame.transition === "deprecated"
    ? "deprecated"
    : frame.transition === "revoked"
      ? "revoked"
      : "active";
}

export function deriveRegistryTrustSnapshot(
  head: AuthorityEpochHeadV1,
  frames: readonly RegistryTrustKeyFrameV1[],
): RegistryTrustSnapshotV1 {
  validateAuthorityHead(head);
  const latest = foldTrustFrames(frames);
  const last = frames.at(-1) ?? null;
  if (
    (last === null && (head.trust_head_digest !== null || head.trust_epoch !== 0)) ||
    (last !== null &&
      (last.scope !== head.scope ||
        last.scope_identity_digest !== head.scope_identity_digest ||
        last.frame_digest !== head.trust_head_digest ||
        last.trust_epoch !== head.trust_epoch ||
        last.authority_epoch > head.authority_epoch))
  )
    throw new CapabilityValidationError(
      "trust journal does not derive the current authority head",
      "trust_snapshot",
      "integrity_failure",
    );
  const keys = [...latest.values()].map((frame) =>
    Object.freeze({
      key_id: frame.key_id,
      algorithm: frame.algorithm,
      public_key_spki_base64: frame.public_key_spki_base64,
      registry_origin: frame.registry_origin,
      publisher_id: frame.publisher_id,
      valid_from: frame.valid_from,
      valid_until: frame.valid_until,
      state: state(frame),
      trust_epoch: frame.trust_epoch,
      frame_digest: frame.frame_digest,
    }),
  );
  const draft = {
    schema_version: "1.0" as const,
    scope: head.scope,
    scope_identity_digest: head.scope_identity_digest,
    authority_epoch: head.authority_epoch,
    authority_head_digest: head.content_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
    keys,
  };
  const snapshot = Object.freeze({
    ...draft,
    keys: Object.freeze(keys) as unknown as RegistryTrustKeyV1[],
    snapshot_digest: digestV1("VF-REGISTRY-TRUST-SNAPSHOT\0v1\0", draft),
  });
  return snapshot;
}

export function validateRegistryTrustSnapshot(
  value: RegistryTrustSnapshotV1,
): RegistryTrustSnapshotV1 {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "authority_epoch",
      "authority_head_digest",
      "trust_head_digest",
      "trust_epoch",
      "keys",
      "snapshot_digest",
    ],
    [],
    "trust_snapshot",
  );
  digest(value.scope_identity_digest, "trust_snapshot.scope_identity_digest");
  digest(value.authority_head_digest, "trust_snapshot.authority_head_digest");
  if (value.trust_head_digest !== null)
    digest(value.trust_head_digest, "trust_snapshot.trust_head_digest");
  integer(value.authority_epoch, "trust_snapshot.authority_epoch");
  integer(value.trust_epoch, "trust_snapshot.trust_epoch");
  assertSortedUnique(value.keys, (a, b) => bytewise(a.key_id, b.key_id), "trust_snapshot.keys");
  const { snapshot_digest: observed, ...preimage } = value;
  if (observed !== digestV1("VF-REGISTRY-TRUST-SNAPSHOT\0v1\0", preimage))
    throw new CapabilityValidationError(
      "registry trust snapshot digest mismatch",
      "trust_snapshot.snapshot_digest",
      "integrity_failure",
    );
  if ((value.trust_epoch === 0) !== (value.trust_head_digest === null))
    throw new CapabilityValidationError("trust snapshot head/epoch mismatch", "trust_snapshot");
  if (
    canonicalJson(value.keys) !==
    canonicalJson([...value.keys].sort((a, b) => bytewise(a.key_id, b.key_id)))
  )
    throw new CapabilityValidationError(
      "trust snapshot keys are not canonical",
      "trust_snapshot.keys",
    );
  return value;
}

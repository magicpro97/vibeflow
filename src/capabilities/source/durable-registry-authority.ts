import { join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, privateFileBytes } from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import { validateAuthorityIdentity } from "../authority/index.js";
import type { AuthorityScopeIdentityRecordV1 } from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type FabricAuthorityActivationReceiptV1,
  validateActivationReceipt,
} from "./authority-activation-records.js";
import { readDurableAuthorityState } from "./durable-authority-state.js";
import type { DurableAuthorityTransitionResolverV1 } from "./durable-authority-transition-resolver.js";
import { deriveRegistryTrustSnapshot, validateRegistryTrustSnapshot } from "./trust-snapshot.js";
import type { RegistryTrustSnapshotV1 } from "./types.js";

const MAX_JSON_BYTES = 1024 * 1024;
const DURABLE_REGISTRY_TRUST_SNAPSHOTS = new WeakSet<object>();

export function assertDurableRegistryTrustSnapshot(
  value: RegistryTrustSnapshotV1,
): RegistryTrustSnapshotV1 {
  if (!DURABLE_REGISTRY_TRUST_SNAPSHOTS.has(value))
    throw new CapabilityValidationError(
      "registry trust snapshot is not durable-authority-derived",
      "trust_snapshot",
      "integrity_failure",
    );
  return validateRegistryTrustSnapshot(value);
}

function parseCanonical<T>(bytes: Uint8Array | null, label: string): T {
  if (!bytes)
    throw new CapabilityValidationError(`${label} is missing`, label, "integrity_failure");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: MAX_JSON_BYTES })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return parsed as T;
}

export function readDurableRegistryTrustSnapshot(input: {
  private_root: string;
  identity_path: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  authority_transition_resolver: DurableAuthorityTransitionResolverV1;
}): RegistryTrustSnapshotV1 {
  const identity = parseCanonical<AuthorityScopeIdentityRecordV1>(
    readProjectionFile(input.identity_path),
    "authority identity",
  );
  validateAuthorityIdentity(identity);
  if (identity.scope !== input.scope || identity.content_digest !== input.scope_identity_digest)
    throw new CapabilityValidationError(
      "authority identity does not equal the selected capability owner",
      "authority.identity",
      "integrity_failure",
    );
  const identityKind = input.scope === "project" ? "project-authority" : "user-authority";
  const receipt = parseCanonical<FabricAuthorityActivationReceiptV1>(
    privateFileBytes(
      join(input.private_root, "activation", "v1", `${identityKind}.json`),
      MAX_JSON_BYTES,
    ),
    "authority activation receipt",
  );
  validateActivationReceipt(receipt, identity);
  const state = readDurableAuthorityState({
    ...input,
    initial_authority_head_digest: receipt.initial_authority_head_digest,
  });
  const snapshot = deriveRegistryTrustSnapshot(state.current, state.trust);
  DURABLE_REGISTRY_TRUST_SNAPSHOTS.add(snapshot);
  return snapshot;
}

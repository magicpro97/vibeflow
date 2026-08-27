import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes } from "../../durability/index.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { readPortableBytes } from "../storage/portable-cas.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";

export function assertCapabilityLockRepairDescendantV1(input: {
  paths: CapabilityStorePathsV1;
  storage: CapabilityStorageV1;
  ancestor_digest: string;
}): void {
  const bytes = readPortableBytes(input.paths.currentLock);
  if (!bytes) throw new Error("repaired capability lock is absent");
  const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!bytes.equals(canonicalJsonBytes(parsed, { maxBytes: 8 * 1024 * 1024 })))
    throw new Error("repaired capability lock is not canonical");
  const lock = validateCapabilityLock(parsed as unknown as CapabilityLockV1, {
    expected_scope: input.paths.scope,
  });
  if (!input.storage.isHistoryDescendant(lock, input.ancestor_digest))
    throw new Error("repaired capability lock is not an exact validated descendant");
}

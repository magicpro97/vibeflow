import * as fs from "node:fs";
import { join } from "node:path";
import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, privateFileBytes } from "../../durability/index.js";
import {
  readCapabilityHealthCurrent,
  readCapabilityHealthInventory,
} from "../operations/health-inventory.js";
import type { CapabilityRuntimeAuthorityV1 } from "../planning/types.js";
import {
  FilesystemCapabilityRuntimeAuthorityReaderV1,
  readActivatedCapabilityIdentityV1,
} from "../runtime-authority.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import { validateRegistryLockAuthorityFromDurableState } from "../source/registry-lock-authority.js";
import {
  foldCapabilityWal,
  readCapabilityOperationHeader,
  readCapabilityWal,
} from "../storage/operation-store.js";
import {
  type CapabilityStorePathsV1,
  capabilityHealthInventoryPath,
  capabilityHistoryPath,
} from "../storage/paths.js";
import { readPortableBytes } from "../storage/portable-cas.js";
import { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { CAPABILITY_WAL_PAYLOAD_KIND } from "../wire/operation.js";

const MAX_OPERATIONS = 10_000;
const OPERATION_ID = /^vf-operation-[a-f0-9]{64}$/u;

export interface CapabilityLockRepairSourceV1 {
  paths: CapabilityStorePathsV1;
  storage: CapabilityStorageV1;
  scope_identity_digest: string;
  authority: CapabilityRuntimeAuthorityV1;
  checkpoint: CapabilityLockV1;
  checkpoint_bytes: Buffer;
  target_bytes: Buffer | null;
}

function inventoryLockDigest(storage: CapabilityStorageV1, inventoryDigest: string): string {
  const bytes = privateFileBytes(
    capabilityHealthInventoryPath(storage.paths, inventoryDigest),
    8 * 1024 * 1024,
  );
  if (!bytes) throw new Error("selected capability health inventory is missing");
  const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: 8 * 1024 * 1024 })))
    throw new Error("selected capability health inventory is not canonical");
  const digest = (parsed as { capability_lock_digest?: unknown }).capability_lock_digest;
  if (typeof digest !== "string")
    throw new Error("selected capability health inventory has no lock digest");
  return digest;
}

function matchingCommitCount(
  storage: CapabilityStorageV1,
  scopeIdentityDigest: string,
  checkpoint: CapabilityLockV1,
  inventoryDigest: string,
  pointer: NonNullable<ReturnType<typeof readCapabilityHealthCurrent>>,
): number {
  const operationRoot = join(storage.paths.privateRoot, "operations", "v1");
  let names: string[];
  try {
    names = fs.readdirSync(operationRoot).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (names.length > MAX_OPERATIONS) throw new Error("capability operation set exceeds bounds");
  let matches = 0;
  for (const name of names) {
    if (!OPERATION_ID.test(name)) throw new Error("capability operation has an invalid fixed name");
    const stat = fs.lstatSync(join(operationRoot, name));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("capability operation owner is not a fixed directory");
    const header = readCapabilityOperationHeader(storage.paths, name);
    if (
      !header ||
      header.scope !== storage.paths.scope ||
      header.scope_identity_digest !== scopeIdentityDigest
    )
      throw new Error("capability operation header belongs to another scope");
    const events = readCapabilityWal(storage.paths, name);
    const fold = foldCapabilityWal(events);
    const commit = events.find(
      (event) =>
        event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT &&
        event.payload.generation_id === checkpoint.generation_id &&
        event.payload.lock_digest === checkpoint.content_digest &&
        event.payload.health_inventory_digest === inventoryDigest &&
        event.payload.next_health_pointer_epoch === pointer.inventory_epoch &&
        event.payload.next_health_pointer_digest === pointer.pointer_digest,
    );
    if (commit && fold.state === ACTION_OPERATION_STATE.SUCCEEDED) matches += 1;
  }
  return matches;
}

export function readSelectedCapabilityLockPublicationV1(
  storage: CapabilityStorageV1,
  scopeIdentityDigest: string,
  resolver: DurableAuthorityTransitionResolverV1,
  now: () => string,
): { checkpoint: CapabilityLockV1; bytes: Buffer } | null {
  const pointer = readCapabilityHealthCurrent(storage);
  if (!pointer) return null;
  const lockDigest = inventoryLockDigest(storage, pointer.inventory_digest);
  const checkpoint = storage.readHistory(lockDigest);
  const inventory = readCapabilityHealthInventory(storage, pointer.inventory_digest, checkpoint);
  if (
    inventory.capability_generation_id !== checkpoint.generation_id ||
    inventory.capability_lock_digest !== checkpoint.content_digest ||
    matchingCommitCount(
      storage,
      scopeIdentityDigest,
      checkpoint,
      inventory.inventory_digest,
      pointer,
    ) !== 1
  )
    throw new Error("selected capability publication has no unique completed WAL commit");
  validateRegistryLockAuthorityFromDurableState([checkpoint], {
    private_root: storage.paths.privateRoot,
    identity_path: storage.paths.identity,
    scope: storage.paths.scope,
    scope_identity_digest: scopeIdentityDigest,
    at: now(),
    authority_transition_resolver: resolver,
  });
  const bytes = privateFileBytes(
    capabilityHistoryPath(storage.paths, checkpoint.generation_id),
    8 * 1024 * 1024,
  );
  if (!bytes || !Buffer.from(bytes).equals(canonicalJsonBytes(checkpoint)))
    throw new Error("selected capability history bytes changed after validation");
  return { checkpoint, bytes };
}

export function inspectCapabilityLockRepairSourceV1(input: {
  paths: CapabilityStorePathsV1;
  transition_resolver: DurableAuthorityTransitionResolverV1;
  now: () => string;
}): CapabilityLockRepairSourceV1 | null {
  const identity = readActivatedCapabilityIdentityV1(input.paths);
  const authority = new FilesystemCapabilityRuntimeAuthorityReaderV1(
    input.paths,
    input.transition_resolver,
  ).read(input.paths.scope);
  const storage = new CapabilityStorageV1(input.paths, identity.content_digest, {
    now: input.now,
    authorityTransitionResolver: input.transition_resolver,
  });
  const publication = readSelectedCapabilityLockPublicationV1(
    storage,
    identity.content_digest,
    input.transition_resolver,
    input.now,
  );
  if (!publication) return null;
  const targetBytes = readPortableBytes(input.paths.currentLock);
  if (targetBytes?.equals(publication.bytes)) return null;
  const targetState = storage.readStatus().state;
  if (targetState !== "absent" && targetState !== "corrupt") return null;
  return Object.freeze({
    paths: input.paths,
    storage,
    scope_identity_digest: identity.content_digest,
    authority,
    checkpoint: publication.checkpoint,
    checkpoint_bytes: publication.bytes,
    target_bytes: targetBytes,
  });
}

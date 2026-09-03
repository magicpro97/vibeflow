import { ActionAuthorityStore } from "./store.js";
import type { ActionAuthoritySnapshotV1, ActionDispatchRecordV1 } from "./types.js";

export interface DurableActionAuthorityReaderV1 {
  readonly action_root_path: string;
  get(proposalId: string): ActionAuthoritySnapshotV1 | null;
  getRecorded(proposalId: string): ActionAuthoritySnapshotV1 | null;
  getDispatch(operationId: string): ActionDispatchRecordV1 | null;
}

const minted = new WeakSet<object>();

class DurableActionAuthorityReader implements DurableActionAuthorityReaderV1 {
  readonly action_root_path: string;

  constructor(private readonly store: ActionAuthorityStore) {
    if (Object.getPrototypeOf(store) !== ActionAuthorityStore.prototype)
      throw new Error("durable action authority store is not concrete");
    this.action_root_path = store.actionRootPath();
    minted.add(this);
    Object.freeze(this);
  }

  get(proposalId: string): ActionAuthoritySnapshotV1 | null {
    return this.store.get(proposalId);
  }

  getRecorded(proposalId: string): ActionAuthoritySnapshotV1 | null {
    return this.store.getRecorded(proposalId);
  }

  getDispatch(operationId: string): ActionDispatchRecordV1 | null {
    return this.store.getDispatch(operationId);
  }
}

export function createDurableActionAuthorityReaderV1(
  store: ActionAuthorityStore,
): DurableActionAuthorityReaderV1 {
  return new DurableActionAuthorityReader(store);
}

export function assertDurableActionAuthorityReaderV1(
  value: unknown,
): asserts value is DurableActionAuthorityReaderV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== DurableActionAuthorityReader.prototype ||
    !minted.has(value)
  )
    throw new Error("untrusted durable action authority reader");
}

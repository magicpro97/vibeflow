import type { OperationCancellationAuthority } from "./durable-operation-authority.js";
import type { CancelReservation, OperationEntry } from "./operation-registry-types.js";
import type { OperationRegistry } from "./operation-registry.js";

interface CancellationReservationOptions {
  readonly entry: OperationEntry;
  readonly authority?: OperationCancellationAuthority;
  prepare(member: OperationRegistry): Promise<void>;
  rollback(member: OperationRegistry): void;
  drain(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/** Runs the lossless prepare/commit protocol while the journal remains the winner. */
export function reserveOperationCancellation(
  options: CancellationReservationOptions,
): CancelReservation {
  const { entry } = options;
  let settled = false;
  entry.cancelReserved = true;
  const drains: Promise<void>[] = [];
  try {
    for (const member of entry.members) drains.push(options.prepare(member));
  } catch (error) {
    entry.cancelReserved = false;
    for (const member of entry.members) options.rollback(member);
    throw error;
  }
  const ready = Promise.all([...drains, options.drain()]).then(
    () => undefined,
    (error) => {
      if (!settled) {
        settled = true;
        entry.cancelReserved = false;
        for (const member of entry.members) options.rollback(member);
      }
      throw error;
    },
  );
  const commit = async (reason?: string) => {
    if (settled) return false;
    await ready;
    if (settled || entry.state !== "live" || !entry.cancelReserved) return false;
    settled = true;
    entry.cancelReserved = false;
    let claimed = true;
    let authorityError: unknown;
    try {
      claimed =
        options.authority?.commitCancellation(entry.conversationId, entry.operationId) ?? true;
    } catch (error) {
      authorityError = error;
    }
    await options.abort(reason);
    if (authorityError) throw authorityError;
    return claimed;
  };
  return Object.freeze({
    status: "reserved" as const,
    ready,
    commit,
    rollback: () => {
      if (settled) return;
      settled = true;
      if (entry.cancelReserved) entry.cancelReserved = false;
      for (const member of entry.members) options.rollback(member);
    },
  });
}

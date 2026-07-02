// In-memory map of pending hook approvals.
// Key = unique id (crypto.randomUUID). Value = resolver function + callback.
// No timer — waits indefinitely until resolved or server restarts.
import type { HookInput, HookResult } from "../core/types.js";

interface PendingHook {
  id: string;
  input: HookInput;
  result: HookResult;
  resolve: (decision: "allow" | "block") => void;
  callbacks: Array<(decision: "allow" | "block") => void>;
}

const pending = new Map<string, PendingHook>();

export function registerPending(
  id: string,
  input: HookInput,
  result: HookResult,
): Promise<"allow" | "block"> {
  return new Promise((resolve) => {
    pending.set(id, { id, input, result, resolve, callbacks: [] });
  });
}

export function resolvePending(id: string, decision: "allow" | "block"): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  for (const cb of p.callbacks) cb(decision);
  p.resolve(decision);
  return true;
}

export function getPending(id: string): Omit<PendingHook, "resolve" | "callbacks"> | undefined {
  const p = pending.get(id);
  if (!p) return undefined;
  return { id: p.id, input: p.input, result: p.result };
}

/** Register a one-shot callback that fires when resolvePending(id) is called. */
export function onPendingResolved(id: string, cb: (decision: "allow" | "block") => void): void {
  const p = pending.get(id);
  if (!p) {
    // Already resolved (race) — fire immediately with block as safe default
    cb("block");
    return;
  }
  p.callbacks.push(cb);
}

export function listPending(): Array<Omit<PendingHook, "resolve" | "callbacks">> {
  return [...pending.values()].map(({ id, input, result }) => ({ id, input, result }));
}

// Cleanup orphaned entries (engine killed) — called on server startup
export function clearPending(): void {
  pending.clear();
}

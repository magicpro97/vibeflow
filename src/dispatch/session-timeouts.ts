export interface SessionTimeoutOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

/** Own the hard and idle timers for one engine process attempt. */
export function createSessionTimeoutController(
  options: SessionTimeoutOptions,
  terminate: (reason: string) => Promise<void>,
) {
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (options.idleTimeoutMs !== undefined) {
      idleTimer = setTimeout(() => void terminate("idle timeout"), options.idleTimeoutMs);
    }
  };
  return Object.freeze({
    start() {
      if (options.timeoutMs !== undefined) {
        hardTimer = setTimeout(() => void terminate("timeout"), options.timeoutMs);
      }
      activity();
    },
    activity,
    clear() {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  });
}

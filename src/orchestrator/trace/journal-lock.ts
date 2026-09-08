import lockfile from "proper-lockfile";

// proper-lockfile acquires <journal>.lock by mkdir. A concurrent sandbox
// recreate can remove the journal parent directory between the trace store's
// ensureDirectory and this mkdir, surfacing ENOENT (full-suite FIFO
// delivery race). Retry once after recreating the journal path.
export async function acquireJournalLock(
  path: string,
  recreate: () => string,
): Promise<() => Promise<void>> {
  const options = {
    realpath: false,
    retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
  };
  try {
    return await lockfile.lock(path, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return lockfile.lock(recreate(), options);
  }
}

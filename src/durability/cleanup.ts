export type Cleanup = () => void;

export function runCleanups(cleanups: readonly Cleanup[]): void {
  let failed = false;
  let firstFailure: unknown;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      if (!failed) firstFailure = error;
      failed = true;
    }
  }
  if (failed) throw firstFailure;
}

export function cleanupThenThrow(primary: unknown, cleanups: readonly Cleanup[]): never {
  try {
    runCleanups(cleanups);
  } catch {
    // A resource cleanup failure must never replace the primary typed durability failure.
  }
  throw primary;
}

export function withCleanup<T>(operation: () => T, cleanups: readonly Cleanup[]): T {
  let result: T;
  try {
    result = operation();
  } catch (error) {
    return cleanupThenThrow(error, cleanups);
  }
  runCleanups(cleanups);
  return result;
}

export function withFailureCleanup<T>(operation: () => T, cleanups: readonly Cleanup[]): T {
  try {
    return operation();
  } catch (error) {
    return cleanupThenThrow(error, cleanups);
  }
}

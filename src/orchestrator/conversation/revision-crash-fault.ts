export type RevisionCrashPointV1 =
  | "after-reservation-active"
  | "after-prepared"
  | "after-publication-prepared";

export class RevisionCrashFaultError extends Error {
  constructor(
    readonly point: RevisionCrashPointV1,
    options: { cause: unknown },
  ) {
    super(options.cause instanceof Error ? options.cause.message : `revision crash at ${point}`, {
      cause: options.cause,
    });
    this.name = "RevisionCrashFaultError";
  }
}

export function runRevisionCrashFault(
  fault: ((point: RevisionCrashPointV1) => void) | undefined,
  point: RevisionCrashPointV1,
): void {
  if (!fault) return;
  try {
    fault(point);
  } catch (error) {
    throw new RevisionCrashFaultError(point, { cause: error });
  }
}

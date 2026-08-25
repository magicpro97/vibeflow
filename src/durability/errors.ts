export type DurabilityErrorCode =
  | "bounds"
  | "cas_mismatch"
  | "conflict"
  | "corrupt"
  | "invalid_value"
  | "lock_busy"
  | "lock_lost"
  | "unsafe_path"
  | "unsupported";

export class DurabilityError extends Error {
  readonly code: DurabilityErrorCode;

  constructor(code: DurabilityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurabilityError";
    this.code = code;
  }
}

export function durabilityError(
  code: DurabilityErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new DurabilityError(code, message, cause === undefined ? undefined : { cause });
}

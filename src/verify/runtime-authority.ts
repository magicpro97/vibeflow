/** Runtime limits owned by the verifier rather than scattered call-site literals. */
export const VERIFY_RUNTIME_AUTHORITY = Object.freeze({
  gateTimeoutMs: 900_000,
} as const);

export type VerifyRuntimeAuthority = typeof VERIFY_RUNTIME_AUTHORITY;

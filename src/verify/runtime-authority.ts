/** Runtime limits owned by the verifier rather than scattered call-site literals. */
export const VERIFY_RUNTIME_AUTHORITY = Object.freeze({
  gateTimeoutMs: 900_000,
  // Gate children stream their whole stdout through a pipe; Node's spawnSync
  // default maxBuffer is 1 MiB, and exceeding it SIGTERMs the child mid-run —
  // turning a fully passing suite (`bun run test` prints several MiB) into a
  // false-red gate. Mirror the normative proof runner's 64 MiB allowance.
  gateMaxBufferBytes: 64 * 1024 * 1024,
} as const);

export type VerifyRuntimeAuthority = typeof VERIFY_RUNTIME_AUTHORITY;

export type ApprovalChallengeHmacKeySourceV1 = Uint8Array | (() => Uint8Array);

export function approvalChallengeHmacKeySource(
  configured: ApprovalChallengeHmacKeySourceV1 | undefined,
): (() => Buffer) | null {
  if (!configured) return null;
  if (typeof configured !== "function" && configured.byteLength !== 32)
    throw new Error("approval challenge HMAC key must be 256 bits");
  return () => Buffer.from(typeof configured === "function" ? configured() : configured);
}

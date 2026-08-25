import type { ProcessLock } from "./lock.js";

export const VFFR_DOMAINS = Object.freeze([
  "action-authority",
  "action-idempotency",
  "approval-challenge",
  "revision-operation",
  "capability-operation",
  "authority-epoch",
  "grant-authority",
  "policy-authority",
  "registry-trust",
  "secret-revocation",
  "literal-staging",
  "conversation-action-receipt",
  "authority-change-terminal",
  "authority-repair",
  "recovery-bootstrap",
  "catalog-delta",
  "oversized-handoff-issuance",
] as const);

export type VffrDomain = (typeof VFFR_DOMAINS)[number];

export type VffrFailureKind = "truncated" | "corrupt" | "unsupported" | "bounds";

export class VffrError extends Error {
  readonly kind: VffrFailureKind;
  readonly fencedAs: "corrupt" | "bounds";
  readonly offset: number;

  constructor(kind: VffrFailureKind, message: string, offset: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "VffrError";
    this.kind = kind;
    this.fencedAs = kind === "bounds" ? "bounds" : "corrupt";
    this.offset = offset;
  }
}

export interface VffrReadOptions {
  domain: VffrDomain;
  maxFrames: number;
  maxPayloadBytes: number;
  maxAggregateBytes: number;
  sequenceStart?: number;
  initialPreviousDigest?: string | null;
  validatePayload: (payload: Record<string, unknown>, index: number) => void;
  computePayloadDigest: (payload: Record<string, unknown>, index: number) => string;
  validateJournalIdentity: (payload: Record<string, unknown>, index: number) => boolean;
}

export interface VffrAppendOptions extends VffrReadOptions {
  lock: ProcessLock;
  fault?: (
    point: "after-first-frame-link" | "before-existing-frame-write" | "after-existing-frame-fsync",
  ) => void;
}

export interface DecodedVffrFrame<T extends Record<string, unknown> = Record<string, unknown>> {
  domain: VffrDomain;
  sequence: number;
  payload: T;
  payloadBytes: Buffer;
  checksum: string;
  offset: number;
  byteLength: number;
  selfDigest: string;
  selectedTimestamp: string;
}

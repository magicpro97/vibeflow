import { join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, privateFileBytes, readVffrFile } from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import {
  authorityEpochEventDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
  validateAuthorityEvent,
  validateAuthorityHead,
  validateGrantFrame,
  validatePolicyFrame,
  validateSecretRevocationFrame,
  validateTrustFrame,
} from "../authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../authority/index.js";
import {
  activationCheckpointPath,
  activationHeadPath,
  activationReceiptPath,
  parseCanonicalActivation,
  readActivationIdentity,
  validateActivationReceipt,
} from "../source/authority-activation-records.js";
import { readDurableAuthorityState } from "../source/durable-authority-state.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { acquireCapabilityAuthorityLock } from "../storage/scope-lock.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { policySettingsPath } from "./policy.js";

export const ORDINARY_AUTHORITY_STORE_LIMIT = Object.freeze({
  JSON_BYTES: 8 * 1024 * 1024,
  FRAME_BYTES: 1024 * 1024,
  JOURNAL_BYTES: 64 * 1024 * 1024,
  FRAMES: 10_000,
} as const);

export interface OrdinaryAuthorityRawStateV1 {
  current: AuthorityEpochHeadV1;
  events: AuthorityEpochEventV1[];
  grants: GrantFrameV1[];
  policies: PolicyAuthorityFrameV1[];
  secrets: SecretRevocationFrameV1[];
  trust: RegistryTrustKeyFrameV1[];
  settings: Buffer;
}

export function authorityStoreFail(message: string, path = "authority.mutation"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

export function parseCanonicalAuthorityRecord<T>(bytes: Uint8Array | null, label: string): T {
  if (!bytes) return authorityStoreFail(`${label} is missing`, label);
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return authorityStoreFail(`${label} is corrupt`, label);
  }
  if (
    !Buffer.from(bytes).equals(
      canonicalJsonBytes(value, { maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES }),
    )
  )
    return authorityStoreFail(`${label} is not canonical`, label);
  return value as T;
}

export function authorityJournalCommon(scope: string, identity: string) {
  return {
    maxFrames: ORDINARY_AUTHORITY_STORE_LIMIT.FRAMES,
    maxPayloadBytes: ORDINARY_AUTHORITY_STORE_LIMIT.FRAME_BYTES,
    maxAggregateBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JOURNAL_BYTES,
    initialPreviousDigest: null,
    validateJournalIdentity: (payload: Record<string, unknown>) =>
      payload.scope === scope && payload.scope_identity_digest === identity,
  };
}

export function readOptionalAuthorityJournal<T>(
  path: string,
  options: Parameters<typeof readVffrFile>[1],
): T[] {
  if (privateFileBytes(path, ORDINARY_AUTHORITY_STORE_LIMIT.JOURNAL_BYTES) === null) return [];
  return readVffrFile(path, options).map((frame) => frame.payload as unknown as T);
}

export class OrdinaryAuthorityStateStoreV1 {
  readonly authorityRoot: string;

  constructor(
    readonly paths: CapabilityStorePathsV1,
    readonly transitionResolver: DurableAuthorityTransitionResolverV1,
  ) {
    this.authorityRoot = join(paths.privateRoot, "authority", "v1");
  }

  withAuthorityLock<T>(
    operation: string,
    callback: (store: this, lock: import("../../durability/index.js").ProcessLock) => T,
  ): T {
    const lock = acquireCapabilityAuthorityLock(this.paths, operation);
    try {
      lock.assertHeld();
      return callback(this, lock.processLock);
    } finally {
      lock.release();
    }
  }

  readCommitted() {
    const identity = parseCanonicalActivation<
      import("../authority/index.js").AuthorityScopeIdentityRecordV1
    >(readActivationIdentity(this.paths), "authority identity");
    if (!identity) return authorityStoreFail("authority identity is missing", "authority.identity");
    const receipt = parseCanonicalActivation<
      import("../source/authority-activation-records.js").FabricAuthorityActivationReceiptV1
    >(
      privateFileBytes(
        activationReceiptPath(this.paths),
        ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
      ),
      "authority activation receipt",
    );
    if (!receipt)
      return authorityStoreFail("authority activation receipt is missing", "authority.activation");
    validateActivationReceipt(receipt, identity);
    return readDurableAuthorityState({
      private_root: this.paths.privateRoot,
      identity_path: this.paths.identity,
      scope: this.paths.scope,
      scope_identity_digest: identity.content_digest,
      initial_authority_head_digest: receipt.initial_authority_head_digest,
      authority_transition_resolver: this.transitionResolver,
    });
  }

  readInitialHead(): AuthorityEpochHeadV1 {
    const identity = parseCanonicalActivation<
      import("../authority/index.js").AuthorityScopeIdentityRecordV1
    >(readActivationIdentity(this.paths), "authority identity");
    if (!identity) return authorityStoreFail("authority identity is missing", "authority.identity");
    const receipt = parseCanonicalActivation<
      import("../source/authority-activation-records.js").FabricAuthorityActivationReceiptV1
    >(
      privateFileBytes(
        activationReceiptPath(this.paths),
        ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
      ),
      "authority activation receipt",
    );
    if (!receipt)
      return authorityStoreFail("authority activation receipt is missing", "authority.activation");
    validateActivationReceipt(receipt, identity);
    return this.readCheckpoint(receipt.initial_authority_head_digest);
  }

  readCheckpoint(digest: string): AuthorityEpochHeadV1 {
    const head = parseCanonicalAuthorityRecord<AuthorityEpochHeadV1>(
      privateFileBytes(
        activationCheckpointPath(this.paths, digest),
        ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
      ),
      "authority checkpoint",
    );
    validateAuthorityHead(head);
    if (head.content_digest !== digest)
      authorityStoreFail("authority checkpoint fixed-path digest mismatch", "authority.checkpoint");
    return head;
  }

  readRaw(): OrdinaryAuthorityRawStateV1 {
    const current = parseCanonicalAuthorityRecord<AuthorityEpochHeadV1>(
      privateFileBytes(activationHeadPath(this.paths), ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES),
      "authority current head",
    );
    validateAuthorityHead(current);
    const common = authorityJournalCommon(this.paths.scope, current.scope_identity_digest);
    return {
      current,
      events: readOptionalAuthorityJournal(join(this.authorityRoot, "epoch-events.frames"), {
        ...common,
        domain: "authority-epoch",
        sequenceStart: 1,
        validatePayload: (payload) =>
          validateAuthorityEvent(payload as unknown as AuthorityEpochEventV1),
        computePayloadDigest: (payload) =>
          authorityEpochEventDigest(payload as unknown as AuthorityEpochEventV1),
      }),
      grants: readOptionalAuthorityJournal(join(this.authorityRoot, "grants.frames"), {
        ...common,
        domain: "grant-authority",
        sequenceStart: 1,
        validatePayload: (payload) => validateGrantFrame(payload as unknown as GrantFrameV1),
        computePayloadDigest: (payload) => (payload as unknown as GrantFrameV1).frame_digest,
      }),
      policies: readOptionalAuthorityJournal(join(this.authorityRoot, "policy.frames"), {
        ...common,
        domain: "policy-authority",
        sequenceStart: 0,
        validatePayload: (payload) =>
          validatePolicyFrame(payload as unknown as PolicyAuthorityFrameV1),
        computePayloadDigest: (payload) =>
          (payload as unknown as PolicyAuthorityFrameV1).frame_digest,
      }),
      secrets: readOptionalAuthorityJournal(join(this.authorityRoot, "secret-revocations.frames"), {
        ...common,
        domain: "secret-revocation",
        sequenceStart: 0,
        validatePayload: (payload) =>
          validateSecretRevocationFrame(payload as unknown as SecretRevocationFrameV1),
        computePayloadDigest: (payload) =>
          secretRevocationFrameDigest(payload as unknown as SecretRevocationFrameV1),
      }),
      trust: readOptionalAuthorityJournal(join(this.authorityRoot, "registry-trust.frames"), {
        ...common,
        domain: "registry-trust",
        sequenceStart: 1,
        validatePayload: (payload) =>
          validateTrustFrame(payload as unknown as RegistryTrustKeyFrameV1),
        computePayloadDigest: (payload) =>
          registryTrustFrameDigest(payload as unknown as RegistryTrustKeyFrameV1),
      }),
      settings: Buffer.from(
        readProjectionFile(policySettingsPath(this.paths)) ??
          authorityStoreFail("authority settings are missing", "authority.settings"),
      ),
    };
  }
}

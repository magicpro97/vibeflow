import { join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestHex,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
  validateAuthorityEvent,
  validateAuthorityHead,
  validateAuthorityIdentity,
  validateGrantFrame,
  validatePolicyFrame,
  validateSecretRevocationFrame,
  validateTrustFrame,
} from "../authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  AuthorityTransitionEvidenceV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type DurableAuthorityTransitionResolverV1,
  assertDurableAuthorityTransitionResolver,
} from "./durable-authority-transition-resolver.js";
import {
  assertFinalAuthorityJournalState,
  assertInitialAuthorityState,
  readDurableSettingsPolicyState,
} from "./durable-registry-policy.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 10_000;

export interface DurableAuthorityStateV1 {
  identity: AuthorityScopeIdentityRecordV1;
  initial: AuthorityEpochHeadV1;
  current: AuthorityEpochHeadV1;
  events: readonly AuthorityEpochEventV1[];
  grants: readonly GrantFrameV1[];
  policies: readonly PolicyAuthorityFrameV1[];
  secrets: readonly SecretRevocationFrameV1[];
  trust: readonly RegistryTrustKeyFrameV1[];
}

export function assertReconstructedAuthorityHead(
  rebuilt: AuthorityEpochHeadV1,
  current: AuthorityEpochHeadV1,
): void {
  if (canonicalJson(rebuilt) !== canonicalJson(current))
    throw new CapabilityValidationError(
      "authority event/evidence chain does not reconstruct the current head",
      "authority.head",
      "integrity_failure",
    );
}

interface AuthorityJournalsV1 {
  events: AuthorityEpochEventV1[];
  grants: GrantFrameV1[];
  policies: PolicyAuthorityFrameV1[];
  secrets: SecretRevocationFrameV1[];
  trust: RegistryTrustKeyFrameV1[];
}

const DURABLE_STATES = new WeakSet<object>();

function freezeRecord<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeRecord(nested);
    Object.freeze(value);
  }
  return value;
}

function parseCanonical<T>(bytes: Uint8Array | null, label: string): T {
  if (!bytes)
    throw new CapabilityValidationError(`${label} is missing`, label, "integrity_failure");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: MAX_JSON_BYTES })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return parsed as T;
}

function checkpoint(privateRoot: string, digest: string): AuthorityEpochHeadV1 {
  const value = parseCanonical<AuthorityEpochHeadV1>(
    privateFileBytes(
      join(privateRoot, "recovery", "v1", "checkpoints", `${digestHex(digest)}.json`),
      MAX_JSON_BYTES,
    ),
    "authority head checkpoint",
  );
  validateAuthorityHead(value);
  if (value.content_digest !== digest)
    throw new CapabilityValidationError(
      "authority checkpoint fixed-path digest mismatch",
      "authority.checkpoint",
      "integrity_failure",
    );
  return value;
}

function optionalJournal<T>(path: string, options: Parameters<typeof readVffrFile>[1]): T[] {
  if (privateFileBytes(path, MAX_JOURNAL_BYTES) === null) return [];
  return readVffrFile(path, options).map((frame) => frame.payload as unknown as T);
}

function readJournals(
  authorityRoot: string,
  scope: "project" | "user",
  scopeIdentityDigest: string,
): AuthorityJournalsV1 {
  const identity = (payload: Record<string, unknown>) =>
    payload.scope === scope && payload.scope_identity_digest === scopeIdentityDigest;
  const common = {
    maxFrames: MAX_FRAMES,
    maxPayloadBytes: MAX_FRAME_BYTES,
    maxAggregateBytes: MAX_JOURNAL_BYTES,
    initialPreviousDigest: null,
  };
  return {
    events: optionalJournal(join(authorityRoot, "epoch-events.frames"), {
      ...common,
      domain: "authority-epoch",
      sequenceStart: 1,
      validatePayload: (payload) =>
        validateAuthorityEvent(payload as unknown as AuthorityEpochEventV1),
      computePayloadDigest: (payload) =>
        authorityEpochEventDigest(payload as unknown as AuthorityEpochEventV1),
      validateJournalIdentity: identity,
    }),
    grants: optionalJournal(join(authorityRoot, "grants.frames"), {
      ...common,
      domain: "grant-authority",
      sequenceStart: 1,
      validatePayload: (payload) => validateGrantFrame(payload as unknown as GrantFrameV1),
      computePayloadDigest: (payload) => (payload as unknown as GrantFrameV1).frame_digest,
      validateJournalIdentity: identity,
    }),
    policies: optionalJournal(join(authorityRoot, "policy.frames"), {
      ...common,
      domain: "policy-authority",
      sequenceStart: 0,
      validatePayload: (payload) =>
        validatePolicyFrame(payload as unknown as PolicyAuthorityFrameV1),
      computePayloadDigest: (payload) =>
        (payload as unknown as PolicyAuthorityFrameV1).frame_digest,
      validateJournalIdentity: identity,
    }),
    secrets: optionalJournal(join(authorityRoot, "secret-revocations.frames"), {
      ...common,
      domain: "secret-revocation",
      sequenceStart: 0,
      validatePayload: (payload) =>
        validateSecretRevocationFrame(payload as unknown as SecretRevocationFrameV1),
      computePayloadDigest: (payload) =>
        secretRevocationFrameDigest(payload as unknown as SecretRevocationFrameV1),
      validateJournalIdentity: identity,
    }),
    trust: optionalJournal(join(authorityRoot, "registry-trust.frames"), {
      ...common,
      domain: "registry-trust",
      sequenceStart: 1,
      validatePayload: (payload) =>
        validateTrustFrame(payload as unknown as RegistryTrustKeyFrameV1),
      computePayloadDigest: (payload) =>
        registryTrustFrameDigest(payload as unknown as RegistryTrustKeyFrameV1),
      validateJournalIdentity: identity,
    }),
  };
}

function prefixThrough<T>(rows: readonly T[], matches: (row: T) => boolean, label: string): T[] {
  const index = rows.findIndex(matches);
  if (index < 0)
    throw new CapabilityValidationError(`${label} is absent`, label, "integrity_failure");
  return rows.slice(0, index + 1);
}

function evidenceFor(
  event: AuthorityEpochEventV1,
  journals: AuthorityJournalsV1,
  prior: AuthorityEpochHeadV1,
  privateRoot: string,
): AuthorityTransitionEvidenceV1 {
  if (event.change === "grant-changed")
    return {
      change: event.change,
      grant_frames: prefixThrough(
        journals.grants,
        (frame) => frame.frame_digest === event.next_state.grant_head_digest,
        "grant transition evidence",
      ),
    };
  if (event.change === "policy-changed")
    return {
      change: event.change,
      policy_frames: prefixThrough(
        journals.policies,
        (frame) => frame.frame_digest === event.next_state.policy_head_digest,
        "policy transition evidence",
      ),
    };
  if (event.change === "secret-revoked")
    return {
      change: event.change,
      secret_frames: prefixThrough(
        journals.secrets,
        (frame) =>
          frame.authority_epoch === event.authority_epoch &&
          frame.operation_id === event.operation_id &&
          frame.operation_header_digest === event.operation_header_digest,
        "secret transition evidence",
      ),
    };
  if (event.change === "registry-trust-changed")
    return {
      change: event.change,
      trust_frames: journals.trust.slice(0, event.next_state.trust_epoch),
    };
  return { change: event.change, checkpoint_head: checkpoint(privateRoot, prior.content_digest) };
}

export function readDurableAuthorityState(input: {
  private_root: string;
  identity_path: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  initial_authority_head_digest: string;
  authority_transition_resolver: DurableAuthorityTransitionResolverV1;
}): DurableAuthorityStateV1 {
  const resolver = assertDurableAuthorityTransitionResolver(input.authority_transition_resolver);
  const identity = parseCanonical<AuthorityScopeIdentityRecordV1>(
    readProjectionFile(input.identity_path),
    "authority identity",
  );
  validateAuthorityIdentity(identity);
  if (identity.scope !== input.scope || identity.content_digest !== input.scope_identity_digest)
    throw new CapabilityValidationError(
      "authority identity does not equal the selected capability owner",
      "authority.identity",
      "integrity_failure",
    );
  const settings = readDurableSettingsPolicyState(input);
  const initial = checkpoint(input.private_root, input.initial_authority_head_digest);
  const authorityRoot = join(input.private_root, "authority", "v1");
  const current = parseCanonical<AuthorityEpochHeadV1>(
    privateFileBytes(join(authorityRoot, "epoch-head.json"), MAX_JSON_BYTES),
    "authority current head",
  );
  validateAuthorityHead(current);
  const journals = readJournals(authorityRoot, input.scope, input.scope_identity_digest);
  assertInitialAuthorityState(
    initial,
    identity,
    journals.policies[0]?.prior_policy_digest ?? settings.policy_digest,
  );
  if (journals.events.length !== current.authority_epoch)
    throw new CapabilityValidationError(
      "authority event journal length does not equal the current epoch",
      "authority.events",
      "integrity_failure",
    );
  let rebuilt = initial;
  for (const event of journals.events) {
    checkpoint(input.private_root, event.previous_head_checkpoint_digest);
    const evidence = evidenceFor(event, journals, rebuilt, input.private_root);
    const next = applyAuthorityEvent(rebuilt, event, evidence);
    resolver.verify({
      private_root: input.private_root,
      prior: structuredClone(rebuilt),
      event: structuredClone(event),
      evidence: structuredClone(evidence),
      next: structuredClone(next),
    });
    rebuilt = next;
  }
  assertReconstructedAuthorityHead(rebuilt, current);
  assertFinalAuthorityJournalState(initial, rebuilt, journals, settings);
  const state = freezeRecord(structuredClone({ identity, initial, current, ...journals }));
  DURABLE_STATES.add(state);
  return state;
}

export function assertDurableAuthorityState(
  value: DurableAuthorityStateV1,
): DurableAuthorityStateV1 {
  if (!DURABLE_STATES.has(value))
    throw new CapabilityValidationError(
      "authority state is not derived from the concrete durable fold",
      "authority.state",
      "integrity_failure",
    );
  return value;
}

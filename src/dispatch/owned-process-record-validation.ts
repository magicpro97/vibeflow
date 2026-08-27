import { ENGINES, type Engine } from "../core/types.js";
import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
import {
  PROCESS_START_IDENTITY_KIND,
  isNativeProcessStartIdentity,
  isProcessStartIdentity,
  parseSyntheticProcessStartIdentity,
} from "../durability/process-identity-contract.js";
import {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_DIGEST_PREFIX,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_PROOF_STRENGTHS,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_QUIESCENCE_SCOPES,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STATES,
  OWNED_PROCESS_STRATEGIES,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KINDS,
  type OwnedProcessRecordField,
  type OwnedProcessReleaseProofField,
  type OwnedProcessState,
  type OwnedProcessTerminalKind,
  hasExactOwnedProcessRecordFields,
} from "./owned-process-contract.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";

const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST = new RegExp(`^${OWNED_PROCESS_DIGEST_PREFIX}[0-9a-f]{64}$`);
const LEGACY_PRIOR_DIGEST_MISSING = Symbol("owned-process-legacy-prior-digest-missing");
const LEGACY_PROOF_BINDING_MISSING = Symbol("owned-process-legacy-proof-binding-missing");

export type OwnedAttemptProcessRecordV1 = {
  [OWNED_PROCESS_RECORD_FIELD.SCHEMA_VERSION]: typeof OWNED_PROCESS_SCHEMA_VERSION;
  [OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID]: string;
  [OWNED_PROCESS_RECORD_FIELD.ENGINE]: Engine;
  [OWNED_PROCESS_RECORD_FIELD.HOST]: string;
  [OWNED_PROCESS_RECORD_FIELD.PLATFORM]: NodeJS.Platform;
  [OWNED_PROCESS_RECORD_FIELD.STRATEGY]: OwnedProcessPlatform[typeof OWNED_PROCESS_RECORD_FIELD.STRATEGY];
  [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]: (typeof OWNED_PROCESS_QUIESCENCE_SCOPES)[number];
  [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]: (typeof OWNED_PROCESS_PROOF_STRENGTHS)[number];
  [OWNED_PROCESS_RECORD_FIELD.OWNER_PID]: number;
  [OWNED_PROCESS_RECORD_FIELD.OWNER_IDENTITY]: string;
  [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: number | null;
  [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: string | null;
  [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: number | null;
  [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: string | null;
  [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: OwnedProcessTerminalKind | null;
  [OWNED_PROCESS_RECORD_FIELD.STATE]: OwnedProcessState;
  [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: string | null;
  [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: number | null;
  [OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT]: boolean;
  [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: string | null;
  [OWNED_PROCESS_RECORD_FIELD.RECORDED_AT]: string;
  [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: string;
  [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: string;
};

export type OwnedProcessReleaseProof = {
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROCESS_QUIESCENT]: true;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.STRATEGY]: OwnedProcessPlatform[typeof OWNED_PROCESS_RECORD_FIELD.STRATEGY];
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE]: OwnedAttemptProcessRecordV1[typeof OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE];
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH]: OwnedAttemptProcessRecordV1[typeof OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH];
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST]: string;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_RECORD_DIGEST]: string;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]: string;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.TERMINAL_KIND]: OwnedProcessTerminalKind | null;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.EXIT_CODE]: number | null;
  [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_AT]: string;
};

type SameKeys<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;
export type OwnedProcessRecordFieldParity = Assert<
  SameKeys<keyof OwnedAttemptProcessRecordV1, OwnedProcessRecordField>
>;
export type OwnedProcessReleaseProofFieldParity = Assert<
  SameKeys<keyof OwnedProcessReleaseProof, OwnedProcessReleaseProofField>
>;

type StoredOwnedAttemptProcessRecord = OwnedAttemptProcessRecordV1 & {
  [LEGACY_PRIOR_DIGEST_MISSING]?: true;
  [LEGACY_PROOF_BINDING_MISSING]?: true;
};

function recordDigest(value: unknown): string {
  return digestV1(OWNED_PROCESS_DIGEST_DOMAIN.RECORD, value);
}

export function ownedProcessTimestamp(): string {
  return new Date().toISOString();
}

export function ownedProcessPreimage(
  record: OwnedAttemptProcessRecordV1,
): Omit<OwnedAttemptProcessRecordV1, typeof OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST> {
  const { [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: _ignored, ...value } = record;
  return value;
}

export function buildOwnedProcessRecord(
  value: Omit<OwnedAttemptProcessRecordV1, typeof OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST>,
): OwnedAttemptProcessRecordV1 {
  const record = {
    ...value,
    [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: recordDigest(value),
  };
  assertOwnedProcessRecord(record);
  return record;
}

const isEngine = (value: unknown): value is Engine => ENGINES.some((engine) => engine === value);
const isNullablePositiveInteger = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const isNullableSafeInteger = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value));
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isBoundOwnedCliIdentity(input: {
  identity: unknown;
  cliPid: unknown;
  supervisorPid: unknown;
  supervisorIdentity: unknown;
  strategy: unknown;
}): boolean {
  if (!isProcessStartIdentity(input.identity)) return false;
  if (isNativeProcessStartIdentity(input.identity)) return true;
  if (
    !Number.isSafeInteger(input.cliPid) ||
    !Number.isSafeInteger(input.supervisorPid) ||
    typeof input.supervisorIdentity !== "string"
  )
    return false;
  const claim = parseSyntheticProcessStartIdentity(input.identity);
  if (!claim || claim.pid !== input.cliPid) return false;
  return claim.kind === PROCESS_START_IDENTITY_KIND.POSIX_PROCESS_GROUP
    ? input.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
        claim.processGroupId === input.supervisorPid
    : input.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE &&
        claim.supervisorIdentity === input.supervisorIdentity;
}

export function assertOwnedProcessRecord(
  value: unknown,
): asserts value is OwnedAttemptProcessRecordV1 {
  if (!isUnknownRecord(value)) throw new Error("invalid owned process record");
  const row = value;
  const field = OWNED_PROCESS_RECORD_FIELD;
  const hasQuiescenceScope = Object.hasOwn(row, field.QUIESCENCE_SCOPE);
  const hasProofStrength = Object.hasOwn(row, OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH);
  const isLegacyUnscoped = !hasQuiescenceScope && !hasProofStrength;
  const state = row[field.STATE];
  const attemptId = row[field.ATTEMPT_ID];
  const strategy = row[field.STRATEGY];
  const quiescenceScope = row[field.QUIESCENCE_SCOPE];
  const proofStrength = row[field.PROOF_STRENGTH];
  const ownerPid = row[field.OWNER_PID];
  const supervisorPid = row[field.SUPERVISOR_PID];
  const supervisorIdentity = row[field.SUPERVISOR_IDENTITY];
  const cliPid = row[field.CLI_PID];
  const cliIdentity = row[field.CLI_IDENTITY];
  const terminalKind = row[field.TERMINAL_KIND];
  const processQuiescent = row[field.PROCESS_QUIESCENT];
  const priorRecordDigest = row[field.PRIOR_RECORD_DIGEST];
  const recordedAt = row[field.RECORDED_AT];
  const updatedAt = row[field.UPDATED_AT];
  const recordDigestValue = row[field.RECORD_DIGEST];
  const hasLegacyProofBinding =
    quiescenceScope === OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED &&
    proofStrength === OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED;
  const hasQualifiedProofBinding =
    (strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE &&
      quiescenceScope === OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB &&
      proofStrength === OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED) ||
    (strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      quiescenceScope === OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP &&
      proofStrength === OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE);
  if (
    !hasExactOwnedProcessRecordFields(row) ||
    row[field.SCHEMA_VERSION] !== OWNED_PROCESS_SCHEMA_VERSION ||
    typeof attemptId !== "string" ||
    !ATTEMPT_ID.test(attemptId) ||
    !isEngine(row[field.ENGINE]) ||
    typeof row[field.HOST] !== "string" ||
    typeof row[field.PLATFORM] !== "string" ||
    !OWNED_PROCESS_STRATEGIES.some((candidate) => candidate === strategy) ||
    hasQuiescenceScope !== hasProofStrength ||
    (!isLegacyUnscoped &&
      !OWNED_PROCESS_QUIESCENCE_SCOPES.some((candidate) => candidate === quiescenceScope)) ||
    (!isLegacyUnscoped &&
      !OWNED_PROCESS_PROOF_STRENGTHS.some((candidate) => candidate === proofStrength)) ||
    (!hasQualifiedProofBinding &&
      !(state === OWNED_PROCESS_STATE.RELEASED && (isLegacyUnscoped || hasLegacyProofBinding))) ||
    typeof ownerPid !== "number" ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid < 1 ||
    !isNativeProcessStartIdentity(row[field.OWNER_IDENTITY]) ||
    !isNullablePositiveInteger(supervisorPid) ||
    !(supervisorIdentity === null || isNativeProcessStartIdentity(supervisorIdentity)) ||
    !isNullablePositiveInteger(cliPid) ||
    !(
      cliIdentity === null ||
      isBoundOwnedCliIdentity({
        identity: cliIdentity,
        cliPid,
        supervisorPid,
        supervisorIdentity,
        strategy,
      })
    ) ||
    !(
      terminalKind === null || OWNED_PROCESS_TERMINAL_KINDS.some((kind) => kind === terminalKind)
    ) ||
    !OWNED_PROCESS_STATES.some((candidate) => candidate === state) ||
    !isNullableString(row[field.RELEASE_REASON]) ||
    !isNullableSafeInteger(row[field.EXIT_CODE]) ||
    typeof processQuiescent !== "boolean" ||
    !(
      priorRecordDigest === undefined ||
      priorRecordDigest === null ||
      (typeof priorRecordDigest === "string" && DIGEST.test(priorRecordDigest))
    ) ||
    typeof recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(recordedAt) ||
    typeof updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) ||
    typeof recordDigestValue !== "string" ||
    !DIGEST.test(recordDigestValue) ||
    (state === OWNED_PROCESS_STATE.RUNNING &&
      (!supervisorPid || !supervisorIdentity || !cliPid || !cliIdentity)) ||
    (state === OWNED_PROCESS_STATE.RELEASED && processQuiescent !== true) ||
    (state !== OWNED_PROCESS_STATE.RELEASED && processQuiescent !== false)
  ) {
    throw new Error("invalid owned process record");
  }
  const { [field.RECORD_DIGEST]: _ignored, ...preimage } = row;
  const stored = row as StoredOwnedAttemptProcessRecord;
  const persistedPreimage = { ...preimage };
  if (stored[LEGACY_PRIOR_DIGEST_MISSING]) {
    Reflect.deleteProperty(persistedPreimage, field.PRIOR_RECORD_DIGEST);
  }
  if (stored[LEGACY_PROOF_BINDING_MISSING]) {
    Reflect.deleteProperty(persistedPreimage, field.QUIESCENCE_SCOPE);
    Reflect.deleteProperty(persistedPreimage, field.PROOF_STRENGTH);
  }
  if (
    recordDigest({
      ...preimage,
      [field.PRIOR_RECORD_DIGEST]: priorRecordDigest ?? null,
    }) !== recordDigestValue &&
    recordDigest(persistedPreimage) !== recordDigestValue
  ) {
    throw new Error("invalid owned process digest");
  }
}

export function normalizeStoredOwnedProcessRecord(
  value: OwnedAttemptProcessRecordV1,
): OwnedAttemptProcessRecordV1 {
  const missingPriorDigest = !Object.prototype.hasOwnProperty.call(
    value,
    OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST,
  );
  const missingProofBinding =
    !Object.prototype.hasOwnProperty.call(value, OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE) &&
    !Object.prototype.hasOwnProperty.call(value, OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH);
  const normalized = structuredClone(value) as StoredOwnedAttemptProcessRecord;
  if (missingPriorDigest) {
    normalized[OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST] = null;
    Object.defineProperty(normalized, LEGACY_PRIOR_DIGEST_MISSING, { value: true });
  }
  if (missingProofBinding) {
    normalized[OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE] =
      OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED;
    normalized[OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH] =
      OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED;
    Object.defineProperty(normalized, LEGACY_PROOF_BINDING_MISSING, { value: true });
  }
  return normalized;
}

export function expectedOwnedProcessCurrentBytes(
  current: OwnedAttemptProcessRecordV1,
): Uint8Array<ArrayBufferLike> {
  const stored = current as StoredOwnedAttemptProcessRecord;
  if (!stored[LEGACY_PRIOR_DIGEST_MISSING] && !stored[LEGACY_PROOF_BINDING_MISSING])
    return canonicalJsonBytes(stored);
  if (stored[LEGACY_PRIOR_DIGEST_MISSING] && stored[LEGACY_PROOF_BINDING_MISSING]) {
    const {
      [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: _prior,
      [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]: _strength,
      [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]: _scope,
      ...legacy
    } = stored;
    return canonicalJsonBytes(legacy);
  }
  if (stored[LEGACY_PRIOR_DIGEST_MISSING]) {
    const { [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: _prior, ...legacy } = stored;
    return canonicalJsonBytes(legacy);
  }
  const {
    [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]: _strength,
    [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]: _scope,
    ...legacy
  } = stored;
  return canonicalJsonBytes(legacy);
}

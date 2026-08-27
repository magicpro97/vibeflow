import { describe, expect, test } from "bun:test";
import {
  OWNED_PROCESS_AUTHORITY_ERROR,
  assertOwnedProcessWriteTransition,
} from "../src/dispatch/owned-process-authority-contract.js";
import {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KIND,
} from "../src/dispatch/owned-process-contract.js";
import {
  type OwnedAttemptProcessRecordV1,
  type OwnedProcessReleaseProof,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
  expectedOwnedProcessCurrentBytes,
  normalizeStoredOwnedProcessRecord,
  ownedProcessPreimage,
} from "../src/dispatch/owned-process-record-validation.js";
import {
  createOwnedProcessReleaseProof,
  verifyOwnedProcessReleaseProof,
} from "../src/dispatch/owned-process-release-proof.js";
import { canonicalJsonBytes, digestV1 } from "../src/durability/index.js";
import {
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_SEGMENT,
  formatPlatformProcessStartIdentity,
  formatProcessStartIdentity,
  parseSyntheticProcessStartIdentity,
} from "../src/durability/process-identity-contract.js";

const field = OWNED_PROCESS_RECORD_FIELD;
const T0 = "2026-08-25T12:00:00.000Z";
const T1 = "2026-08-25T12:00:01.000Z";
const T2 = "2026-08-25T12:00:02.000Z";
const BEFORE = "2026-08-25T11:59:59.000Z";
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const OWNER_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "coverage-owner");
const SUPERVISOR_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "coverage-supervisor");
const SECOND_SUPERVISOR_IDENTITY = formatPlatformProcessStartIdentity(
  "freebsd",
  "coverage-supervisor-second",
);
const CLI_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "coverage-cli");

type OwnedProcessPreimage = Omit<
  OwnedAttemptProcessRecordV1,
  typeof OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST
>;

function ownedRecord(overrides: Partial<OwnedProcessPreimage> = {}): OwnedAttemptProcessRecordV1 {
  return buildOwnedProcessRecord({
    [field.SCHEMA_VERSION]: OWNED_PROCESS_SCHEMA_VERSION,
    [field.ATTEMPT_ID]: "coverage-runtime-authority",
    [field.ENGINE]: "codex",
    [field.HOST]: "coverage-host",
    [field.PLATFORM]: "freebsd",
    [field.STRATEGY]: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
    [field.QUIESCENCE_SCOPE]: OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    [field.PROOF_STRENGTH]: OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE,
    [field.OWNER_PID]: 40,
    [field.OWNER_IDENTITY]: OWNER_IDENTITY,
    [field.SUPERVISOR_PID]: null,
    [field.SUPERVISOR_IDENTITY]: null,
    [field.CLI_PID]: null,
    [field.CLI_IDENTITY]: null,
    [field.TERMINAL_KIND]: null,
    [field.STATE]: OWNED_PROCESS_STATE.RESERVED,
    [field.RELEASE_REASON]: null,
    [field.EXIT_CODE]: null,
    [field.PROCESS_QUIESCENT]: false,
    [field.PRIOR_RECORD_DIGEST]: null,
    [field.RECORDED_AT]: T0,
    [field.UPDATED_AT]: T0,
    ...overrides,
  });
}

function runningRecord(overrides: Partial<OwnedProcessPreimage> = {}) {
  return ownedRecord({
    [field.SUPERVISOR_PID]: 700,
    [field.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
    [field.CLI_PID]: 701,
    [field.CLI_IDENTITY]: CLI_IDENTITY,
    [field.STATE]: OWNED_PROCESS_STATE.RUNNING,
    [field.UPDATED_AT]: T1,
    ...overrides,
  });
}

function releasedRecord(): OwnedAttemptProcessRecordV1 {
  return ownedRecord({
    [field.STATE]: OWNED_PROCESS_STATE.RELEASED,
    [field.RELEASE_REASON]: "coverage release",
    [field.EXIT_CODE]: 0,
    [field.PROCESS_QUIESCENT]: true,
    [field.PRIOR_RECORD_DIGEST]: ZERO_DIGEST,
    [field.UPDATED_AT]: T1,
  });
}

function releaseProof(released: OwnedAttemptProcessRecordV1): OwnedProcessReleaseProof {
  return createOwnedProcessReleaseProof({
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROCESS_QUIESCENT]: true,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.STRATEGY]: released[field.STRATEGY],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE]: released[field.QUIESCENCE_SCOPE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH]: released[field.PROOF_STRENGTH],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST]: ZERO_DIGEST,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_RECORD_DIGEST]: released[field.RECORD_DIGEST],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.TERMINAL_KIND]: released[field.TERMINAL_KIND],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.EXIT_CODE]: released[field.EXIT_CODE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_AT]: released[field.UPDATED_AT],
  });
}

function legacyStoredRecord(input: { missingPrior: boolean; missingProof: boolean }) {
  const preimage = ownedProcessPreimage(releasedRecord()) as Record<string, unknown>;
  if (input.missingPrior) Reflect.deleteProperty(preimage, field.PRIOR_RECORD_DIGEST);
  if (input.missingProof) {
    Reflect.deleteProperty(preimage, field.QUIESCENCE_SCOPE);
    Reflect.deleteProperty(preimage, field.PROOF_STRENGTH);
  }
  return {
    ...preimage,
    [field.RECORD_DIGEST]: digestV1(OWNED_PROCESS_DIGEST_DOMAIN.RECORD, preimage),
  };
}

describe("owned process authority final branch coverage", () => {
  test("rejects a non-canonical genesis record", () => {
    const nonCanonicalGenesis = ownedRecord({ [field.UPDATED_AT]: T1 });
    expect(() => assertOwnedProcessWriteTransition(null, nonCanonicalGenesis)).toThrow(
      /non-canonical genesis/,
    );
  });

  test("keeps persisted process identity bindings monotonic", () => {
    const current = ownedRecord({
      [field.SUPERVISOR_PID]: 700,
      [field.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
      [field.UPDATED_AT]: T1,
    });
    const rebound = runningRecord({
      [field.SUPERVISOR_PID]: 702,
      [field.SUPERVISOR_IDENTITY]: SECOND_SUPERVISOR_IDENTITY,
      [field.UPDATED_AT]: T2,
    });
    expect(() => assertOwnedProcessWriteTransition(current, rebound)).toThrow(
      /process identity binding changed/,
    );
  });

  test("requires every persisted identity to retain its PID binding", () => {
    const current = ownedRecord();
    const identityWithoutPid = ownedRecord({
      [field.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
      [field.UPDATED_AT]: T1,
    });
    expect(() => assertOwnedProcessWriteTransition(current, identityWithoutPid)).toThrow(
      /identity lacks its PID binding/,
    );
  });

  test("accepts only the canonical same-state reservation and terminal mutations", () => {
    const bound = ownedRecord({
      [field.SUPERVISOR_PID]: 700,
      [field.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
      [field.UPDATED_AT]: T1,
    });
    const rewrittenReservation = ownedRecord({
      [field.SUPERVISOR_PID]: 700,
      [field.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
      [field.UPDATED_AT]: T2,
    });
    expect(() => assertOwnedProcessWriteTransition(bound, rewrittenReservation)).toThrow(
      /not a supervisor bind/,
    );

    const observed = runningRecord({
      [field.TERMINAL_KIND]: OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED,
    });
    const rewrittenObservation = runningRecord({
      [field.TERMINAL_KIND]: OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED,
      [field.UPDATED_AT]: T2,
    });
    expect(() => assertOwnedProcessWriteTransition(observed, rewrittenObservation)).toThrow(
      /not a terminal observation/,
    );
  });

  test("rejects a backwards write clock and an unbound release lineage", () => {
    const current = ownedRecord();
    const backwards = runningRecord({ [field.UPDATED_AT]: BEFORE });
    expect(() => assertOwnedProcessWriteTransition(current, backwards)).toThrow(
      /updated_at moved backwards/,
    );

    const wrongPrior = ownedRecord({
      [field.STATE]: OWNED_PROCESS_STATE.RELEASED,
      [field.RELEASE_REASON]: "wrong lineage",
      [field.EXIT_CODE]: 0,
      [field.PROCESS_QUIESCENT]: true,
      [field.PRIOR_RECORD_DIGEST]: ZERO_DIGEST,
      [field.UPDATED_AT]: T1,
    });
    expect(() => assertOwnedProcessWriteTransition(current, wrongPrior)).toThrow(
      /does not bind the prior record digest/,
    );
  });

  test("normalizes and preserves every supported legacy byte shape", () => {
    for (const shape of [
      { missingPrior: true, missingProof: true },
      { missingPrior: true, missingProof: false },
      { missingPrior: false, missingProof: true },
    ]) {
      const stored = legacyStoredRecord(shape);
      expect(() => assertOwnedProcessRecord(stored)).not.toThrow();
      const normalized = normalizeStoredOwnedProcessRecord(stored as OwnedAttemptProcessRecordV1);
      expect(() => assertOwnedProcessRecord(normalized)).not.toThrow();
      expect(
        Buffer.from(expectedOwnedProcessCurrentBytes(normalized)).equals(
          canonicalJsonBytes(stored),
        ),
      ).toBe(true);
    }
  });

  test("rejects a release proof when the released record is malformed", () => {
    const released = releasedRecord();
    expect(verifyOwnedProcessReleaseProof(releaseProof(released), {})).toBe(false);
  });

  test("rejects a Windows exited receipt with a non-positive CLI PID", () => {
    const malformed = formatProcessStartIdentity(
      PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
      formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, 123),
      PROCESS_START_IDENTITY_SEGMENT.PID,
      0,
    );
    expect(parseSyntheticProcessStartIdentity(malformed)).toBeNull();
  });

  test("uses the centralized transition error prefix", () => {
    expect(() =>
      assertOwnedProcessWriteTransition(runningRecord(), ownedRecord({ [field.UPDATED_AT]: T2 })),
    ).toThrow(OWNED_PROCESS_AUTHORITY_ERROR.WRITE_TRANSITION);
  });
});

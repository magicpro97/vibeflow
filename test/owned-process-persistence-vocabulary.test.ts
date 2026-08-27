import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OWNED_PROCESS_AUTHORITY_ERROR,
  OWNED_PROCESS_AUTHORITY_OPERATION,
} from "../src/dispatch/owned-process-authority-contract.js";
import {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_DIGEST_PREFIX,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RECORD_FIELDS,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELDS,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STORAGE_NAME,
  OWNED_PROCESS_STRATEGY,
} from "../src/dispatch/owned-process-contract.js";
import {
  type OwnedAttemptProcessRecordV1,
  type OwnedProcessRecordFieldParity,
  type OwnedProcessReleaseProofFieldParity,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
} from "../src/dispatch/owned-process-record.js";
import {
  createOwnedProcessReleaseProof,
  isOwnedProcessReleaseProof,
  verifyOwnedProcessReleaseProof,
} from "../src/dispatch/owned-process-release-proof.js";
import { digestV1 } from "../src/durability/index.js";
import {
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_SEGMENT,
  formatProcessStartIdentity,
  isProcessStartIdentity,
} from "../src/durability/process-identity-contract.js";

const FIELD_PARITY: readonly [OwnedProcessRecordFieldParity, OwnedProcessReleaseProofFieldParity] =
  [true, true];

const ZERO_DIGEST = `${OWNED_PROCESS_DIGEST_PREFIX}${"0".repeat(64)}`;
const LINUX_BOOT_ID = "123e4567-e89b-12d3-a456-426614174000";
const LINUX_OWNER_IDENTITY = formatProcessStartIdentity(
  PROCESS_START_IDENTITY_PREFIX.LINUX,
  LINUX_BOOT_ID,
  40,
);

function releasedRecord(): OwnedAttemptProcessRecordV1 {
  const timestamp = "2026-08-26T00:00:00.000Z";
  return buildOwnedProcessRecord({
    [OWNED_PROCESS_RECORD_FIELD.SCHEMA_VERSION]: OWNED_PROCESS_SCHEMA_VERSION,
    [OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID]: "owned-vocabulary",
    [OWNED_PROCESS_RECORD_FIELD.ENGINE]: "codex",
    [OWNED_PROCESS_RECORD_FIELD.HOST]: "test-host",
    [OWNED_PROCESS_RECORD_FIELD.PLATFORM]: "linux",
    [OWNED_PROCESS_RECORD_FIELD.STRATEGY]: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
    [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]:
      OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]: OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE,
    [OWNED_PROCESS_RECORD_FIELD.OWNER_PID]: 40,
    [OWNED_PROCESS_RECORD_FIELD.OWNER_IDENTITY]: LINUX_OWNER_IDENTITY,
    [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: null,
    [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: null,
    [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: null,
    [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: null,
    [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: null,
    [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RELEASED,
    [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: "test release",
    [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: 0,
    [OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT]: true,
    [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: ZERO_DIGEST,
    [OWNED_PROCESS_RECORD_FIELD.RECORDED_AT]: timestamp,
    [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: timestamp,
  });
}

function releaseProof(released: OwnedAttemptProcessRecordV1) {
  return createOwnedProcessReleaseProof({
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROCESS_QUIESCENT]: true,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.STRATEGY]: released[OWNED_PROCESS_RECORD_FIELD.STRATEGY],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE]:
      released[OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH]:
      released[OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST]: ZERO_DIGEST,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_RECORD_DIGEST]:
      released[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.TERMINAL_KIND]:
      released[OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.EXIT_CODE]: released[OWNED_PROCESS_RECORD_FIELD.EXIT_CODE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_AT]:
      released[OWNED_PROCESS_RECORD_FIELD.UPDATED_AT],
  });
}

describe("owned process persistence vocabulary", () => {
  test("process identity parser accepts each canonical grammar and rejects lookalikes", () => {
    const valid = [
      LINUX_OWNER_IDENTITY,
      formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, 638_602_314_960_000_000n),
      formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.DARWIN, 1_724_672_096, 123_456),
      "freebsd:Mon Aug 26 12:34:56 2026",
      formatProcessStartIdentity(
        PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
        700,
        PROCESS_START_IDENTITY_SEGMENT.PID,
        701,
      ),
      formatProcessStartIdentity(
        PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
        formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, 638_602_314_960_000_000n),
        PROCESS_START_IDENTITY_SEGMENT.PID,
        701,
      ),
    ];
    const invalid: readonly unknown[] = [
      "linux:boot:40",
      `linux:${LINUX_BOOT_ID}:0`,
      "win32:0",
      "win32:expected",
      "darwin:0:123456",
      "darwin:1724672096:1000000",
      "solaris:Mon Aug 26 12:34:56 2026",
      "freebsd:line\nbreak",
      "posix-pgid:700:child:701",
      "win32-exited:win32:638602314960000000:child:701",
      "x".repeat(513),
      null,
    ];

    expect(valid.every(isProcessStartIdentity)).toBe(true);
    expect(invalid.some(isProcessStartIdentity)).toBe(false);
  });

  test("record and proof keys are frozen, complete, and accepted exactly", () => {
    const released = releasedRecord();
    const proof = releaseProof(released);
    expect(Object.isFrozen(OWNED_PROCESS_RECORD_FIELD)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_RECORD_FIELDS)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_RELEASE_PROOF_FIELD)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_RELEASE_PROOF_FIELDS)).toBe(true);
    expect(Object.isFrozen(PROCESS_START_IDENTITY_PREFIX)).toBe(true);
    expect(Object.isFrozen(PROCESS_START_IDENTITY_SEGMENT)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_DIGEST_DOMAIN)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_STORAGE_NAME)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_AUTHORITY_OPERATION)).toBe(true);
    expect(Object.isFrozen(OWNED_PROCESS_AUTHORITY_ERROR)).toBe(true);
    expect(Object.keys(released).sort()).toEqual([...OWNED_PROCESS_RECORD_FIELDS].sort());
    expect(Object.keys(proof).sort()).toEqual([...OWNED_PROCESS_RELEASE_PROOF_FIELDS].sort());
    expect(verifyOwnedProcessReleaseProof(proof, released)).toBe(true);
    expect(FIELD_PARITY).toEqual([true, true]);
  });

  test("synthetic CLI identities bind the exact persisted supervisor and CLI PIDs", () => {
    const released = releasedRecord();
    const { [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: _ignored, ...base } = released;
    const supervisorPid = 700;
    const cliPid = 701;
    const bound = formatProcessStartIdentity(
      PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
      supervisorPid,
      PROCESS_START_IDENTITY_SEGMENT.PID,
      cliPid,
    );
    expect(
      buildOwnedProcessRecord({
        ...base,
        [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: supervisorPid,
        [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: LINUX_OWNER_IDENTITY,
        [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: cliPid,
        [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: bound,
      })[OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY],
    ).toBe(bound);
    for (const forgedIdentity of [
      formatProcessStartIdentity(
        PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
        999,
        PROCESS_START_IDENTITY_SEGMENT.PID,
        cliPid,
      ),
      formatProcessStartIdentity(
        PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
        supervisorPid,
        PROCESS_START_IDENTITY_SEGMENT.PID,
        888,
      ),
    ]) {
      expect(() =>
        buildOwnedProcessRecord({
          ...base,
          [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: supervisorPid,
          [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: LINUX_OWNER_IDENTITY,
          [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: cliPid,
          [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: forgedIdentity,
        }),
      ).toThrow("invalid owned process record");
    }
    const windowsSupervisorIdentity = formatProcessStartIdentity(
      PROCESS_START_IDENTITY_PREFIX.WINDOWS,
      638_602_314_960_000_000n,
    );
    const windowsBase = {
      ...base,
      [OWNED_PROCESS_RECORD_FIELD.PLATFORM]: "win32" as const,
      [OWNED_PROCESS_RECORD_FIELD.STRATEGY]: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
      [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
      [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: supervisorPid,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: windowsSupervisorIdentity,
      [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: cliPid,
    };
    const exitedIdentity = formatProcessStartIdentity(
      PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
      windowsSupervisorIdentity,
      PROCESS_START_IDENTITY_SEGMENT.PID,
      cliPid,
    );
    expect(
      buildOwnedProcessRecord({
        ...windowsBase,
        [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: exitedIdentity,
      })[OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY],
    ).toBe(exitedIdentity);
    expect(() =>
      buildOwnedProcessRecord({
        ...windowsBase,
        [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: formatProcessStartIdentity(
          PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
          formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, 1),
          PROCESS_START_IDENTITY_SEGMENT.PID,
          cliPid,
        ),
      }),
    ).toThrow("invalid owned process record");
  });

  test("record validation rejects an unknown field even when its digest is recomputed", () => {
    const released = releasedRecord();
    const { [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: _ignored, ...preimage } = released;
    const forgedPreimage = { ...preimage, injected: "unknown-field" };
    const forged = {
      ...forgedPreimage,
      [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]: digestV1(
        OWNED_PROCESS_DIGEST_DOMAIN.RECORD,
        forgedPreimage,
      ),
    };
    expect(() => assertOwnedProcessRecord(forged)).toThrow("invalid owned process record");
  });

  test("release proof validation rejects an unknown field with a recomputed verifier", () => {
    const released = releasedRecord();
    const proof = releaseProof(released);
    const { [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]: _ignored, ...preimage } = proof;
    const forgedPreimage = { ...preimage, injected: "unknown-field" };
    const forged = {
      ...forgedPreimage,
      [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]: digestV1(
        OWNED_PROCESS_DIGEST_DOMAIN.RELEASE_PROOF,
        forgedPreimage,
      ),
    };
    expect(isOwnedProcessReleaseProof(forged)).toBe(false);
    expect(verifyOwnedProcessReleaseProof(forged, released)).toBe(false);
  });

  test("identity, digest, and storage literals appear only in their contracts", () => {
    const identityConsumers = [
      "src/durability/lock-owner.ts",
      "src/dispatch/owned-process-launch.ts",
      "src/dispatch/owned-process-platform.ts",
      "src/dispatch/owned-process-runtime.ts",
    ];
    for (const file of identityConsumers) {
      const source = readFileSync(resolve(file), "utf8");
      for (const prefix of Object.values(PROCESS_START_IDENTITY_PREFIX)) {
        expect(source.includes(prefix)).toBe(false);
      }
    }
    expect(readFileSync(resolve("src/dispatch/owned-process-runtime.ts"), "utf8")).not.toContain(
      `"${PROCESS_START_IDENTITY_SEGMENT.PID}"`,
    );

    const persistenceConsumers = [
      "src/dispatch/owned-process-platform.ts",
      "src/dispatch/owned-process-record.ts",
      "src/dispatch/owned-process-release-proof.ts",
      "src/dispatch/owned-process-runtime.ts",
    ];
    const centralizedLiterals = [
      ...Object.values(OWNED_PROCESS_DIGEST_DOMAIN),
      OWNED_PROCESS_STORAGE_NAME.RECORD_DIRECTORY,
      OWNED_PROCESS_STORAGE_NAME.WRITER_LOCK_FILE,
    ];
    for (const file of persistenceConsumers) {
      const source = readFileSync(resolve(file), "utf8");
      for (const literal of centralizedLiterals) expect(source.includes(literal)).toBe(false);
      for (const field of [...OWNED_PROCESS_RECORD_FIELDS, ...OWNED_PROCESS_RELEASE_PROOF_FIELDS]) {
        expect(source.includes(`"${field}"`)).toBe(false);
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_CLI_IDENTITY_STATES,
  OWNED_PROCESS_ENV,
  OWNED_PROCESS_EXIT_CODE,
  OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE,
  OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES,
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_PRESENCE_KINDS,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_PROOF_STRENGTHS,
  OWNED_PROCESS_QUIESCENCE_MODE,
  OWNED_PROCESS_QUIESCENCE_MODES,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_QUIESCENCE_SCOPES,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STATES,
  OWNED_PROCESS_STRATEGIES,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KIND,
  OWNED_PROCESS_TERMINAL_KINDS,
  OWNED_PROCESS_TIMING_MS,
  OWNED_SUPERVISOR_OUTCOME_KIND,
  OWNED_SUPERVISOR_OUTCOME_KINDS,
  OWNED_SUPERVISOR_PHASE,
  OWNED_SUPERVISOR_PHASES,
  OWNED_SUPERVISOR_RECEIPT_KEY,
  OWNED_SUPERVISOR_RECEIPT_KEYS,
  OWNED_SUPERVISOR_RECEIPT_PHASE,
  OWNED_SUPERVISOR_RECEIPT_PHASES,
  OWNED_SUPERVISOR_STATUS_KEY,
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  OWNED_SUPERVISOR_TERMINAL_PHASES,
  OWNED_WINDOWS_JOB,
  OWNED_WINDOWS_LIMIT,
  OWNED_WINDOWS_QUERY_STATUS,
  isOwnedCliIdentityState,
  isOwnedProcessIgnorableStreamErrorCode,
  isOwnedProcessPresenceKind,
  isOwnedProcessProofStrength,
  isOwnedProcessQuiescenceMode,
  isOwnedProcessQuiescenceScope,
  isOwnedProcessState,
  isOwnedProcessStrategy,
  isOwnedProcessTerminalKind,
  isOwnedSupervisorOutcomeKind,
  isOwnedSupervisorPhase,
  isOwnedSupervisorReceiptKey,
  isOwnedSupervisorReceiptPhase,
  isOwnedSupervisorTerminalPhase,
} from "../src/dispatch/owned-process-contract.js";
import {
  ignorableOwnedStdinError,
  waitForOwnedSupervisorReceipt,
} from "../src/dispatch/owned-process-launch-receipt.js";
import { OWNED_SUPERVISOR_SCRIPT } from "../src/dispatch/owned-process-launch.js";
import {
  OwnedProcessRecordStore,
  buildOwnedProcessRecord,
} from "../src/dispatch/owned-process-record.js";
import { canonicalJsonBytes } from "../src/durability/index.js";
import {
  PROCESS_START_IDENTITY_CONTRACT,
  PROCESS_START_IDENTITY_PREFIX,
  formatProcessStartIdentity,
} from "../src/durability/process-identity-contract.js";
const valuesAreUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;
const LINUX_BOOT_ID = "123e4567-e89b-12d3-a456-426614174000";
const CLI_IDENTITY = formatProcessStartIdentity(
  PROCESS_START_IDENTITY_PREFIX.LINUX,
  LINUX_BOOT_ID,
  42,
);

describe("owned process protocol contract", () => {
  test("closed vocabularies are frozen, parity-safe, and narrowed fail-closed", () => {
    const vocabularies = [
      [OWNED_PROCESS_STATE, OWNED_PROCESS_STATES, isOwnedProcessState],
      [OWNED_PROCESS_STRATEGY, OWNED_PROCESS_STRATEGIES, isOwnedProcessStrategy],
      [
        OWNED_PROCESS_QUIESCENCE_SCOPE,
        OWNED_PROCESS_QUIESCENCE_SCOPES,
        isOwnedProcessQuiescenceScope,
      ],
      [OWNED_PROCESS_PROOF_STRENGTH, OWNED_PROCESS_PROOF_STRENGTHS, isOwnedProcessProofStrength],
      [OWNED_PROCESS_QUIESCENCE_MODE, OWNED_PROCESS_QUIESCENCE_MODES, isOwnedProcessQuiescenceMode],
      [OWNED_SUPERVISOR_PHASE, OWNED_SUPERVISOR_PHASES, isOwnedSupervisorPhase],
      [
        OWNED_SUPERVISOR_TERMINAL_PHASE,
        OWNED_SUPERVISOR_TERMINAL_PHASES,
        isOwnedSupervisorTerminalPhase,
      ],
      [
        OWNED_SUPERVISOR_RECEIPT_PHASE,
        OWNED_SUPERVISOR_RECEIPT_PHASES,
        isOwnedSupervisorReceiptPhase,
      ],
      [OWNED_SUPERVISOR_RECEIPT_KEY, OWNED_SUPERVISOR_RECEIPT_KEYS, isOwnedSupervisorReceiptKey],
      [OWNED_CLI_IDENTITY_STATE, OWNED_CLI_IDENTITY_STATES, isOwnedCliIdentityState],
      [OWNED_PROCESS_PRESENCE_KIND, OWNED_PROCESS_PRESENCE_KINDS, isOwnedProcessPresenceKind],
      [OWNED_SUPERVISOR_OUTCOME_KIND, OWNED_SUPERVISOR_OUTCOME_KINDS, isOwnedSupervisorOutcomeKind],
      [
        OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE,
        OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES,
        isOwnedProcessIgnorableStreamErrorCode,
      ],
      [OWNED_PROCESS_TERMINAL_KIND, OWNED_PROCESS_TERMINAL_KINDS, isOwnedProcessTerminalKind],
    ] as const;
    for (const [contract, values, guard] of vocabularies) {
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(values)).toBe(true);
      expect(JSON.stringify(values)).toBe(JSON.stringify(Object.values(contract)));
      expect(valuesAreUnique(values)).toBe(true);
      expect(values.every((value) => guard(value))).toBe(true);
      expect(guard(Symbol("untrusted"))).toBe(false);
    }
    expect(Object.isFrozen(OWNED_SUPERVISOR_STATUS_KEY)).toBe(true);
  });

  test("receipt reader validates untrusted fields with deterministic invalid-to-valid cases", () => {
    const cliKey = OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID;
    const validCliReceipt = {
      [cliKey]: 42,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]: CLI_IDENTITY,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]: OWNED_CLI_IDENTITY_STATE.AVAILABLE,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]: 41,
    };
    const validSupervisorReceipt = {
      [OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID]: 40,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT]:
        OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    };
    const cases = [
      { key: cliKey, invalid: null, valid: validCliReceipt },
      { key: cliKey, invalid: [], valid: validCliReceipt },
      { key: cliKey, invalid: "not-an-object", valid: validCliReceipt },
      { key: cliKey, invalid: { [cliKey]: 0 }, valid: validCliReceipt },
      {
        key: cliKey,
        invalid: { [cliKey]: 42, [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]: 1 },
        valid: validCliReceipt,
      },
      {
        key: cliKey,
        invalid: {
          [cliKey]: 42,
          [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]: "forged",
        },
        valid: validCliReceipt,
      },
      {
        key: cliKey,
        invalid: { [cliKey]: 42, [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]: -1 },
        valid: validCliReceipt,
      },
      {
        key: cliKey,
        invalid: { ...validCliReceipt, unexpected_field: true },
        valid: validCliReceipt,
      },
      {
        key: OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
        invalid: {
          [OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID]: 40,
          [OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT]: "forged",
        },
        valid: validSupervisorReceipt,
      },
      {
        key: OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
        invalid: { ...validSupervisorReceipt, unexpected_field: true },
        valid: validSupervisorReceipt,
      },
    ] as const;

    for (const receiptCase of cases) {
      let now = 0;
      let readIndex = 0;
      const readings: readonly unknown[] = [receiptCase.invalid, receiptCase.valid];
      const runtime = {
        now: () => {
          const observed = now;
          now += OWNED_PROCESS_TIMING_MS.SUPERVISOR_STATUS_POLL;
          return observed;
        },
        readFileSync: (() => {
          const reading = readings[Math.min(readIndex, readings.length - 1)];
          readIndex++;
          return JSON.stringify(reading);
        }) as unknown as typeof readFileSync,
      };
      const observed =
        receiptCase.key === OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID
          ? waitForOwnedSupervisorReceipt(
              "receipt.json",
              OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
              runtime,
            )
          : waitForOwnedSupervisorReceipt(
              "receipt.json",
              OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID,
              runtime,
            );
      expect(JSON.stringify(observed)).toBe(JSON.stringify(receiptCase.valid));
      expect(readIndex).toBe(2);
    }
  });

  test("supervisor script serializes every live frozen contract object exactly", () => {
    const inlinedContracts = [
      ["PHASE", OWNED_SUPERVISOR_PHASE],
      ["RECEIPT_PHASE", OWNED_SUPERVISOR_RECEIPT_PHASE],
      ["RECEIPT_KEY", OWNED_SUPERVISOR_RECEIPT_KEY],
      ["STATUS_KEY", OWNED_SUPERVISOR_STATUS_KEY],
      ["IDENTITY_STATE", OWNED_CLI_IDENTITY_STATE],
      ["IDENTITY", PROCESS_START_IDENTITY_CONTRACT],
      ["ENV", OWNED_PROCESS_ENV],
      ["EXIT_CODE", OWNED_PROCESS_EXIT_CODE],
      ["IGNORABLE_STREAM_ERROR_CODE", OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE],
      ["TIMING_MS", OWNED_PROCESS_TIMING_MS],
      ["WINDOWS_QUERY_STATUS", OWNED_WINDOWS_QUERY_STATUS],
      ["WINDOWS_JOB", OWNED_WINDOWS_JOB],
      ["WINDOWS_LIMIT", OWNED_WINDOWS_LIMIT],
      ["QUIESCENCE_SCOPE", OWNED_PROCESS_QUIESCENCE_SCOPE],
    ] as const;
    const scriptLines = new Set(OWNED_SUPERVISOR_SCRIPT.split("\n"));
    const inlinedBindings = [...scriptLines]
      .flatMap((line) => /^const ([A-Z][A-Z_]*) = \{/.exec(line)?.[1] ?? [])
      .sort();
    expect(inlinedBindings).toEqual(inlinedContracts.map(([binding]) => binding).sort());
    for (const [binding, contract] of inlinedContracts) {
      expect(Object.isFrozen(contract)).toBe(true);
      expect(scriptLines.has(`const ${binding} = ${JSON.stringify(contract)};`)).toBe(true);
    }
  });

  test("launch and status consumers use the canonical receipt/status/error vocabulary", () => {
    expect(
      ignorableOwnedStdinError({ code: OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE.BROKEN_PIPE }),
    ).toBe(true);
    expect(
      ignorableOwnedStdinError({
        code: OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE.STREAM_DESTROYED,
      }),
    ).toBe(true);
    expect(ignorableOwnedStdinError({ code: "ENOENT" })).toBe(false);
    const consumers = [
      "src/dispatch/owned-process-launch-receipt.ts",
      "src/dispatch/owned-process-launch.ts",
      "src/dispatch/owned-process-status.ts",
    ];
    const literals = [
      ...Object.values(OWNED_SUPERVISOR_RECEIPT_KEY),
      ...Object.values(OWNED_SUPERVISOR_STATUS_KEY),
      ...Object.values(OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE),
    ];
    const duplicates: string[] = [];
    for (const consumer of consumers) {
      const source = readFileSync(resolve(consumer), "utf8");
      for (const literal of literals) {
        if (source.includes(JSON.stringify(literal))) duplicates.push(`${consumer} -> ${literal}`);
      }
    }
    expect(duplicates).toEqual([]);
    expect(readFileSync(resolve("src/dispatch/owned-process-status.ts"), "utf8")).not.toContain(
      "UNPROVEN_SUPERVISOR_EXIT_CODE",
    );
  });

  test("record persistence rejects a canonical value beyond the contract byte limit", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-owned-record-boundary-"));
    const attemptId = "oversized-owned-record";
    try {
      const store = new OwnedProcessRecordStore(root);
      const timestamp = "2026-08-26T00:00:00.000Z";
      const oversized = buildOwnedProcessRecord({
        schema_version: OWNED_PROCESS_SCHEMA_VERSION,
        attempt_id: attemptId,
        engine: "codex",
        host: "x".repeat(OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES),
        platform: process.platform,
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        quiescence_scope: OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
        proof_strength: OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE,
        owner_pid: process.pid,
        owner_identity: "freebsd:oversized-record-owner",
        supervisor_pid: null,
        supervisor_identity: null,
        cli_pid: null,
        cli_identity: null,
        terminal_kind: null,
        state: OWNED_PROCESS_STATE.RESERVED,
        release_reason: null,
        exit_code: null,
        process_quiescent: false,
        prior_record_digest: null,
        recorded_at: timestamp,
        updated_at: timestamp,
      });
      expect(canonicalJsonBytes(oversized).length).toBeGreaterThan(
        OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES,
      );
      expect(() => store.write(attemptId, null, oversized)).toThrow(/CAS value exceeds byte limit/);
      expect(store.read(attemptId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

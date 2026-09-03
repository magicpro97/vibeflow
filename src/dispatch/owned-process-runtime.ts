import {
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_SEGMENT,
  formatProcessStartIdentity,
} from "../durability/process-identity-contract.js";
import {
  OWNED_PROCESS_AUTHORITY_ERROR,
  OWNED_PROCESS_AUTHORITY_OPERATION,
  type OwnedProcessAuthorityOperation,
} from "./owned-process-authority-contract.js";
import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_QUIESCENCE_MODE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TIMING_MS,
  type OwnedCliIdentityState,
  type OwnedProcessQuiescenceScope,
  type OwnedProcessTerminalKind,
  isOwnedCliIdentityClaim,
} from "./owned-process-contract.js";
import {
  type OwnedProcessPlatform,
  type OwnedProcessQuiescenceHint,
  probeProcess,
} from "./owned-process-platform.js";
import { reapOwnedProcessRecord, reapOwnedProcessRecordSync } from "./owned-process-reaper.js";
import {
  type OwnedAttemptProcessRecordV1,
  type OwnedProcessRecordStore,
  type OwnedProcessReleaseProof,
  type OwnedProcessState,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
  ownedProcessPreimage,
  ownedProcessTimestamp,
} from "./owned-process-record.js";
import {
  createOwnedProcessReleaseProof,
  verifyOwnedProcessReleaseProof,
} from "./owned-process-release-proof.js";

export { verifyOwnedProcessReleaseProof } from "./owned-process-release-proof.js";
export {
  OwnedProcessRecordStore,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
} from "./owned-process-record.js";
export type {
  OwnedAttemptProcessRecordV1,
  OwnedProcessReleaseProof,
  OwnedProcessState,
} from "./owned-process-record.js";

const IDENTITY_SETTLE_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function transitionError(
  operation: OwnedProcessAuthorityOperation,
  state: OwnedProcessState,
): Error {
  return new Error(
    `${OWNED_PROCESS_AUTHORITY_ERROR.ILLEGAL_TRANSITION}: ${operation} from ${state}`,
  );
}

function bindingConflict(operation: OwnedProcessAuthorityOperation): Error {
  return new Error(`${OWNED_PROCESS_AUTHORITY_ERROR.BINDING_CONFLICT}: ${operation}`);
}

function releaseProofForRecord(
  released: OwnedAttemptProcessRecordV1,
): OwnedProcessReleaseProof | null {
  const runtimeRecordDigest = released[OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST];
  if (
    released[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RELEASED ||
    runtimeRecordDigest === null
  ) {
    return null;
  }
  const proof = createOwnedProcessReleaseProof({
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROCESS_QUIESCENT]: true,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.STRATEGY]: released[OWNED_PROCESS_RECORD_FIELD.STRATEGY],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE]:
      released[OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH]:
      released[OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST]: runtimeRecordDigest,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_RECORD_DIGEST]:
      released[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.TERMINAL_KIND]:
      released[OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.EXIT_CODE]: released[OWNED_PROCESS_RECORD_FIELD.EXIT_CODE],
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_AT]:
      released[OWNED_PROCESS_RECORD_FIELD.UPDATED_AT],
  });
  if (!verifyOwnedProcessReleaseProof(proof, released)) {
    throw new Error(OWNED_PROCESS_AUTHORITY_ERROR.RELEASE_PROOF_INVALID);
  }
  return proof;
}

function settleProcessPresence(platform: OwnedProcessPlatform, pid: number) {
  let presence = probeProcess(platform, pid);
  for (
    let attempt = 1;
    presence.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN &&
    attempt < OWNED_PROCESS_LIMIT.IDENTITY_SETTLE_ATTEMPTS;
    attempt++
  ) {
    Atomics.wait(IDENTITY_SETTLE_SIGNAL, 0, 0, OWNED_PROCESS_TIMING_MS.IDENTITY_SETTLE_POLL);
    presence = probeProcess(platform, pid);
  }
  return presence;
}

export class OwnedProcessController {
  private termination?: Promise<void>;
  private readonly quiescenceHint: OwnedProcessQuiescenceHint = {};
  private record: OwnedAttemptProcessRecordV1;

  constructor(
    private readonly store: OwnedProcessRecordStore,
    private readonly platform: OwnedProcessPlatform,
    reserved: OwnedAttemptProcessRecordV1,
  ) {
    this.record = reserved;
  }

  assertSupervisorContainment(containment: OwnedProcessQuiescenceScope): void {
    if (
      this.record[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RESERVED ||
      containment !== this.record[OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]
    )
      throw new Error("owned supervisor containment receipt changed");
  }

  bindSupervisor(supervisorPid: number): OwnedAttemptProcessRecordV1 {
    const operation = OWNED_PROCESS_AUTHORITY_OPERATION.BIND_SUPERVISOR;
    if (this.record[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RESERVED) {
      throw transitionError(operation, this.record[OWNED_PROCESS_RECORD_FIELD.STATE]);
    }
    const supervisor = this.platform.observe(supervisorPid);
    if (!supervisor) throw new Error("owned supervisor identity is unavailable");
    if (
      this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      supervisor.pgid !== supervisor.pid
    ) {
      throw new Error("owned supervisor is not the process-group root");
    }
    const boundPid = this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID];
    const boundIdentity = this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY];
    if (boundPid !== null || boundIdentity !== null) {
      if (boundPid === supervisor.pid && boundIdentity === supervisor.identity) return this.record;
      throw bindingConflict(operation);
    }
    return this.replace({
      ...ownedProcessPreimage(this.record),
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: supervisor.pid,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: supervisor.identity,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: ownedProcessTimestamp(),
    });
  }

  bindLaunch(
    supervisorPid: number,
    cliPid: number,
    cliReceipt: {
      identity?: string | null;
      identityState?: OwnedCliIdentityState;
      pgid?: number | null;
    } = {},
  ): OwnedAttemptProcessRecordV1 {
    const operation = OWNED_PROCESS_AUTHORITY_OPERATION.BIND_LAUNCH;
    const state = this.record[OWNED_PROCESS_RECORD_FIELD.STATE];
    if (state !== OWNED_PROCESS_STATE.RESERVED && state !== OWNED_PROCESS_STATE.RUNNING) {
      throw transitionError(operation, state);
    }
    if (
      (cliReceipt.identity !== undefined || cliReceipt.identityState !== undefined) &&
      !isOwnedCliIdentityClaim(cliReceipt.identity, cliReceipt.identityState)
    ) {
      throw new Error("owned CLI receipt identity claim is invalid");
    }
    const supervisor = this.platform.observe(supervisorPid);
    const cliPresence = settleProcessPresence(this.platform, cliPid);
    if (cliPresence.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN) {
      throw new Error("owned CLI identity is unavailable");
    }
    const cli =
      cliPresence.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ? cliPresence.observation : null;
    const cliPgid =
      cli?.pgid ??
      cliReceipt.pgid ??
      (this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION
        ? (supervisor?.pgid ?? null)
        : null);
    const cliIdentity =
      cli?.identity ??
      cliReceipt.identity ??
      (this.platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE &&
      cliPresence.kind === OWNED_PROCESS_PRESENCE_KIND.ABSENT &&
      cliReceipt.identityState === OWNED_CLI_IDENTITY_STATE.ABSENT_AFTER_PROBE &&
      supervisor
        ? formatProcessStartIdentity(
            PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
            supervisor.identity,
            PROCESS_START_IDENTITY_SEGMENT.PID,
            cliPid,
          )
        : null) ??
      (this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION && cliPgid !== null
        ? formatProcessStartIdentity(
            PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
            cliPgid,
            PROCESS_START_IDENTITY_SEGMENT.PID,
            cliPid,
          )
        : null);
    if (!supervisor || !cliIdentity) throw new Error("owned process identity is unavailable");
    if (
      this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      supervisor.pgid !== supervisor.pid
    ) {
      throw new Error("owned supervisor is not the process-group root");
    }
    if (
      this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      cliPgid !== supervisor.pgid
    ) {
      throw new Error("owned CLI escaped the supervisor process group");
    }
    const bindingMatches =
      this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID] === supervisor.pid &&
      this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY] === supervisor.identity &&
      this.record[OWNED_PROCESS_RECORD_FIELD.CLI_PID] === cliPid &&
      this.record[OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY] === cliIdentity;
    if (state === OWNED_PROCESS_STATE.RUNNING) {
      if (bindingMatches) return this.record;
      throw bindingConflict(operation);
    }
    const boundSupervisorPid = this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID];
    const boundSupervisorIdentity = this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY];
    if (
      (boundSupervisorPid !== null || boundSupervisorIdentity !== null) &&
      (boundSupervisorPid !== supervisor.pid || boundSupervisorIdentity !== supervisor.identity)
    ) {
      throw bindingConflict(operation);
    }
    return this.replace({
      ...ownedProcessPreimage(this.record),
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: supervisor.pid,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: supervisor.identity,
      [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: cliPid,
      [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: cliIdentity,
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RUNNING,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: ownedProcessTimestamp(),
    });
  }

  noteTerminal(kind: OwnedProcessTerminalKind): void {
    const operation = OWNED_PROCESS_AUTHORITY_OPERATION.NOTE_TERMINAL;
    if (this.record[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RUNNING) {
      throw transitionError(operation, this.record[OWNED_PROCESS_RECORD_FIELD.STATE]);
    }
    const terminalKind = this.record[OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND];
    if (terminalKind !== null) {
      if (terminalKind === kind) return;
      throw bindingConflict(operation);
    }
    this.replace({
      ...ownedProcessPreimage(this.record),
      [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: kind,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: ownedProcessTimestamp(),
    });
  }

  async terminate(graceMs: number): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = (async () => {
      await reapOwnedProcessRecord(
        this.platform,
        this.record,
        graceMs,
        OWNED_PROCESS_QUIESCENCE_MODE.ACTIVE,
        this.quiescenceHint,
      );
    })();
    return this.termination;
  }

  failLaunch(supervisorPid: number | undefined, cliPid: number | undefined, reason: string): void {
    const operation = OWNED_PROCESS_AUTHORITY_OPERATION.FAIL_LAUNCH;
    const state = this.record[OWNED_PROCESS_RECORD_FIELD.STATE];
    if (state !== OWNED_PROCESS_STATE.RESERVED && state !== OWNED_PROCESS_STATE.RUNNING) {
      throw transitionError(operation, state);
    }
    let releaseReason = reason;
    const supervisor = supervisorPid ? this.platform.observe(supervisorPid) : null;
    const cli = cliPid ? this.platform.observe(cliPid) : null;
    const failedRecord = buildOwnedProcessRecord({
      ...ownedProcessPreimage(this.record),
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]:
        supervisor?.pid ?? supervisorPid ?? this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID],
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]:
        supervisor?.identity ?? this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY],
      [OWNED_PROCESS_RECORD_FIELD.CLI_PID]:
        cli?.pid ?? cliPid ?? this.record[OWNED_PROCESS_RECORD_FIELD.CLI_PID],
      [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]:
        cli?.identity ?? this.record[OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY],
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: this.record[OWNED_PROCESS_RECORD_FIELD.UPDATED_AT],
    });
    if (
      failedRecord[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID] ||
      failedRecord[OWNED_PROCESS_RECORD_FIELD.CLI_PID]
    ) {
      try {
        reapOwnedProcessRecordSync(
          this.platform,
          failedRecord,
          OWNED_PROCESS_TIMING_MS.RECOVERY_GRACE,
          OWNED_PROCESS_QUIESCENCE_MODE.RECOVERY,
          this.quiescenceHint,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        releaseReason = `${reason}; owned cleanup failed${code ? ` (${code})` : ""}`;
      }
    }
    this.replace({
      ...ownedProcessPreimage(failedRecord),
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.UNCERTAIN,
      [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: releaseReason,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: ownedProcessTimestamp(),
    });
  }

  finalize(exitCode: number | null, releaseReason: string): OwnedProcessReleaseProof | null {
    if (this.record[OWNED_PROCESS_RECORD_FIELD.STATE] === OWNED_PROCESS_STATE.RELEASED) {
      return releaseProofForRecord(this.record);
    }
    if (this.record[OWNED_PROCESS_RECORD_FIELD.STATE] === OWNED_PROCESS_STATE.UNCERTAIN)
      return null;
    if (this.record[OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID])
      this.quiescenceHint.supervisor_exit_observed = true;
    const quiescent = this.platform.proveQuiescent(
      this.record,
      OWNED_PROCESS_QUIESCENCE_MODE.ACTIVE,
      this.quiescenceHint,
    );
    if (quiescent !== true) {
      this.replace({
        ...ownedProcessPreimage(this.record),
        [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.UNCERTAIN,
        [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: releaseReason,
        [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: exitCode,
        [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: ownedProcessTimestamp(),
      });
      return null;
    }
    const runtimeRecordDigest = this.record[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST];
    const releasedAt = ownedProcessTimestamp();
    const next = this.replace({
      ...ownedProcessPreimage(this.record),
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RELEASED,
      [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: releaseReason,
      [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: exitCode,
      [OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT]: true,
      [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: runtimeRecordDigest,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: releasedAt,
    });
    return releaseProofForRecord(next);
  }

  private replace(
    next: Omit<OwnedAttemptProcessRecordV1, typeof OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST>,
  ): OwnedAttemptProcessRecordV1 {
    const built = buildOwnedProcessRecord(next);
    this.store.write(this.record[OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID], this.record, built);
    this.record = built;
    return built;
  }
}

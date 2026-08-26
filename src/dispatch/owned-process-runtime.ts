import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_PROCESS_IDENTITY_PREFIX,
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_QUIESCENCE_MODE,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TIMING_MS,
  type OwnedProcessTerminalKind,
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

  bindSupervisor(supervisorPid: number): OwnedAttemptProcessRecordV1 {
    const supervisor = this.platform.observe(supervisorPid);
    if (!supervisor) throw new Error("owned supervisor identity is unavailable");
    if (
      this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      supervisor.pgid !== supervisor.pid
    ) {
      throw new Error("owned supervisor is not the process-group root");
    }
    return this.replace({
      ...ownedProcessPreimage(this.record),
      supervisor_pid: supervisor.pid,
      supervisor_identity: supervisor.identity,
      updated_at: ownedProcessTimestamp(),
    });
  }

  bindLaunch(
    supervisorPid: number,
    cliPid: number,
    cliReceipt: {
      identity?: string | null;
      identityState?: (typeof OWNED_CLI_IDENTITY_STATE)[keyof typeof OWNED_CLI_IDENTITY_STATE];
      pgid?: number | null;
    } = {},
  ): OwnedAttemptProcessRecordV1 {
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
        ? `${OWNED_PROCESS_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT}:${supervisor.identity}:pid:${cliPid}`
        : null) ??
      (this.platform.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION && cliPgid !== null
        ? `posix-pgid:${cliPgid}:pid:${cliPid}`
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
    return this.replace({
      ...ownedProcessPreimage(this.record),
      supervisor_pid: supervisor.pid,
      supervisor_identity: supervisor.identity,
      cli_pid: cliPid,
      cli_identity: cliIdentity,
      state: OWNED_PROCESS_STATE.RUNNING,
      updated_at: ownedProcessTimestamp(),
    });
  }

  noteTerminal(kind: OwnedProcessTerminalKind): void {
    if (this.record.terminal_kind || this.record.state === OWNED_PROCESS_STATE.RELEASED) return;
    this.replace({
      ...ownedProcessPreimage(this.record),
      terminal_kind: kind,
      updated_at: ownedProcessTimestamp(),
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
    let releaseReason = reason;
    const supervisor = supervisorPid ? this.platform.observe(supervisorPid) : null;
    const cli = cliPid ? this.platform.observe(cliPid) : null;
    const failedRecord = buildOwnedProcessRecord({
      ...ownedProcessPreimage(this.record),
      supervisor_pid: supervisor?.pid ?? supervisorPid ?? this.record.supervisor_pid,
      supervisor_identity: supervisor?.identity ?? this.record.supervisor_identity,
      cli_pid: cli?.pid ?? cliPid ?? this.record.cli_pid,
      cli_identity: cli?.identity ?? this.record.cli_identity,
      updated_at: this.record.updated_at,
    });
    if (failedRecord.supervisor_pid || failedRecord.cli_pid) {
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
      state: OWNED_PROCESS_STATE.UNCERTAIN,
      release_reason: releaseReason,
      updated_at: ownedProcessTimestamp(),
    });
  }

  finalize(exitCode: number | null, releaseReason: string): OwnedProcessReleaseProof | null {
    if (this.record.state === OWNED_PROCESS_STATE.UNCERTAIN) return null;
    if (this.record.supervisor_pid) this.quiescenceHint.supervisor_exit_observed = true;
    const quiescent = this.platform.proveQuiescent(
      this.record,
      OWNED_PROCESS_QUIESCENCE_MODE.ACTIVE,
      this.quiescenceHint,
    );
    if (quiescent !== true) {
      this.replace({
        ...ownedProcessPreimage(this.record),
        state: OWNED_PROCESS_STATE.UNCERTAIN,
        release_reason: releaseReason,
        exit_code: exitCode,
        updated_at: ownedProcessTimestamp(),
      });
      return null;
    }
    const runtimeRecordDigest = this.record.record_digest;
    const releasedAt = ownedProcessTimestamp();
    const next = this.replace({
      ...ownedProcessPreimage(this.record),
      state: OWNED_PROCESS_STATE.RELEASED,
      release_reason: releaseReason,
      exit_code: exitCode,
      process_quiescent: true,
      prior_record_digest: runtimeRecordDigest,
      updated_at: releasedAt,
    });
    const proofPreimage: Omit<OwnedProcessReleaseProof, "release_verifier"> = {
      process_quiescent: true,
      strategy: next.strategy,
      quiescence_scope: next.quiescence_scope,
      proof_strength: next.proof_strength,
      runtime_record_digest: runtimeRecordDigest,
      released_record_digest: next.record_digest,
      terminal_kind: next.terminal_kind,
      exit_code: next.exit_code,
      released_at: releasedAt,
    };
    const proof = createOwnedProcessReleaseProof(proofPreimage);
    if (!verifyOwnedProcessReleaseProof(proof, next)) {
      throw new Error("owned process release proof failed self-verification");
    }
    return proof;
  }

  private replace(
    next: Omit<OwnedAttemptProcessRecordV1, "record_digest">,
  ): OwnedAttemptProcessRecordV1 {
    const built = buildOwnedProcessRecord(next);
    this.store.write(this.record.attempt_id, this.record, built);
    this.record = built;
    return built;
  }
}

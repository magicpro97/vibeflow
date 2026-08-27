import { join } from "node:path";
import { ACTION_AUTHORITY_REPAIR_DOMAIN as D } from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_SCOPE } from "../../actions/public-action-vocabulary-contract.js";
import {
  CAPABILITY_SCOPE,
  CAPABILITY_SCOPES,
  type CapabilityScope,
} from "../../core/capability-contract.js";
import { digestHex, privateFileBytes } from "../../durability/index.js";
import { OrdinaryAuthorityJournalStoreV1 } from "../authority-mutation/journal-store.js";
import { readActivatedCapabilityIdentityV1 } from "../runtime-authority.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { compareAndSwapPortableBytes, readPortableBytes } from "../storage/portable-cas.js";
import {
  type CapabilityAuthorityActivationLockV1,
  type CapabilityScopeLockV1,
  acquireCapabilityAuthorityLock,
  acquireCapabilityScopeLock,
} from "../storage/scope-lock.js";
import { CapabilityStorageV1 } from "../storage/store.js";
import { materializeAuthorityRepairedEpochTransition } from "./authority-epoch-transition.js";
import { materializeCapabilityLockRepairCandidateV1 } from "./capability-lock-candidate.js";
import {
  assertCapabilityLockRepairCurrentAuthorityV1,
  capabilityLockRepairControlBaseV1,
  classifyCapabilityLockRepairControlV1,
} from "./capability-lock-control.js";
import { assertCapabilityLockRepairDescendantV1 } from "./capability-lock-descendant.js";
import {
  persistCapabilityLockRepairObservationV1,
  authorityRepairRawSha256 as sha256,
  singleReconciliationClaim,
} from "./capability-lock-observation.js";
import {
  inspectCapabilityLockRepairSourceV1,
  readSelectedCapabilityLockPublicationV1,
} from "./capability-lock-source.js";
import { AUTHORITY_REPAIR_EVENT_STATE, AUTHORITY_REPAIR_LIMIT } from "./contract.js";
import type {
  AuthorityRepairExecutionContextV1,
  AuthorityRepairExecutionObservationV1,
} from "./executor.js";
import type {
  AuthorityRepairDomainBackendV1,
  AuthorityRepairPreparedCandidateV1,
} from "./production-registry.js";
import {
  AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION as A,
  type AuthorityRepairReconciliationPredicateV1,
  type AuthorityRepairReconciliationRowV1,
  AUTHORITY_REPAIR_RECONCILIATION_PREDICATE as P,
} from "./reconciliation.js";
import { AuthorityRepairArtifactStoreV1 } from "./repair-artifact-store.js";
import type { AuthorityRepairActionObjectClosureV1, AuthorityRepairOperationV1 } from "./types.js";

interface ActiveLocksV1 {
  paths: CapabilityStorePathsV1;
  scope: CapabilityScopeLockV1;
  authority: CapabilityAuthorityActivationLockV1;
}

export type CapabilityLockAuthorityRepairBackendOptionsV1 = Readonly<
  Record<CapabilityScope, CapabilityStorePathsV1>
> & {
  transition_resolver: DurableAuthorityTransitionResolverV1;
  now: () => string;
};

export class CapabilityLockAuthorityRepairBackendV1 implements AuthorityRepairDomainBackendV1 {
  readonly domain = D.CAPABILITY_LOCK;
  readonly #paths: Readonly<Record<CapabilityScope, CapabilityStorePathsV1>>;
  #active: ActiveLocksV1 | null = null;

  constructor(readonly options: CapabilityLockAuthorityRepairBackendOptionsV1) {
    this.#paths = Object.freeze({
      [CAPABILITY_SCOPE.PROJECT]: options[CAPABILITY_SCOPE.PROJECT],
      [CAPABILITY_SCOPE.USER]: options[CAPABILITY_SCOPE.USER],
    });
  }

  inspect(): readonly AuthorityRepairPreparedCandidateV1[] {
    const output: AuthorityRepairPreparedCandidateV1[] = [];
    for (const scope of CAPABILITY_SCOPES) {
      try {
        const source = inspectCapabilityLockRepairSourceV1({
          paths: this.#paths[scope],
          transition_resolver: this.options.transition_resolver,
          now: this.options.now,
        });
        if (source)
          output.push(materializeCapabilityLockRepairCandidateV1(source, this.options.now));
      } catch {
        // One invalid owner remains fenced and cannot suppress a valid candidate for the other owner.
      }
    }
    return output;
  }

  private pathsFor(scope: CapabilityScope, scopeId: string): CapabilityStorePathsV1 {
    const paths = this.#paths[scope];
    if (readActivatedCapabilityIdentityV1(paths).content_digest !== scopeId)
      throw new Error("capability-lock repair selected another owner");
    return paths;
  }

  ownerRoot(input: Parameters<AuthorityRepairDomainBackendV1["ownerRoot"]>[0]): string {
    if (input.domain !== this.domain || input.authority_scope === ACTION_SCOPE.CONVERSATION)
      throw new Error("capability-lock repair owner selector is invalid");
    return this.pathsFor(input.authority_scope, input.scope_id).privateRoot;
  }

  private store(paths: CapabilityStorePathsV1): OrdinaryAuthorityJournalStoreV1 {
    return new OrdinaryAuthorityJournalStoreV1(paths, this.options.transition_resolver);
  }

  assertCurrent(closure: AuthorityRepairActionObjectClosureV1): void {
    if (closure.steps.authority_scope === ACTION_SCOPE.CONVERSATION)
      throw new Error("capability-lock repair scope is invalid");
    assertCapabilityLockRepairCurrentAuthorityV1({
      paths: this.pathsFor(closure.steps.authority_scope, closure.steps.scope_id),
      resolver: this.options.transition_resolver,
      closure,
    });
  }

  withLocks<T>(operation: AuthorityRepairOperationV1, callback: () => T): T {
    if (
      this.#active ||
      operation.domain !== this.domain ||
      operation.authority_scope === ACTION_SCOPE.CONVERSATION
    )
      throw new Error("capability-lock repair lock acquisition is invalid or reentrant");
    const paths = this.pathsFor(operation.authority_scope, operation.scope_id);
    const scope = acquireCapabilityScopeLock(paths, operation.scope_id, operation.operation_id);
    try {
      const authority = acquireCapabilityAuthorityLock(paths, operation.operation_id);
      try {
        this.#active = { paths, scope, authority };
        return callback();
      } finally {
        this.#active = null;
        authority.release();
      }
    } finally {
      scope.release();
    }
  }

  private active(): ActiveLocksV1 {
    this.#active?.scope.assertHeld();
    this.#active?.authority.assertHeld();
    if (!this.#active) throw new Error("capability-lock repair runs outside its fixed locks");
    return this.#active;
  }

  private artifacts(context: AuthorityRepairExecutionContextV1): AuthorityRepairArtifactStoreV1 {
    return new AuthorityRepairArtifactStoreV1(this.active().paths.privateRoot);
  }

  private checkpoint(context: AuthorityRepairExecutionContextV1): Buffer {
    const active = this.active();
    const selected = readSelectedCapabilityLockPublicationV1(
      new CapabilityStorageV1(active.paths, context.operation.scope_id, {
        now: this.options.now,
        authorityTransitionResolver: this.options.transition_resolver,
      }),
      context.operation.scope_id,
      this.options.transition_resolver,
      this.options.now,
    );
    if (
      !selected ||
      selected.checkpoint.content_digest !== context.operation.last_valid_record_digest
    )
      throw new Error("approved capability-lock checkpoint is no longer selected");
    const restore = this.artifacts(context).readRestoreSource(context.closure.steps);
    if (!restore.equals(selected.bytes)) throw new Error("approved restore bytes changed");
    return restore;
  }

  private expectedOld(context: AuthorityRepairExecutionContextV1): Buffer | null {
    const steps = context.closure.steps;
    return steps.target_preimage.presence === "present"
      ? this.artifacts(context).readQuarantine(steps)
      : null;
  }

  private quarantineState(
    context: AuthorityRepairExecutionContextV1,
  ): "missing" | "exact" | "invalid" {
    const steps = context.closure.steps;
    if (steps.target_preimage.presence === "absent") {
      try {
        this.artifacts(context).readAbsenceEvidence(steps);
        return "exact";
      } catch {
        return "invalid";
      }
    }
    const path = join(
      this.artifacts(context).paths.quarantine,
      `${digestHex(steps.target_preimage.quarantine_ref)}.bytes`,
    );
    const bytes = privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES);
    if (!bytes) return "missing";
    return sha256(bytes) === steps.target_preimage.corrupt_bytes_sha256 ? "exact" : "invalid";
  }

  private targetState(context: AuthorityRepairExecutionContextV1): "old" | "restored" | "third" {
    const current = readPortableBytes(this.active().paths.currentLock);
    const old = this.expectedOld(context);
    if ((current === null && old === null) || (current && old && current.equals(old))) return "old";
    const restore = this.checkpoint(context);
    if (current?.equals(restore)) return "restored";
    const storage = new CapabilityStorageV1(this.active().paths, context.operation.scope_id, {
      now: this.options.now,
      authorityTransitionResolver: this.options.transition_resolver,
    });
    const status = storage.readStatus();
    if (
      status.lock &&
      (status.state === "ready" || status.state === "locked") &&
      storage.isHistoryDescendant(status.lock, context.operation.last_valid_record_digest)
    )
      return "restored";
    return "third";
  }

  observe(context: AuthorityRepairExecutionContextV1): AuthorityRepairExecutionObservationV1 {
    const anchor = context.fold.resume_anchor;
    let predicate: AuthorityRepairReconciliationPredicateV1;
    try {
      this.checkpoint(context);
      const quarantine = this.quarantineState(context);
      if (anchor === AUTHORITY_REPAIR_EVENT_STATE.PREPARED) {
        const current = readPortableBytes(this.active().paths.currentLock);
        const preimage = context.closure.steps.target_preimage;
        const exactPreimage =
          preimage.presence === "absent"
            ? current === null
            : current !== null && sha256(current) === preimage.corrupt_bytes_sha256;
        predicate = !exactPreimage
          ? P.PREPARED_PREIMAGE_CHANGED
          : quarantine === "invalid"
            ? preimage.presence === "present"
              ? P.PREPARED_QUARANTINE_PARTIAL
              : P.PREPARED_ABSENCE_MARKER_INVALID
            : P.PREPARED_INPUTS_EXACT;
      } else if (quarantine !== "exact") {
        predicate =
          context.closure.steps.target_preimage.presence === "present"
            ? P.LATER_QUARANTINE_INVALID
            : P.LATER_ABSENCE_MARKER_INVALID;
      } else if (anchor === AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED) {
        predicate =
          this.targetState(context) === "old"
            ? P.PREIMAGE_FSYNCED_REPLACEMENT_READY
            : P.PREIMAGE_FSYNCED_TARGET_CHANGED;
      } else if (anchor === AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS) {
        const target = this.targetState(context);
        predicate =
          target === "old"
            ? P.TARGET_OLD_REPLACEMENT_READY
            : target === "restored"
              ? P.TARGET_EXACT_RESTORED
              : P.TARGET_THIRD_STATE;
      } else {
        const target = this.targetState(context);
        const control = classifyCapabilityLockRepairControlV1({
          paths: this.active().paths,
          resolver: this.options.transition_resolver,
          context,
        });
        predicate =
          target !== "restored"
            ? P.RESTORED_NONCOMPOUND_CLAIM_INVALID
            : control === "base"
              ? P.RESTORED_TARGET_DESCENDANT_BASE_JB
              : control === "event"
                ? P.RESTORED_TARGET_DESCENDANT_BASE_JE
                : control === "head"
                  ? P.RESTORED_TARGET_AND_HEAD_DESCENDANTS
                  : P.RESTORED_NONCOMPOUND_RESIDUAL;
      }
    } catch {
      predicate =
        anchor === AUTHORITY_REPAIR_EVENT_STATE.PREPARED
          ? P.PREPARED_INVALID_CHECKPOINT_UNTOUCHED
          : P.LATER_CHECKPOINT_INVALID;
    }
    return {
      claims: singleReconciliationClaim(predicate),
      observation_digest: persistCapabilityLockRepairObservationV1({
        context,
        paths: this.active().paths,
        scope_lock: this.active().scope,
        artifacts: this.artifacts(context),
      }),
    };
  }

  advance(
    context: AuthorityRepairExecutionContextV1,
    row: AuthorityRepairReconciliationRowV1,
  ): AuthorityRepairExecutionObservationV1 {
    const active = this.active();
    if (
      row.disposition === A.PREIMAGE_FSYNCED &&
      context.closure.steps.target_preimage.presence === "present"
    ) {
      const bytes = readPortableBytes(active.paths.currentLock);
      if (!bytes) throw new Error("approved corrupt capability lock disappeared");
      this.artifacts(context).writeQuarantine(
        active.scope.processLock,
        context.closure.steps,
        bytes,
      );
    } else if (row.disposition === A.RETRY_TARGET_CAS) {
      compareAndSwapPortableBytes(
        active.paths.currentLock,
        this.expectedOld(context),
        this.checkpoint(context),
        active.scope,
      );
    } else if (row.disposition === A.APPEND_AUTHORITY_EVENT) {
      const base = capabilityLockRepairControlBaseV1({
        paths: active.paths,
        resolver: this.options.transition_resolver,
        closure: context.closure,
      });
      const transition = materializeAuthorityRepairedEpochTransition(base, context.operation);
      const store = this.store(active.paths);
      store.checkpointHeld(base, active.authority.processLock);
      store.appendEventHeld(transition.event, active.authority.processLock);
    } else if (row.disposition === A.COMMIT_AUTHORITY_HEAD) {
      const base = capabilityLockRepairControlBaseV1({
        paths: active.paths,
        resolver: this.options.transition_resolver,
        closure: context.closure,
      });
      const transition = materializeAuthorityRepairedEpochTransition(base, context.operation);
      this.store(active.paths).replaceHeadHeld(base, transition.next, active.authority.processLock);
    }
    return this.observe(context);
  }

  assertCommittedTransition(input: {
    operation: AuthorityRepairOperationV1;
    closure: AuthorityRepairActionObjectClosureV1;
  }): void {
    if (input.closure.steps.authority_scope === ACTION_SCOPE.CONVERSATION)
      throw new Error("capability-lock transition has a conversation scope");
    const paths = this.pathsFor(input.closure.steps.authority_scope, input.closure.steps.scope_id);
    const storage = new CapabilityStorageV1(paths, input.operation.scope_id, {
      now: this.options.now,
      authorityTransitionResolver: this.options.transition_resolver,
    });
    assertCapabilityLockRepairDescendantV1({
      paths,
      storage,
      ancestor_digest: input.operation.last_valid_record_digest,
    });
  }
}

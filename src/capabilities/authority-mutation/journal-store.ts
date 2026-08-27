import * as nodePath from "node:path";
import {
  type JsonValue,
  appendVffrFrame,
  atomicCompareAndSwap,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import { compareAndSwapProjectionFile } from "../adapters/filesystem-io.js";
import {
  authorityEpochEventDigest,
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
} from "../source/authority-activation-records.js";
import { validateOperationHeader, validateTerminalReceipt } from "./operation-contracts.js";
import { policySettingsPath } from "./policy.js";
import {
  ORDINARY_AUTHORITY_STORE_LIMIT,
  OrdinaryAuthorityStateStoreV1,
  authorityJournalCommon,
  authorityStoreFail,
  parseCanonicalAuthorityRecord,
  readOptionalAuthorityJournal,
} from "./state-store.js";
import type { AuthorityChangeOperationV1, AuthorityChangeTerminalReceiptV1 } from "./types.js";
import { AUTHORITY_CHANGE_TERMINAL_OUTCOME } from "./types.js";

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class OrdinaryAuthorityJournalStoreV1 extends OrdinaryAuthorityStateStoreV1 {
  writeOperationHeaderHeld(
    header: AuthorityChangeOperationV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): ReturnType<typeof createOrVerifyPrivateFile> {
    validateOperationHeader(header);
    return createOrVerifyPrivateFile(
      this.operationHeaderPath(header.operation_id),
      canonicalJsonBytes(header),
      { lock, maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES },
    );
  }

  readOperationHeader(operationId: string): AuthorityChangeOperationV1 | null {
    const bytes = privateFileBytes(
      this.operationHeaderPath(operationId),
      ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
    );
    if (!bytes) return null;
    return validateOperationHeader(
      parseCanonicalAuthorityRecord(bytes, "authority operation header"),
    );
  }

  readTerminalReceipts(operationId: string): AuthorityChangeTerminalReceiptV1[] {
    const path = this.terminalPath(operationId);
    if (privateFileBytes(path, ORDINARY_AUTHORITY_STORE_LIMIT.JOURNAL_BYTES) === null) return [];
    const rows = readVffrFile(path, {
      domain: "authority-change-terminal",
      sequenceStart: 0,
      initialPreviousDigest: null,
      maxFrames: 2,
      maxPayloadBytes: ORDINARY_AUTHORITY_STORE_LIMIT.FRAME_BYTES,
      maxAggregateBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JOURNAL_BYTES,
      validatePayload: (payload) =>
        validateTerminalReceipt(payload as unknown as AuthorityChangeTerminalReceiptV1),
      computePayloadDigest: (payload) =>
        (payload as unknown as AuthorityChangeTerminalReceiptV1).receipt_digest,
      validateJournalIdentity: (payload) => payload.operation_id === operationId,
    }).map((frame) => frame.payload as unknown as AuthorityChangeTerminalReceiptV1);
    for (const [index, row] of rows.entries()) {
      const previous = rows[index - 1] ?? null;
      if (
        row.sequence !== index ||
        row.previous_receipt_digest !== (previous?.receipt_digest ?? null) ||
        (index === 1 &&
          (previous?.outcome !== AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY ||
            row.outcome !== AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED))
      )
        authorityStoreFail(
          "authority terminal receipt payload chain is not dense or legal",
          "authority.terminal",
        );
    }
    return rows;
  }

  appendTerminalHeld(
    receipt: AuthorityChangeTerminalReceiptV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    validateTerminalReceipt(receipt);
    const rows = this.readTerminalReceipts(receipt.operation_id);
    const existing = rows[receipt.sequence];
    if (existing) {
      if (!exact(existing, receipt))
        authorityStoreFail("authority terminal replay changed", "authority.terminal");
      return;
    }
    if (rows.length !== receipt.sequence)
      authorityStoreFail("authority terminal receipt journal is not dense", "authority.terminal");
    appendVffrFrame(
      this.terminalPath(receipt.operation_id),
      "authority-change-terminal",
      receipt as unknown as JsonValue,
      {
        domain: "authority-change-terminal",
        sequenceStart: 0,
        initialPreviousDigest: null,
        maxFrames: 2,
        maxPayloadBytes: ORDINARY_AUTHORITY_STORE_LIMIT.FRAME_BYTES,
        maxAggregateBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JOURNAL_BYTES,
        validatePayload: (payload) =>
          validateTerminalReceipt(payload as unknown as AuthorityChangeTerminalReceiptV1),
        computePayloadDigest: (payload) =>
          (payload as unknown as AuthorityChangeTerminalReceiptV1).receipt_digest,
        validateJournalIdentity: (payload) => payload.operation_id === receipt.operation_id,
        lock,
      },
    );
  }

  appendGrantHeld(
    frame: GrantFrameV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    this.appendDomainRecord(
      nodePath.join(this.authorityRoot, "grants.frames"),
      "grant-authority",
      frame,
      frame.grant_sequence - 1,
      1,
      validateGrantFrame,
      (row) => row.frame_digest,
      lock,
    );
  }

  appendPolicyHeld(
    frame: PolicyAuthorityFrameV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    this.appendDomainRecord(
      nodePath.join(this.authorityRoot, "policy.frames"),
      "policy-authority",
      frame,
      frame.sequence,
      0,
      validatePolicyFrame,
      (row) => row.frame_digest,
      lock,
    );
  }

  appendSecretHeld(
    frame: SecretRevocationFrameV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    this.appendDomainRecord(
      nodePath.join(this.authorityRoot, "secret-revocations.frames"),
      "secret-revocation",
      frame,
      frame.sequence,
      0,
      validateSecretRevocationFrame,
      (row) => row.frame_digest,
      lock,
    );
  }

  appendTrustHeld(
    frame: RegistryTrustKeyFrameV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    this.appendDomainRecord(
      nodePath.join(this.authorityRoot, "registry-trust.frames"),
      "registry-trust",
      frame,
      frame.trust_epoch - 1,
      1,
      validateTrustFrame,
      (row) => row.frame_digest,
      lock,
    );
  }

  appendEventHeld(
    event: AuthorityEpochEventV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    this.appendDomainRecord(
      nodePath.join(this.authorityRoot, "epoch-events.frames"),
      "authority-epoch",
      event,
      event.authority_epoch - 1,
      1,
      validateAuthorityEvent,
      authorityEpochEventDigest,
      lock,
    );
  }

  checkpointHeld(
    head: AuthorityEpochHeadV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    validateAuthorityHead(head);
    createOrVerifyPrivateFile(
      activationCheckpointPath(this.paths, head.content_digest),
      canonicalJsonBytes(head),
      { lock, maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES },
    );
  }

  replaceHeadHeld(
    expected: AuthorityEpochHeadV1,
    replacement: AuthorityEpochHeadV1,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    validateAuthorityHead(expected);
    validateAuthorityHead(replacement);
    atomicCompareAndSwap(
      activationHeadPath(this.paths),
      canonicalJsonBytes(expected),
      canonicalJsonBytes(replacement),
      { lock, maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES },
    );
  }

  replaceSettings(expected: Uint8Array, replacement: Uint8Array): void {
    compareAndSwapProjectionFile(policySettingsPath(this.paths), expected, replacement, 0o600);
  }

  private appendDomainRecord<T extends object>(
    path: string,
    domain:
      | "grant-authority"
      | "policy-authority"
      | "secret-revocation"
      | "registry-trust"
      | "authority-epoch",
    record: T,
    index: number,
    sequenceStart: number,
    validate: (row: T) => void,
    digest: (row: T) => string,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    validate(record);
    const common = authorityJournalCommon(
      this.paths.scope,
      (record as unknown as { scope_identity_digest: string }).scope_identity_digest,
    );
    const rows = readOptionalAuthorityJournal<T>(path, {
      ...common,
      domain,
      sequenceStart,
      validatePayload: (payload) => validate(payload as unknown as T),
      computePayloadDigest: (payload) => digest(payload as unknown as T),
    });
    const existing = rows[index];
    if (existing) {
      if (!exact(existing, record))
        authorityStoreFail(`${domain} replay changed immutable bytes`, path);
      return;
    }
    if (rows.length !== index) authorityStoreFail(`${domain} journal append is not dense`, path);
    appendVffrFrame(path, domain, record as unknown as JsonValue, {
      ...common,
      domain,
      sequenceStart,
      validatePayload: (payload) => validate(payload as unknown as T),
      computePayloadDigest: (payload) => digest(payload as unknown as T),
      lock,
    });
  }

  private operationHeaderPath(operationId: string): string {
    if (!/^vf-operation-[a-f0-9]{64}$/u.test(operationId))
      return authorityStoreFail("invalid authority operation ID", "authority.operation_id");
    return nodePath.join(this.authorityRoot, "operations", operationId, "header.json");
  }

  private terminalPath(operationId: string): string {
    if (!/^vf-operation-[a-f0-9]{64}$/u.test(operationId))
      return authorityStoreFail("invalid authority operation ID", "authority.operation_id");
    return nodePath.join(this.authorityRoot, "terminal-receipts", `${operationId}.frames`);
  }
}

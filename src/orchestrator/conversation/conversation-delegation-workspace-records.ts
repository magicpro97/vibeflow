import * as fs from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  digestV1,
  ensurePrivateDirectory,
} from "../../durability/index.js";
import { isNativeProcessStartIdentity } from "../../durability/process-identity-contract.js";
import { openPrivateFile, safeEntry, writePrivateAtomic } from "../trace/path-safety.js";
import { conversationDelegationOracleInvocation } from "./conversation-delegation-workspace-contract.js";

export const CONVERSATION_DELEGATION_WORKSPACE_STATE = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  VERIFYING: "verifying",
  PROMOTING: "promoting",
  NEEDS_RECOVERY: "needs-recovery",
  SETTLED: "settled",
} as const);
export type ConversationDelegationWorkspaceStateV1 =
  (typeof CONVERSATION_DELEGATION_WORKSPACE_STATE)[keyof typeof CONVERSATION_DELEGATION_WORKSPACE_STATE];

export const CONVERSATION_DELEGATION_WORKSPACE_LIMIT = Object.freeze({
  RECORD_BYTES: 128 * 1024,
  VERIFICATION_RECORD_BYTES: 512 * 1024,
  LIST_ITEMS: 256,
  TEXT_BYTES: 16 * 1024,
} as const);

export const CONVERSATION_DELEGATION_GIT_HEAD = /^[0-9a-f]{40,64}$/;
export const CONVERSATION_DELEGATION_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const CONVERSATION_DELEGATION_AUTHORITY_ID = /^[0-9a-f]{64}$/;
export const CONVERSATION_DELEGATION_WORKSPACE_ID = /^vf-coordinate-workspace-[0-9a-f]{64}$/;
export const CONVERSATION_DELEGATION_BRANCH_REF = /^refs\/heads\/vf\/coordinate\/[0-9a-f]{24}$/;
export const CONVERSATION_DELEGATION_PRIMARY_REF_PREFIX = "refs/heads/" as const;

export interface ConversationDelegationProcessOwnerV1 {
  pid: number;
  process_start_identity: string;
  authority_id: string;
}

export interface ConversationDelegationWorkspaceRecordV1 {
  schema_version: "1.0";
  workspace_id: string;
  workflow_id: string;
  workspace_key: string;
  workspace_key_digest: string;
  repo_root_digest: string;
  base_head: string;
  primary_ref: string;
  head: string;
  branch_ref: string;
  state: ConversationDelegationWorkspaceStateV1;
  dirty: boolean;
  lease_owner: ConversationDelegationProcessOwnerV1 | null;
  lease_count: number;
  review_owner: ConversationDelegationProcessOwnerV1 | null;
  review_count: number;
  review_head: string | null;
  task_id: string | null;
  task_contract_digest: string | null;
  task_scope: string[];
  task_forbidden: string[];
  task_verify_oracles: string[];
  task_base_head: string | null;
  verified_head: string | null;
  verification_evidence_refs: string[];
  verification_owner: ConversationDelegationProcessOwnerV1 | null;
  verification_attempt_id: string | null;
  verification_changed_paths: string[];
  verification_expected_oracles: string[];
  created_at: string;
  updated_at: string;
  record_digest: string;
}

const fail = (message: string): never => {
  throw new Error(message);
};
const boundedText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= CONVERSATION_DELEGATION_WORKSPACE_LIMIT.TEXT_BYTES &&
  !/[\0\r\n]/u.test(value);
const boundedList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= CONVERSATION_DELEGATION_WORKSPACE_LIMIT.LIST_ITEMS &&
  value.every(boundedText) &&
  new Set(value).size === value.length;
const canonicalPath = (value: string, allowDirectory: boolean): boolean => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const directory = allowDirectory && value.endsWith("/");
  const body = directory ? value.slice(0, -1) : value;
  return (
    body.length > 0 &&
    !body.endsWith("/") &&
    body.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
};
const sorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] as string) < value);
const validPrimaryRef = (value: unknown): value is string => {
  if (
    !boundedText(value) ||
    !value.startsWith(CONVERSATION_DELEGATION_PRIMARY_REF_PREFIX) ||
    value.length > 512
  )
    return false;
  const branch = value.slice(CONVERSATION_DELEGATION_PRIMARY_REF_PREFIX.length);
  return (
    /^[A-Za-z0-9._/-]+$/u.test(branch) &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    branch.split("/").every((part) => part !== ".")
  );
};
const validOwner = (value: unknown): value is ConversationDelegationProcessOwnerV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as ConversationDelegationProcessOwnerV1;
  return (
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    owner.pid <= 2_147_483_647 &&
    isNativeProcessStartIdentity(owner.process_start_identity) &&
    CONVERSATION_DELEGATION_AUTHORITY_ID.test(owner.authority_id)
  );
};

function recordDigest(
  record: Omit<ConversationDelegationWorkspaceRecordV1, "record_digest">,
): string {
  return digestV1("VF-CONVERSATION-COORDINATION-WORKSPACE\0v1\0", record);
}

function validTask(record: ConversationDelegationWorkspaceRecordV1): boolean {
  const absent =
    record.task_id === null &&
    record.task_contract_digest === null &&
    record.task_scope.length === 0 &&
    record.task_forbidden.length === 0 &&
    record.task_verify_oracles.length === 0 &&
    record.task_base_head === null;
  const present =
    boundedText(record.task_id) &&
    typeof record.task_contract_digest === "string" &&
    CONVERSATION_DELEGATION_DIGEST.test(record.task_contract_digest) &&
    record.task_scope.length > 0 &&
    record.task_verify_oracles.length > 0 &&
    typeof record.task_base_head === "string" &&
    CONVERSATION_DELEGATION_GIT_HEAD.test(record.task_base_head);
  return absent || present;
}

function validVerification(record: ConversationDelegationWorkspaceRecordV1): boolean {
  const refsMatch =
    (record.verified_head === null) === (record.verification_evidence_refs.length === 0);
  if (!refsMatch) return false;
  if (record.verified_head !== null && !CONVERSATION_DELEGATION_GIT_HEAD.test(record.verified_head))
    return false;
  const verifying = record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING;
  if (!verifying)
    return (
      record.verification_owner === null &&
      record.verification_attempt_id === null &&
      record.verification_changed_paths.length === 0 &&
      record.verification_expected_oracles.length === 0
    );
  return (
    validOwner(record.verification_owner) &&
    typeof record.verification_attempt_id === "string" &&
    CONVERSATION_DELEGATION_AUTHORITY_ID.test(record.verification_attempt_id) &&
    record.verification_expected_oracles.length > 0 &&
    record.verification_expected_oracles.length === record.task_verify_oracles.length &&
    record.verification_expected_oracles.every(
      (oracle, index) => oracle === record.task_verify_oracles[index],
    )
  );
}

export function assertConversationDelegationWorkspaceRecord(
  value: unknown,
): asserts value is ConversationDelegationWorkspaceRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid workspace record");
  const record = value as ConversationDelegationWorkspaceRecordV1;
  if (
    record.schema_version !== "1.0" ||
    !CONVERSATION_DELEGATION_WORKSPACE_ID.test(record.workspace_id) ||
    !boundedText(record.workflow_id) ||
    !boundedText(record.workspace_key) ||
    !CONVERSATION_DELEGATION_DIGEST.test(record.workspace_key_digest) ||
    !CONVERSATION_DELEGATION_DIGEST.test(record.repo_root_digest) ||
    !CONVERSATION_DELEGATION_GIT_HEAD.test(record.base_head) ||
    !validPrimaryRef(record.primary_ref) ||
    !CONVERSATION_DELEGATION_GIT_HEAD.test(record.head) ||
    !CONVERSATION_DELEGATION_BRANCH_REF.test(record.branch_ref) ||
    !Object.values(CONVERSATION_DELEGATION_WORKSPACE_STATE).includes(record.state) ||
    typeof record.dirty !== "boolean" ||
    !Number.isSafeInteger(record.lease_count) ||
    record.lease_count < 0 ||
    (record.lease_count === 0) !== (record.lease_owner === null) ||
    (record.lease_owner !== null && !validOwner(record.lease_owner)) ||
    !Number.isSafeInteger(record.review_count) ||
    record.review_count < 0 ||
    (record.review_count === 0) !== (record.review_owner === null) ||
    (record.review_owner !== null && !validOwner(record.review_owner)) ||
    (record.review_count === 0) !== (record.review_head === null) ||
    (record.review_head !== null && !CONVERSATION_DELEGATION_GIT_HEAD.test(record.review_head)) ||
    (record.review_head !== null && record.review_head !== record.verified_head) ||
    (record.lease_count > 0 && record.review_count > 0) ||
    !boundedList(record.task_scope) ||
    !record.task_scope.every((path) => canonicalPath(path, true)) ||
    !sorted(record.task_scope) ||
    !boundedList(record.task_forbidden) ||
    !record.task_forbidden.every((path) => canonicalPath(path, true)) ||
    !sorted(record.task_forbidden) ||
    !boundedList(record.task_verify_oracles) ||
    !record.task_verify_oracles.every(
      (oracle) => conversationDelegationOracleInvocation(oracle) !== null,
    ) ||
    !validTask(record) ||
    !boundedList(record.verification_evidence_refs) ||
    !boundedList(record.verification_changed_paths) ||
    !record.verification_changed_paths.every((path) => canonicalPath(path, false)) ||
    !sorted(record.verification_changed_paths) ||
    !boundedList(record.verification_expected_oracles) ||
    !record.verification_expected_oracles.every(
      (oracle) => conversationDelegationOracleInvocation(oracle) !== null,
    ) ||
    !validVerification(record) ||
    (record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING &&
      (record.lease_count > 0 || record.review_count > 0)) ||
    ((record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.PROMOTING ||
      record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.SETTLED) &&
      (record.lease_count > 0 || record.review_count > 0)) ||
    (record.verified_head !== null && record.task_id === null) ||
    Number.isNaN(Date.parse(record.created_at)) ||
    Number.isNaN(Date.parse(record.updated_at))
  )
    fail("invalid workspace record");
  const { record_digest: observed, ...unsigned } = record;
  if (observed !== recordDigest(unsigned)) fail("workspace record digest mismatch");
}

export function materializeConversationDelegationWorkspaceRecord(
  record: Omit<ConversationDelegationWorkspaceRecordV1, "record_digest">,
): ConversationDelegationWorkspaceRecordV1 {
  return Object.freeze({ ...record, record_digest: recordDigest(record) });
}

export class ConversationDelegationWorkspaceRecordStoreV1 {
  private readonly root: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(resolve(artifactRoot), "coordination-workspaces", "v1", "records"),
    );
    this.lockPath = join(this.root, "workspace-authority.lock");
  }

  read(workspaceId: string): ConversationDelegationWorkspaceRecordV1 | null {
    const path = this.path(workspaceId);
    if (!safeEntry(path, fail, "unsafe workspace record")) return null;
    const fd = openPrivateFile(
      path,
      CONVERSATION_DELEGATION_WORKSPACE_LIMIT.RECORD_BYTES,
      fail,
      "unsafe workspace record",
    );
    try {
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      assertConversationDelegationWorkspaceRecord(value);
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  write(
    record:
      | Omit<ConversationDelegationWorkspaceRecordV1, "record_digest">
      | ConversationDelegationWorkspaceRecordV1,
  ): ConversationDelegationWorkspaceRecordV1 {
    const { record_digest: _prior, ...unsigned } =
      record as ConversationDelegationWorkspaceRecordV1;
    const materialized = materializeConversationDelegationWorkspaceRecord(unsigned);
    assertConversationDelegationWorkspaceRecord(materialized);
    writePrivateAtomic(
      this.root,
      this.path(materialized.workspace_id),
      canonicalJsonBytes(materialized),
      CONVERSATION_DELEGATION_WORKSPACE_LIMIT.RECORD_BYTES,
      fail,
    );
    return materialized;
  }

  withLock<T>(run: () => T): T {
    const lock = acquireProcessLock(this.lockPath, {
      operation: "conversation-delegation-workspace",
      coverageRoot: this.root,
      timeoutMs: 5_000,
    });
    try {
      return run();
    } finally {
      lock.release();
    }
  }

  private path(workspaceId: string): string {
    if (!CONVERSATION_DELEGATION_WORKSPACE_ID.test(workspaceId)) fail("invalid workspace identity");
    return join(this.root, `${workspaceId}.json`);
  }
}

import { timingSafeEqual } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionApprovalV1, ActionProposalV1 } from "../../actions/index.js";
import {
  canonicalJsonBytes,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import {
  LINEAGE_MUTATION_RESERVATION_ERROR_NAME,
  LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION,
  LINEAGE_MUTATION_RESERVATION_STATUS,
  type LineageMutationKindV1,
  type LineageMutationReleaseOutcomeV1,
  type LineageMutationReservationSchemaVersionV1,
  type LineageMutationReservationStatusV1,
  isLineageMutationKind,
  isLineageMutationReleaseOutcome,
  isLineageMutationReservationStatus,
} from "./conversation-lineage-mutation-reservation-contract.js";
import { lineageStorageKey } from "./lineage-storage-key.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

export const MAX_LINEAGE_MUTATION_RESERVATION_BYTES = 256 * 1024;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const APPROVAL = /^vf-approval-[0-9a-f]{64}$/;
const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface ConversationLineageMutationSourceV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  lineage_head_digest: string;
  lineage_head_epoch: number;
}

export interface ConversationLineageMutationReservationV1 {
  schema_version: LineageMutationReservationSchemaVersionV1;
  root_session_id: string;
  reservation_epoch: number;
  previous_reservation_digest: string | null;
  status: LineageMutationReservationStatusV1;
  mutation_kind: LineageMutationKindV1;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  operation_id: string;
  source: ConversationLineageMutationSourceV1;
  release_outcome: LineageMutationReleaseOutcomeV1 | null;
  terminal_digest: string | null;
  created_at: string;
  updated_at: string;
  content_digest: string;
}

export class ConversationLineageMutationBusyError extends Error {
  override readonly name = LINEAGE_MUTATION_RESERVATION_ERROR_NAME.BUSY;
}

const sameBytes = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

export function lineageMutationReservationPath(
  artifactRoot: string,
  rootSessionId: string,
): string {
  return join(
    artifactRoot,
    "lineage",
    "v1",
    "mutation-reservations",
    `${digestHex(lineageStorageKey(rootSessionId))}.json`,
  );
}

export function lineageMutationReservationDigest(
  value: Omit<ConversationLineageMutationReservationV1, "content_digest">,
): string {
  return digestV1("VF-CONVERSATION-LINEAGE-MUTATION-RESERVATION\0v1\0", value);
}

export function assertConversationLineageMutationSourceV1(
  value: unknown,
): asserts value is ConversationLineageMutationSourceV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "conversation_id",
      "conversation_lock_digest",
      "last_seq",
      "lineage_head_digest",
      "lineage_head_epoch",
      "revision_id",
      "root_session_id",
    ]) ||
    !isBoundedLineageReference(value.root_session_id) ||
    !isBoundedLineageReference(value.conversation_id) ||
    !isBoundedLineageReference(value.revision_id) ||
    !Number.isSafeInteger(value.last_seq) ||
    (value.last_seq as number) < 0 ||
    !Number.isSafeInteger(value.lineage_head_epoch) ||
    (value.lineage_head_epoch as number) < 0 ||
    !isLineageDigest(value.conversation_lock_digest) ||
    !isLineageDigest(value.lineage_head_digest)
  )
    throw new Error("invalid conversation lineage mutation source");
}

export function assertConversationLineageMutationReservationV1(
  value: unknown,
): asserts value is ConversationLineageMutationReservationV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "approval_digest",
      "approval_id",
      "content_digest",
      "created_at",
      "mutation_kind",
      "operation_id",
      "previous_reservation_digest",
      "proposal_digest",
      "proposal_id",
      "release_outcome",
      "reservation_epoch",
      "root_session_id",
      "schema_version",
      "source",
      "status",
      "terminal_digest",
      "updated_at",
    ]) ||
    value.schema_version !== LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION ||
    !isBoundedLineageReference(value.root_session_id) ||
    !Number.isSafeInteger(value.reservation_epoch) ||
    (value.reservation_epoch as number) < 1 ||
    ((value.reservation_epoch as number) === 1) !== (value.previous_reservation_digest === null) ||
    !isLineageMutationReservationStatus(value.status) ||
    !isLineageMutationKind(value.mutation_kind) ||
    typeof value.proposal_id !== "string" ||
    !PROPOSAL.test(value.proposal_id) ||
    typeof value.approval_id !== "string" ||
    !APPROVAL.test(value.approval_id) ||
    typeof value.operation_id !== "string" ||
    !OPERATION.test(value.operation_id) ||
    ![value.proposal_digest, value.approval_digest, value.content_digest].every(isLineageDigest) ||
    (value.previous_reservation_digest !== null &&
      !isLineageDigest(value.previous_reservation_digest)) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.updated_at) ||
    (value.updated_at as string) < (value.created_at as string) ||
    (value.release_outcome !== null && !isLineageMutationReleaseOutcome(value.release_outcome)) ||
    (value.terminal_digest !== null && !isLineageDigest(value.terminal_digest)) ||
    (value.status === LINEAGE_MUTATION_RESERVATION_STATUS.ACTIVE) !==
      (value.release_outcome === null && value.terminal_digest === null) ||
    (value.status === LINEAGE_MUTATION_RESERVATION_STATUS.RELEASED) !==
      (value.release_outcome !== null && value.terminal_digest !== null)
  )
    throw new Error("invalid conversation lineage mutation reservation");
  assertConversationLineageMutationSourceV1(value.source);
  if (value.source.root_session_id !== value.root_session_id)
    throw new Error("conversation lineage mutation root mismatch");
  const { content_digest: _digest, ...preimage } = value;
  if (
    lineageMutationReservationDigest(
      preimage as unknown as Omit<ConversationLineageMutationReservationV1, "content_digest">,
    ) !== value.content_digest
  )
    throw new Error("conversation lineage mutation reservation digest mismatch");
}

export function readConversationLineageMutationReservation(
  artifactRoot: string,
  rootSessionId: string,
): ConversationLineageMutationReservationV1 | null {
  const bytes = privateFileBytes(
    lineageMutationReservationPath(artifactRoot, rootSessionId),
    MAX_LINEAGE_MUTATION_RESERVATION_BYTES,
  );
  if (bytes === null) return null;
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertConversationLineageMutationReservationV1(value);
  if (!sameBytes(bytes, canonicalJsonBytes(value)))
    throw new Error("conversation lineage mutation reservation is non-canonical");
  if (value.root_session_id !== rootSessionId)
    throw new Error("conversation lineage mutation reservation storage key mismatch");
  return structuredClone(value);
}

export function listActiveConversationLineageMutationReservations(
  artifactRoot: string,
): ConversationLineageMutationReservationV1[] {
  const root = join(artifactRoot, "lineage", "v1", "mutation-reservations");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name))
        throw new Error("invalid conversation lineage mutation reservation entry");
      const bytes = privateFileBytes(
        join(root, entry.name),
        MAX_LINEAGE_MUTATION_RESERVATION_BYTES,
      );
      if (bytes === null) throw new Error("conversation lineage mutation reservation disappeared");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertConversationLineageMutationReservationV1(value);
      if (!sameBytes(bytes, canonicalJsonBytes(value)))
        throw new Error("conversation lineage mutation reservation is non-canonical");
      if (entry.name !== `${digestHex(lineageStorageKey(value.root_session_id))}.json`)
        throw new Error("conversation lineage mutation reservation storage key mismatch");
      return value;
    })
    .filter((value) => value.status === LINEAGE_MUTATION_RESERVATION_STATUS.ACTIVE)
    .sort((left, right) => left.root_session_id.localeCompare(right.root_session_id))
    .map((value) => structuredClone(value));
}

export function sameLineageMutationOwner(
  current: ConversationLineageMutationReservationV1,
  kind: ConversationLineageMutationReservationV1["mutation_kind"],
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  operationId: string,
): boolean {
  return (
    current.mutation_kind === kind &&
    current.proposal_id === proposal.proposal_id &&
    current.proposal_digest === proposal.proposal_digest &&
    current.approval_id === approval.approval_id &&
    current.approval_digest === approval.approval_digest &&
    current.operation_id === operationId
  );
}

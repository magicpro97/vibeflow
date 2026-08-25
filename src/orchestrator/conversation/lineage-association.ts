import type { PublicActor } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import type { ConversationCatalogSourceInventoryEntryV1 } from "./catalog-types.js";
import {
  assertExactAuthorityWrapper,
  assertPublicActorsEqual,
  sameCanonical,
  validateLineageActionClosure,
} from "./lineage-action-authority.js";
import type { LineageHeadRecordV1 } from "./lineage-types.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const ASSOCIATION_ID = /^vf-lineage-association-[0-9a-f]{64}$/;

export interface LineageAssociationRecordV1 {
  schema_version: "1.0";
  association_id: string;
  root_bindings: Array<{ root_session_id: string; expected_head_digest: string }>;
  relation: "user-associated-unverified";
  reason_digest: string;
  proposal_id: string;
  approval_id: string;
  operation_id: string;
  created_by: PublicActor;
  created_at: string;
  content_digest: string;
}

export interface LineageAssociationPlanV1 {
  schema_version: "1.0";
  root_bindings: Array<{
    root_session_id: string;
    expected_head_digest: string;
    expected_head_epoch: number;
  }>;
  relation: "user-associated-unverified";
  reason_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface LineageAssociationFailureV1 {
  record_id: string | null;
  root_session_ids: string[];
}

const compare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

function assertActor(value: unknown): asserts value is PublicActor {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, ["credential_class", "kind", "public_actor_id"]) ||
    !["human-browser", "human-cli", "agent", "system-recovery"].includes(value.kind as string) ||
    !["loopback-session", "interactive-tty", "automation-grant", "recovery"].includes(
      value.credential_class as string,
    ) ||
    !isBoundedLineageReference(value.public_actor_id)
  )
    throw new Error("invalid lineage association actor");
}

function assertRecordBindings(
  value: unknown,
): asserts value is LineageAssociationRecordV1["root_bindings"] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 512)
    throw new Error("invalid lineage association root bindings");
  for (const [index, binding] of value.entries()) {
    if (
      !isPlainLineageRecord(binding) ||
      !hasExactLineageKeys(binding, ["expected_head_digest", "root_session_id"]) ||
      !isBoundedLineageReference(binding.root_session_id) ||
      !isLineageDigest(binding.expected_head_digest) ||
      (index > 0 && compare(value[index - 1]?.root_session_id ?? "", binding.root_session_id) >= 0)
    )
      throw new Error("invalid lineage association root binding");
  }
}

export function assertLineageAssociationRecordV1(
  value: unknown,
): asserts value is LineageAssociationRecordV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "approval_id",
      "association_id",
      "content_digest",
      "created_at",
      "created_by",
      "operation_id",
      "proposal_id",
      "reason_digest",
      "relation",
      "root_bindings",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.association_id !== "string" ||
    !ASSOCIATION_ID.test(value.association_id) ||
    value.relation !== "user-associated-unverified" ||
    !isLineageDigest(value.reason_digest) ||
    !/^vf-proposal-[0-9a-f]{64}$/.test(value.proposal_id as string) ||
    !/^vf-approval-[0-9a-f]{64}$/.test(value.approval_id as string) ||
    !/^vf-operation-[0-9a-f]{64}$/.test(value.operation_id as string) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isLineageDigest(value.content_digest)
  )
    throw new Error("invalid lineage association");
  assertActor(value.created_by);
  assertRecordBindings(value.root_bindings);
  const { association_id: _id, content_digest: _digest, ...preimage } = value;
  const expected = digestV1("VF-LINEAGE-ASSOCIATION\0v1\0", preimage);
  if (
    value.content_digest !== expected ||
    value.association_id !== `vf-lineage-association-${expected.slice(7)}`
  )
    throw new Error("invalid lineage association digest");
}

export function assertLineageAssociationPlanV1(
  value: unknown,
): asserts value is LineageAssociationPlanV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "created_at",
      "expires_at",
      "plan_digest",
      "reason_digest",
      "relation",
      "root_bindings",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    value.relation !== "user-associated-unverified" ||
    !isLineageDigest(value.reason_digest) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.expires_at) ||
    value.expires_at <= value.created_at ||
    !isLineageDigest(value.plan_digest) ||
    !Array.isArray(value.root_bindings) ||
    value.root_bindings.length < 2 ||
    value.root_bindings.length > 512
  )
    throw new Error("invalid lineage association plan");
  for (const [index, binding] of value.root_bindings.entries()) {
    if (
      !isPlainLineageRecord(binding) ||
      !hasExactLineageKeys(binding, [
        "expected_head_digest",
        "expected_head_epoch",
        "root_session_id",
      ]) ||
      !isBoundedLineageReference(binding.root_session_id) ||
      !isLineageDigest(binding.expected_head_digest) ||
      !Number.isSafeInteger(binding.expected_head_epoch) ||
      (binding.expected_head_epoch as number) < 0 ||
      (index > 0 &&
        compare(value.root_bindings[index - 1]?.root_session_id ?? "", binding.root_session_id) >=
          0)
    )
      throw new Error("invalid lineage association plan binding");
  }
  const { plan_digest: _digest, ...preimage } = value;
  if (digestV1("VF-LINEAGE-ASSOCIATION-PLAN\0v1\0", preimage) !== value.plan_digest)
    throw new Error("invalid lineage association plan digest");
}

export function validateLineageAssociationAuthority(
  value: unknown,
  heads: ReadonlyMap<string, LineageHeadRecordV1>,
): LineageAssociationRecordV1 {
  assertExactAuthorityWrapper(value, [
    "action_plan",
    "approval",
    "dispatch",
    "plan",
    "proposal",
    "record",
  ]);
  assertLineageAssociationPlanV1(value.plan);
  assertLineageAssociationRecordV1(value.record);
  const plan = value.plan;
  const record = value.record;
  const closure = validateLineageActionClosure(
    {
      action_plan: value.action_plan,
      proposal: value.proposal,
      approval: value.approval,
      dispatch: value.dispatch,
    },
    plan.plan_digest,
    "lineage-association",
    null,
  );
  const projectedBindings = plan.root_bindings.map(
    ({ expected_head_epoch: _epoch, ...binding }) => binding,
  );
  for (const binding of plan.root_bindings) {
    const head = heads.get(binding.root_session_id);
    if (
      !head ||
      head.content_digest !== binding.expected_head_digest ||
      head.head_epoch !== binding.expected_head_epoch
    )
      throw new Error("lineage association head binding changed");
  }
  const proposal = closure.proposal;
  const approval = closure.approval;
  const dispatch = closure.dispatch;
  const action = proposal.action;
  if (
    !sameCanonical(record.root_bindings, projectedBindings) ||
    record.relation !== plan.relation ||
    record.reason_digest !== plan.reason_digest ||
    record.proposal_id !== proposal.proposal_id ||
    record.approval_id !== approval.approval_id ||
    record.operation_id !== dispatch.operation_id ||
    record.created_at !== approval.decided_at ||
    record.created_at !== dispatch.created_at ||
    proposal.created_at !== plan.created_at ||
    proposal.expires_at !== plan.expires_at ||
    proposal.action_root_locator.kind !== "conversation" ||
    !plan.root_bindings.some(
      (binding) =>
        binding.root_session_id === proposal.base.root_session_id &&
        binding.expected_head_digest === proposal.base.lineage_head_digest &&
        binding.expected_head_epoch === proposal.base.lineage_head_epoch,
    ) ||
    action.type !== "conversation.associate_lineages" ||
    !sameCanonical(
      action.root_session_ids,
      plan.root_bindings.map((binding) => binding.root_session_id),
    ) ||
    action.reason !== action.reason.normalize("NFC") ||
    digestV1("VF-AUDIT-REASON\0v1\0", {
      schema_version: "1.0",
      reason: action.reason,
    }) !== plan.reason_digest
  )
    throw new Error("lineage association action closure mismatch");
  assertPublicActorsEqual(record.created_by, approval.decided_by);
  return structuredClone(record);
}

function affected(value: unknown): LineageAssociationFailureV1 {
  const row = isPlainLineageRecord(value) ? value : {};
  const record = isPlainLineageRecord(row.record) ? row.record : row;
  const plan = isPlainLineageRecord(row.plan) ? row.plan : {};
  const bindings = Array.isArray(record.root_bindings)
    ? record.root_bindings
    : Array.isArray(plan.root_bindings)
      ? plan.root_bindings
      : [];
  const roots = bindings
    .flatMap((binding) =>
      isPlainLineageRecord(binding) && isBoundedLineageReference(binding.root_session_id)
        ? [binding.root_session_id]
        : [],
    )
    .filter((root, index, all) => all.indexOf(root) === index)
    .sort(compare);
  return {
    record_id:
      typeof record.association_id === "string" && ASSOCIATION_ID.test(record.association_id)
        ? record.association_id
        : null,
    root_session_ids: roots,
  };
}

export function deriveLineageAssociations(
  records: readonly unknown[],
  heads: ReadonlyMap<string, LineageHeadRecordV1>,
): {
  ids_by_root: ReadonlyMap<string, readonly string[]>;
  source_entries: ConversationCatalogSourceInventoryEntryV1[];
  failures: LineageAssociationFailureV1[];
} {
  const ids = new Map<string, string[]>();
  const entries: ConversationCatalogSourceInventoryEntryV1[] = [];
  const failures: LineageAssociationFailureV1[] = [];
  const seen = new Set<string>();
  for (const input of records) {
    try {
      const record = validateLineageAssociationAuthority(input, heads);
      if (seen.has(record.association_id)) throw new Error("duplicate lineage association");
      seen.add(record.association_id);
      for (const binding of record.root_bindings) {
        const bucket = ids.get(binding.root_session_id) ?? [];
        bucket.push(record.association_id);
        bucket.sort(compare);
        ids.set(binding.root_session_id, bucket);
        entries.push({
          source_kind: "lineage-association",
          root_session_id: binding.root_session_id,
          record_id: record.association_id,
          record_digest: record.content_digest,
        });
      }
    } catch {
      failures.push(affected(input));
    }
  }
  failures.sort(
    (left, right) =>
      compare(left.root_session_ids[0] ?? "", right.root_session_ids[0] ?? "") ||
      compare(left.record_id ?? "", right.record_id ?? ""),
  );
  return { ids_by_root: ids, source_entries: entries, failures };
}

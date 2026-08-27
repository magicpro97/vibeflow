import {
  isConversationHostActionKind,
  isHostActionKind,
} from "../../actions/host-action-contract.js";
import { PUBLIC_ACTION_TARGET_SUBJECT_KIND } from "../../actions/public-operation-contract.js";
import type { PublicActionApprovalViewV1 } from "../../actions/public-types.js";
import {
  isBoundedWireIdentity,
  isBoundedWireText,
  isExactWireTimestamp,
  isSha256WireDigest,
  sameWireValue,
} from "../../actions/public-wire-primitives.js";
import {
  ACTION_APPROVAL_FIELDS,
  ACTION_PROPOSAL_FIELDS,
  PUBLIC_ACTOR_FIELDS,
} from "./conversation-home-action-boundary-fields.js";
import {
  assert,
  ACTION_APPROVAL_ID_PATTERN,
  ACTION_AUTHORITY_BINDING_MODES,
  ACTION_CHALLENGE_CLASSES,
  ACTION_DECISIONS,
  ACTION_DOMAIN,
  ACTION_DOMAINS,
  ACTION_EFFECT_CLASSES,
  ACTION_PROPOSAL_ID_PATTERN,
  ACTION_REVERSIBILITY,
  ACTION_RISKS,
  ACTION_SCOPES,
  ACTOR_KINDS,
  CREDENTIAL_CLASSES,
  PUBLIC_ACTION_SCHEMA_VERSION,
  assertExactRecord,
  assertPattern,
  assertStringArray,
  memberOf,
  nullableIdentity,
} from "./conversation-home-action-boundary-shared.js";
import { parseActionTargetBinding } from "./conversation-home-action-operation-boundary.js";
import { parsePackagePin, parsePreview } from "./conversation-home-action-preview-boundary.js";
import type { HomeActionProposal } from "./conversation-home-types.js";

function parsePublicActor(value: unknown): void {
  const row = assertExactRecord(value, PUBLIC_ACTOR_FIELDS, "invalid action actor");
  assert(memberOf(ACTOR_KINDS, row.kind), "invalid action actor kind");
  assert(isBoundedWireIdentity(row.public_actor_id), "invalid action actor id");
  assert(memberOf(CREDENTIAL_CLASSES, row.credential_class), "invalid action credential class");
}

function assertProposalTargetSubjectBinding(
  value: { subject: Record<string, unknown> },
  proposal: Pick<HomeActionProposal, "action_type" | "domain">,
): void {
  if (proposal.domain === ACTION_DOMAIN.CONVERSATION) {
    assert(
      value.subject.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION &&
        value.subject.action_type === proposal.action_type,
      "action proposal target subject mismatch",
    );
    return;
  }
  assert(
    value.subject.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY,
    "action proposal target subject mismatch",
  );
}

export function parseActionProposal(value: unknown): HomeActionProposal {
  const row = assertExactRecord(value, ACTION_PROPOSAL_FIELDS, "invalid action proposal");
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action proposal schema version",
  );
  assertPattern(row.proposal_id, ACTION_PROPOSAL_ID_PATTERN, "invalid action proposal id");
  assert(isSha256WireDigest(row.proposal_digest), "invalid action proposal digest");
  assert(nullableIdentity(row.origin_event_id), "invalid action proposal origin event id");
  assert(isHostActionKind(row.action_type), "invalid action proposal type");
  assert(memberOf(ACTION_DOMAINS, row.domain), "invalid action proposal domain");
  assert(
    row.domain === ACTION_DOMAIN.CONVERSATION
      ? isConversationHostActionKind(row.action_type)
      : !isConversationHostActionKind(row.action_type),
    "action proposal type does not belong to its domain",
  );
  assert(memberOf(ACTION_SCOPES, row.scope), "invalid action proposal scope");
  assert(
    memberOf(ACTION_AUTHORITY_BINDING_MODES, row.authority_binding_mode),
    "invalid action authority binding mode",
  );
  assert(memberOf(ACTION_RISKS, row.risk), "invalid action proposal risk");
  assertStringArray(
    row.effect_classes,
    (item) => memberOf(ACTION_EFFECT_CLASSES, item),
    "invalid action proposal effect classes",
  );
  assert(Array.isArray(row.targets), "invalid action proposal targets");
  for (const target of row.targets) {
    parseActionTargetBinding(target);
    assertProposalTargetSubjectBinding(target, row as HomeActionProposal);
  }
  const packagePins = Array.isArray(row.package_pins)
    ? row.package_pins.map(parsePackagePin)
    : null;
  assert(packagePins !== null, "invalid action proposal package pins");
  assert(isSha256WireDigest(row.adapter_set_digest), "invalid adapter set digest");
  assert(isSha256WireDigest(row.plan_digest), "invalid plan digest");
  assert(isSha256WireDigest(row.policy_digest), "invalid policy digest");
  assert(isSha256WireDigest(row.permission_digest), "invalid permission digest");
  assert(memberOf(ACTION_REVERSIBILITY, row.reversibility), "invalid action reversibility");
  parsePreview(row.preview, row.action_type);
  assert(sameWireValue(row.preview.targets, row.targets), "action preview targets mismatch");
  assert(
    sameWireValue(row.preview.package_pins, row.package_pins),
    "action preview package pins mismatch",
  );
  assert(
    sameWireValue(row.preview.effect_classes, row.effect_classes),
    "action preview effect classes mismatch",
  );
  assert(row.preview.reversibility === row.reversibility, "action preview reversibility mismatch");
  assert(isExactWireTimestamp(row.created_at), "invalid action proposal created_at");
  assert(isExactWireTimestamp(row.expires_at), "invalid action proposal expires_at");
  assert(Date.parse(row.expires_at) > Date.parse(row.created_at), "invalid action proposal expiry");
  return structuredClone(row) as HomeActionProposal;
}

export function parseActionApproval(value: unknown): PublicActionApprovalViewV1 {
  const row = assertExactRecord(value, ACTION_APPROVAL_FIELDS, "invalid action approval");
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action approval schema version",
  );
  assertPattern(row.approval_id, ACTION_APPROVAL_ID_PATTERN, "invalid action approval id");
  assert(isSha256WireDigest(row.approval_digest), "invalid action approval digest");
  assertPattern(row.proposal_id, ACTION_PROPOSAL_ID_PATTERN, "invalid action approval proposal id");
  assert(isSha256WireDigest(row.proposal_digest), "invalid action approval proposal digest");
  assert(memberOf(ACTION_DECISIONS, row.decision), "invalid action approval decision");
  assert(memberOf(ACTION_CHALLENGE_CLASSES, row.challenge_class), "invalid action challenge class");
  parsePublicActor(row.decided_by);
  assert(isExactWireTimestamp(row.decided_at), "invalid action approval decided_at");
  assert(isExactWireTimestamp(row.expires_at), "invalid action approval expires_at");
  assert(Date.parse(row.expires_at) > Date.parse(row.decided_at), "invalid action approval expiry");
  return structuredClone(row) as PublicActionApprovalViewV1;
}

import { canonicalJson, digestV1 } from "../../durability/index.js";
import { foldGrantFrames, validateAuthorityHead } from "../authority/index.js";
import type { AuthorityEpochHeadV1, GrantFrameV1 } from "../authority/index.js";
import {
  type DurableAuthorityStateV1,
  assertDurableAuthorityState,
} from "../source/durable-authority-state.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  timestamp,
} from "../wire/primitives.js";
import { permissionContains } from "./containment.js";
import { canonicalPermissionUnion, permissionRowSortKey } from "./containment.js";
import type {
  CapabilityGrantAuthorizationWitnessV1,
  EffectiveGrantFrameV1,
  GrantedPermissionBindingV1,
  PermissionBindingRowV1,
  ValidatedGrantAuthorityPrefixV1,
} from "./types.js";

export function grantedPermissionBindingDigest(binding: GrantedPermissionBindingV1): string {
  const { binding_digest: _, ...preimage } = binding;
  return digestV1("VF-GRANTED-PERMISSION-BINDING\0v1\0", preimage);
}

export function requestedPermissionRowDigest(row: PermissionBindingRowV1): string {
  return digestV1("VF-CAPABILITY-PRE-EFFECT-PERMISSION\0v1\0", {
    schema_version: "1.0",
    permission_id: row.permission_id,
    kind: row.kind,
    permission_scope_digest: digestV1("VF-CAPABILITY-PERMISSION-SCOPE\0v1\0", {
      kind: row.kind,
      scope: row.scope,
    }),
    enforcement: row.enforcement,
    target_ids: row.target_ids,
  });
}

interface WitnessContextV1 {
  evaluated_at: string;
  principal: EffectiveGrantFrameV1["principal"];
  scope: "project" | "user";
  action_type: string;
  target_engines: string[];
}

const VALIDATED_PREFIXES = new WeakMap<object, { frames: readonly EffectiveGrantFrameV1[] }>();

export function grantAuthorityPrefixFromDurableState(
  durableState: DurableAuthorityStateV1,
): ValidatedGrantAuthorityPrefixV1 {
  const state = assertDurableAuthorityState(durableState);
  const frames: readonly GrantFrameV1[] = state.grants;
  const head: AuthorityEpochHeadV1 = state.current;
  validateAuthorityHead(head);
  const fold = foldGrantFrames(frames, head.scope, head.scope_identity_digest);
  const value = Object.freeze({
    schema_version: "1.0" as const,
    scope: head.scope,
    scope_identity_digest: head.scope_identity_digest,
    authority_epoch: head.authority_epoch,
    authority_head_digest: head.content_digest,
    grant_head_digest: head.grant_head_digest,
    grant_state_digest: head.grant_digest,
  });
  VALIDATED_PREFIXES.set(value, {
    frames: [...fold.latest.values()].map((frame) => ({
      grant_id: frame.grant_id,
      frame_digest: frame.frame_digest,
      transition: frame.transition,
      principal: structuredClone(frame.principal),
      scope: frame.scope,
      action_types: [...frame.action_types],
      target_engines: [...frame.target_engines],
      permissions: structuredClone(frame.permissions),
      not_before: frame.not_before,
      expires_at: frame.expires_at,
      revoked_at: frame.revoked_at,
    })),
  });
  return value;
}

interface Selection {
  request: PermissionBindingRowV1;
  requestDigest: string;
  frame: EffectiveGrantFrameV1;
  binding: GrantedPermissionBindingV1;
}

function effective(frame: EffectiveGrantFrameV1, context: WitnessContextV1, at: number): boolean {
  return (
    (frame.transition === "issued" || frame.transition === "renewed") &&
    frame.revoked_at === null &&
    canonicalJson(frame.principal) === canonicalJson(context.principal) &&
    frame.scope === context.scope &&
    frame.action_types.includes(context.action_type) &&
    context.target_engines.every((engine) => frame.target_engines.includes(engine)) &&
    timestamp(frame.not_before, "grant.not_before") <= at &&
    at < timestamp(frame.expires_at, "grant.expires_at")
  );
}

function coveringBinding(
  frame: EffectiveGrantFrameV1,
  request: PermissionBindingRowV1,
): GrantedPermissionBindingV1 | null {
  const candidates: GrantedPermissionBindingV1[] = [];
  for (const binding of frame.permissions) {
    if (
      binding.permission_id === request.permission_id &&
      binding.enforcement === request.enforcement &&
      canonicalJson(binding.target_ids) === canonicalJson(request.target_ids) &&
      permissionContains(binding, request)
    )
      candidates.push(binding);
  }
  candidates.sort((a, b) => bytewise(a.binding_digest, b.binding_digest));
  return candidates[0] ?? null;
}

function compareSelections(
  left: { frame: EffectiveGrantFrameV1 },
  right: { frame: EffectiveGrantFrameV1 },
): number {
  const expiry =
    timestamp(right.frame.expires_at, "grant.expires_at") -
    timestamp(left.frame.expires_at, "grant.expires_at");
  return (
    expiry ||
    bytewise(
      `${left.frame.grant_id}\0${left.frame.frame_digest}`,
      `${right.frame.grant_id}\0${right.frame.frame_digest}`,
    )
  );
}

function compareAuthorizationRows(
  left: {
    requested_permission_row_digest: string;
    covering_granted_permission_binding_digest: string;
  },
  right: {
    requested_permission_row_digest: string;
    covering_granted_permission_binding_digest: string;
  },
): number {
  return bytewise(
    `${left.requested_permission_row_digest}\0${left.covering_granted_permission_binding_digest}`,
    `${right.requested_permission_row_digest}\0${right.covering_granted_permission_binding_digest}`,
  );
}

function select(
  request: PermissionBindingRowV1,
  frames: readonly EffectiveGrantFrameV1[],
  context: WitnessContextV1,
  evaluated: number,
): Selection {
  const candidates = frames
    .filter((frame) => effective(frame, context, evaluated))
    .map((frame) => ({ frame, binding: coveringBinding(frame, request) }))
    .filter(
      (row): row is { frame: EffectiveGrantFrameV1; binding: GrantedPermissionBindingV1 } =>
        row.binding !== null,
    )
    .sort(compareSelections);
  const winner = candidates[0];
  if (!winner)
    throw new CapabilityValidationError(
      "no effective grant contains requested permission",
      "permissions",
    );
  return {
    request,
    requestDigest: requestedPermissionRowDigest(request),
    frame: winner.frame,
    binding: winner.binding,
  };
}

export function buildGrantAuthorizationWitness(
  requests: readonly PermissionBindingRowV1[],
  prefix: ValidatedGrantAuthorityPrefixV1,
  context: WitnessContextV1,
): CapabilityGrantAuthorizationWitnessV1 {
  const authority = VALIDATED_PREFIXES.get(prefix);
  if (!authority)
    throw new CapabilityValidationError(
      "grant witness requires a validated historical authority prefix",
      "grant_prefix",
      "integrity_failure",
    );
  if (context.scope !== prefix.scope)
    throw new CapabilityValidationError(
      "grant witness scope differs from authority prefix",
      "scope",
    );
  const evaluated = timestamp(context.evaluated_at, "evaluated_at");
  assertSortedUnique(context.target_engines, bytewise, "target_engines");
  const canonical = canonicalPermissionUnion(requests);
  const identities = requests.map(permissionRowSortKey);
  assertSortedUnique(identities, bytewise, "permissions");
  if (canonicalJson(canonical) !== canonicalJson(requests))
    throw new CapabilityValidationError(
      "grant witness requests are not the canonical permission union",
      "permissions",
    );
  const selections = requests.map((request) =>
    select(request, authority.frames, context, evaluated),
  );
  const groups = new Map<string, Selection[]>();
  for (const selection of selections) {
    const key = `${selection.frame.grant_id}\0${selection.frame.frame_digest}`;
    const group = groups.get(key) ?? [];
    group.push(selection);
    groups.set(key, group);
  }
  const grants = [...groups.values()]
    .map((group) => {
      const frame = group[0]?.frame as EffectiveGrantFrameV1;
      const authorization_rows = group
        .map(({ request, requestDigest, binding }) => ({
          requested_permission_row_digest: requestDigest,
          covering_granted_permission_binding_digest: binding.binding_digest,
          target_ids: [...request.target_ids],
        }))
        .sort(compareAuthorizationRows);
      const target_ids = [...new Set(authorization_rows.flatMap((row) => row.target_ids))].sort(
        bytewise,
      );
      return {
        grant_id: frame.grant_id,
        frame_digest: frame.frame_digest,
        authorization_rows,
        target_ids,
        expires_at: frame.expires_at,
      };
    })
    .sort((a, b) =>
      bytewise(`${a.grant_id}\0${a.frame_digest}`, `${b.grant_id}\0${b.frame_digest}`),
    );
  const draft = {
    schema_version: "1.0" as const,
    grant_state_digest: prefix.grant_state_digest,
    evaluated_at: context.evaluated_at,
    grants,
  };
  return {
    ...draft,
    witness_digest: digestV1("VF-CAPABILITY-GRANT-AUTHORIZATION-WITNESS\0v1\0", draft),
  };
}

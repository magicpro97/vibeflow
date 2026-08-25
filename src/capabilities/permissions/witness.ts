import { canonicalJson, digestV1 } from "../../durability/index.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  timestamp,
} from "../wire/primitives.js";
import { permissionContains } from "./containment.js";
import type {
  CapabilityGrantAuthorizationWitnessV1,
  EffectiveGrantFrameV1,
  GrantedPermissionBindingV1,
  PermissionBindingRowV1,
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
  grant_state_digest: string;
  evaluated_at: string;
  principal_digest: string;
  scope: "project" | "user";
  action_type: string;
  target_engines: string[];
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
    frame.principal_digest === context.principal_digest &&
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
  const candidates = frame.permissions.filter((binding) => {
    if (binding.binding_digest !== grantedPermissionBindingDigest(binding))
      throw new CapabilityValidationError(
        "granted permission digest mismatch",
        "grant.permissions",
      );
    return (
      binding.permission_id === request.permission_id &&
      binding.enforcement === request.enforcement &&
      canonicalJson(binding.target_ids) === canonicalJson(request.target_ids) &&
      permissionContains(binding, request)
    );
  });
  candidates.sort((a, b) => bytewise(a.binding_digest, b.binding_digest));
  return candidates[0] ?? null;
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
    .sort((left, right) => {
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
    });
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
  frames: readonly EffectiveGrantFrameV1[],
  context: WitnessContextV1,
): CapabilityGrantAuthorizationWitnessV1 {
  const evaluated = timestamp(context.evaluated_at, "evaluated_at");
  assertSortedUnique(context.target_engines, bytewise, "target_engines");
  const selections = requests.map((request) => select(request, frames, context, evaluated));
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
        .sort((a, b) =>
          bytewise(
            `${a.requested_permission_row_digest}\0${a.covering_granted_permission_binding_digest}`,
            `${b.requested_permission_row_digest}\0${b.covering_granted_permission_binding_digest}`,
          ),
        );
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
    grant_state_digest: context.grant_state_digest,
    evaluated_at: context.evaluated_at,
    grants,
  };
  return {
    ...draft,
    witness_digest: digestV1("VF-CAPABILITY-GRANT-AUTHORIZATION-WITNESS\0v1\0", draft),
  };
}

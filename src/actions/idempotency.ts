import { digestHex, digestV1 } from "../durability/index.js";
import { validateActionProposalRequestValue } from "./proposal-request-validation.js";
import { assertDigest } from "./record-primitives.js";
import { assertRequestActionMapping } from "./request-action-mapping.js";
import type { HostActionRequestV1 } from "./request-types.js";
import { ActionValidationError, boundedString, exactObject } from "./strict-json.js";
import type {
  ActionPlanningOptionsV1,
  ActionProposalRequestV1,
  ActionProposalV1,
  ActionRequestAuthorityV1,
  CapabilityScope,
  PrivateActionRootLocatorV1,
} from "./types.js";
import { validateHostActionRequest } from "./validation.js";

export type CanonicalActionRequestV1 =
  | {
      schema_version: "1.0";
      origin: "conversation";
      principal_digest: string;
      authority_scope_digest: string;
      planning_options: { mode: "durable"; network_read: "ordinary-host-policy" };
      request: Omit<ActionProposalRequestV1, "idempotency_key">;
    }
  | {
      schema_version: "1.0";
      origin: "standalone";
      principal_digest: string;
      authority_scope_digest: string;
      scope: CapabilityScope;
      planning_options: ActionPlanningOptionsV1;
      action: HostActionRequestV1;
    };

export function validateIdempotencyKey(value: unknown): string {
  const key = boundedString(value, "$.idempotency_key", { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(key))
    throw new ActionValidationError("invalid idempotency_key grammar", "$.idempotency_key");
  return key;
}

export function actionIdempotencyKeyDigest(key: string): string {
  validateIdempotencyKey(key);
  return digestV1("VF-ACTION-IDEMPOTENCY-KEY\0v1\0", {
    schema_version: "1.0",
    idempotency_key: key,
  });
}

export function actionIdempotencyScopeDigest(
  locator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>,
): string;
export function actionIdempotencyScopeDigest(locator: PrivateActionRootLocatorV1): string;
export function actionIdempotencyScopeDigest(locator: PrivateActionRootLocatorV1): string {
  if (locator.kind === "recovery-bootstrap")
    throw new Error("recovery bootstrap has no ordinary action idempotency namespace");
  if (locator.kind === "conversation") {
    const row = exactObject(locator, ["kind", "root_session_id"], [], "$.action_root_locator");
    assertRootSessionId(row.root_session_id);
    return digestV1("VF-ACTION-IDEMPOTENCY-SCOPE\0v1\0", {
      kind: "conversation",
      root_session_id: row.root_session_id,
    });
  }
  const row = exactObject(
    locator,
    ["kind", "scope", "scope_identity_digest"],
    [],
    "$.action_root_locator",
  );
  if (row.kind !== "capability" || !(["project", "user"] as unknown[]).includes(row.scope))
    throw new Error("invalid capability idempotency scope");
  assertDigest(row.scope_identity_digest, "$.action_root_locator.scope_identity_digest");
  return digestV1("VF-ACTION-IDEMPOTENCY-SCOPE\0v1\0", {
    kind: "capability",
    scope: row.scope,
    scope_identity_digest: row.scope_identity_digest,
  });
}

export function canonicalActionRequestDigest(request: CanonicalActionRequestV1): string {
  validateCanonicalActionRequest(request);
  return digestV1("VF-ACTION-IDEMPOTENCY-REQUEST\0v1\0", request);
}

export function actionIdempotencyFileKey(
  principalDigest: string,
  authorityScopeDigest: string,
  keyDigest: string,
): string {
  assertDigest(principalDigest, "$.idempotency.principal_digest");
  assertDigest(authorityScopeDigest, "$.idempotency.authority_scope_digest");
  assertDigest(keyDigest, "$.idempotency.idempotency_key_digest");
  return digestHex(
    digestV1("VF-ACTION-IDEMPOTENCY-FILE-KEY\0v1\0", {
      schema_version: "1.0",
      principal_digest: principalDigest,
      authority_scope_digest: authorityScopeDigest,
      idempotency_key_digest: keyDigest,
    }),
  );
}

export function oversizedHandoffIssuanceFileKey(
  principalDigest: string,
  authorityScopeDigest: string,
  keyDigest: string,
): string {
  assertDigest(principalDigest, "$.issuance.principal_digest");
  assertDigest(authorityScopeDigest, "$.issuance.authority_scope_digest");
  assertDigest(keyDigest, "$.issuance.idempotency_key_digest");
  return digestHex(
    digestV1("VF-OVERSIZED-HANDOFF-ISSUANCE-FILE-KEY\0v1\0", {
      schema_version: "1.0",
      principal_digest: principalDigest,
      authority_scope_digest: authorityScopeDigest,
      idempotency_key_digest: keyDigest,
    }),
  );
}

export function assertCanonicalRequestAuthority(
  request: CanonicalActionRequestV1,
  authority: ActionRequestAuthorityV1,
  proposal: ActionProposalV1,
): void {
  validateCanonicalActionRequest(request);
  const derivedScope = actionIdempotencyScopeDigest(proposal.action_root_locator);
  if (
    request.principal_digest !== authority.principal_digest ||
    request.authority_scope_digest !== authority.authority_scope_digest ||
    authority.authority_scope_digest !== derivedScope
  )
    throw new Error("canonical request authority scope digest mismatch");
  if (request.planning_options.mode !== proposal.planning_options.mode)
    throw new Error("canonical request planning mode mismatch");
  if (request.origin === "conversation") {
    if (proposal.action_root_locator.kind !== "conversation")
      throw new Error("conversation request has non-conversation action root");
    if (
      request.request.expected.conversation_id !== proposal.base.conversation_id ||
      request.request.expected.revision_id !== proposal.base.revision_id ||
      request.request.expected.last_seq !== proposal.base.last_seq ||
      request.request.expected.conversation_lock_digest !==
        proposal.base.conversation_lock_digest ||
      request.request.anchor_event_id !== proposal.origin_event_id
    )
      throw new Error("canonical conversation request and proposal disagree");
  } else {
    if (
      proposal.action_root_locator.kind !== "capability" ||
      request.scope !== proposal.base.capability_scope
    )
      throw new Error("standalone request scope and proposal disagree");
    if (proposal.origin_event_id !== null)
      throw new Error("standalone request action or origin mismatch");
  }
  assertRequestActionMapping(
    request.origin === "conversation" ? request.request.candidate : request.action,
    proposal.action,
  );
  const digest = canonicalActionRequestDigest(request);
  if (
    proposal.producer_request_binding.kind !== "canonical-action-request" ||
    proposal.producer_request_binding.digest !== digest
  )
    throw new Error("proposal producer request binding mismatch");
}

function assertRootSessionId(value: unknown): void {
  const root = boundedString(value, "$.action_root_locator.root_session_id", { min: 1, max: 256 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(root))
    throw new Error("invalid conversation idempotency root session ID");
}

function validateCanonicalActionRequest(value: unknown): asserts value is CanonicalActionRequestV1 {
  const base = exactObject(
    value,
    ["schema_version", "origin", "principal_digest", "authority_scope_digest", "planning_options"],
    ["request", "scope", "action"],
    "$.canonical_request",
  );
  if (base.schema_version !== "1.0") throw new Error("unsupported canonical request version");
  assertDigest(base.principal_digest, "$.canonical_request.principal_digest");
  assertDigest(base.authority_scope_digest, "$.canonical_request.authority_scope_digest");
  if (base.origin === "conversation") {
    exactObject(
      value,
      [
        "schema_version",
        "origin",
        "principal_digest",
        "authority_scope_digest",
        "planning_options",
        "request",
      ],
      [],
      "$.canonical_request",
    );
    if ((base.planning_options as { mode?: unknown }).mode !== "durable")
      throw new Error("conversation action planning must be durable");
    validateActionProposalRequestValue({
      ...(base.request as Record<string, unknown>),
      idempotency_key: "canonical-validation",
    });
  } else if (base.origin === "standalone") {
    exactObject(
      value,
      [
        "schema_version",
        "origin",
        "principal_digest",
        "authority_scope_digest",
        "scope",
        "planning_options",
        "action",
      ],
      [],
      "$.canonical_request",
    );
    if (base.scope !== "project" && base.scope !== "user")
      throw new Error("invalid standalone scope");
    const planning = exactObject(
      base.planning_options,
      ["mode", "network_read"],
      [],
      "$.canonical_request.planning_options",
    );
    const validPlanning =
      (planning.mode === "durable" && planning.network_read === "ordinary-host-policy") ||
      (planning.mode === "transient" &&
        (planning.network_read === "forbid" || planning.network_read === "allow-if-granted"));
    if (!validPlanning) throw new Error("invalid standalone planning options");
    validateHostActionRequest(base.action);
  } else throw new Error("invalid canonical request origin");
}

import { isCapabilityScope } from "../core/capability-contract.js";
import { digestHex, digestV1 } from "../durability/index.js";
import { assertCanonicalConversationActionRequestValue } from "./proposal-request-validation.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
} from "./protocol-contract.js";
import {
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
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
      schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
      origin: "conversation";
      principal_digest: string;
      authority_scope_digest: string;
      planning_options: {
        mode: typeof ACTION_PLANNING_MODE.DURABLE;
        network_read: typeof ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY;
      };
      request: Omit<ActionProposalRequestV1, "idempotency_key" | "candidate"> & {
        candidate: HostActionRequestV1;
      };
    }
  | {
      schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
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
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    idempotency_key: key,
  });
}

export function actionIdempotencyScopeDigest(
  locator: Exclude<
    PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >,
): string;
export function actionIdempotencyScopeDigest(locator: PrivateActionRootLocatorV1): string;
export function actionIdempotencyScopeDigest(locator: PrivateActionRootLocatorV1): string {
  if (locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    throw new Error("recovery bootstrap has no ordinary action idempotency namespace");
  if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION) {
    const row = exactObject(locator, ["kind", "root_session_id"], [], "$.action_root_locator");
    assertRootSessionId(row.root_session_id);
    return digestV1("VF-ACTION-IDEMPOTENCY-SCOPE\0v1\0", {
      kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
      root_session_id: row.root_session_id,
    });
  }
  const row = exactObject(
    locator,
    ["kind", "scope", "scope_identity_digest"],
    [],
    "$.action_root_locator",
  );
  if (row.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY || !isCapabilityScope(row.scope))
    throw new Error("invalid capability idempotency scope");
  assertDigest(row.scope_identity_digest, "$.action_root_locator.scope_identity_digest");
  return digestV1("VF-ACTION-IDEMPOTENCY-SCOPE\0v1\0", {
    kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
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
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
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
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
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
    if (proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION)
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
      proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
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
    proposal.producer_request_binding.kind !==
      ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST ||
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
  if (base.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION)
    throw new Error("unsupported canonical request version");
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
    if ((base.planning_options as { mode?: unknown }).mode !== ACTION_PLANNING_MODE.DURABLE)
      throw new Error("conversation action planning must be durable");
    assertCanonicalConversationActionRequestValue({
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
    if (!isCapabilityScope(base.scope)) throw new Error("invalid standalone scope");
    const planning = exactObject(
      base.planning_options,
      ["mode", "network_read"],
      [],
      "$.canonical_request.planning_options",
    );
    const validPlanning =
      (planning.mode === ACTION_PLANNING_MODE.DURABLE &&
        planning.network_read === ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY) ||
      (planning.mode === ACTION_PLANNING_MODE.TRANSIENT &&
        (planning.network_read === ACTION_PLANNING_NETWORK_READ_VALUE.FORBID ||
          planning.network_read === ACTION_PLANNING_NETWORK_READ_VALUE.ALLOW_IF_GRANTED));
    if (!validPlanning) throw new Error("invalid standalone planning options");
    validateHostActionRequest(base.action);
  } else throw new Error("invalid canonical request origin");
}

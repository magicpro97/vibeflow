import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { CapabilityValidationError, digest, integer, text, timestamp } from "../wire/primitives.js";
import { validateActionRootLocator } from "./shapes.js";

export const AUTHORITY_SCOPES = ["project", "user"] as const;

export function nullableAuthorityDigest(value: unknown, path: string): void {
  if (value !== null) digest(value, path);
}

export function validateCommonAuthorityFrame(value: {
  schema_version: string;
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  operation_header_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  recorded_at?: string;
}): void {
  if (value.schema_version !== "1.0")
    throw new CapabilityValidationError("unsupported authority frame schema", "schema_version");
  integer(value.authority_epoch, "authority_epoch", 1);
  text(value.operation_id, "operation_id", { min: 1, max: 512, ascii: true });
  text(value.proposal_id, "proposal_id", { min: 1, max: 512, ascii: true });
  text(value.approval_id, "approval_id", { min: 1, max: 512, ascii: true });
  digest(value.plan_digest, "plan_digest");
  digest(value.operation_header_digest, "operation_header_digest");
  validateActionRootLocator(value.action_root_locator, "action_root_locator");
  if (value.action_root_locator.kind === "capability")
    digest(
      value.action_root_locator.scope_identity_digest,
      "action_root_locator.scope_identity_digest",
    );
  if (value.recorded_at) timestamp(value.recorded_at, "recorded_at");
}

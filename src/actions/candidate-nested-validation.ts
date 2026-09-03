import {
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "../orchestrator/conversation/conversation-public-wire-contract.js";
import {
  CAPABILITY_SIGNATURE_ALGORITHM,
  isCapabilityTrustTransition,
} from "./capability-security-contract.js";
import { assertDigest, assertTimestamp } from "./record-primitives.js";
import { ActionValidationError, boundedString, exactObject } from "./strict-json.js";

function stringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length > 256)
    throw new ActionValidationError("expected bounded string array", path);
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const current = boundedString(item, `${path}[${index}]`);
    if (seen.has(current)) throw new ActionValidationError("duplicate array item", path);
    seen.add(current);
  });
}

export function validateCompactionInput(value: unknown, path: string): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "profile",
      "public_summary",
      "retained_event_ids",
      "retained_artifact_ids",
      "input_digest",
    ],
    [],
    path,
  );
  if (
    row.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    row.profile !== CONVERSATION_PUBLIC_PROFILE.COMPACTION
  )
    throw new ActionValidationError("invalid compaction profile", path);
  boundedString(row.public_summary, `${path}.public_summary`, { max: 64 * 1024 });
  stringArray(row.retained_event_ids, `${path}.retained_event_ids`);
  stringArray(row.retained_artifact_ids, `${path}.retained_artifact_ids`);
  assertDigest(row.input_digest, `${path}.input_digest`);
}

export function validateRegistryTrustChange(value: unknown, path: string): void {
  const row = exactObject(
    value,
    [
      "transition",
      "key_id",
      "algorithm",
      "public_key_spki_base64",
      "registry_origin",
      "publisher_id",
      "valid_from",
      "valid_until",
      "reason",
    ],
    [],
    path,
  );
  if (!isCapabilityTrustTransition(row.transition))
    throw new ActionValidationError("unsupported transition", `${path}.transition`);
  if (row.algorithm !== CAPABILITY_SIGNATURE_ALGORITHM.ED25519)
    throw new ActionValidationError("unsupported algorithm", `${path}.algorithm`);
  for (const key of ["key_id", "public_key_spki_base64", "registry_origin"])
    boundedString(row[key], `${path}.${key}`);
  const validFrom = assertTimestamp(row.valid_from, `${path}.valid_from`);
  if (assertTimestamp(row.valid_until, `${path}.valid_until`) <= validFrom)
    throw new ActionValidationError("trust-key validity window is invalid", `${path}.valid_until`);
  for (const key of ["publisher_id", "reason"])
    if (row[key] !== null) boundedString(row[key], `${path}.${key}`);
}

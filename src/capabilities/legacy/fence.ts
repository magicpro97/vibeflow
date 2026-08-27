import { existsSync, readFileSync } from "node:fs";
import { parseStrictJson } from "../../actions/strict-json.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";

export function assertLegacyWriterAllowed(currentLockPath: string): void {
  if (!existsSync(currentLockPath)) return;
  let value: unknown;
  try {
    value = parseStrictJson(readFileSync(currentLockPath, "utf8"));
  } catch {
    throw new CapabilityRuntimeError(
      "unknown capability lock blocks the legacy writer",
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityRuntimeError(
      "unknown capability lock blocks the legacy writer",
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
    );
  const row = value as { schema_version?: unknown; fabric_active?: unknown };
  if (row.schema_version !== "1.0")
    throw new CapabilityRuntimeError(
      "newer or unknown Fabric lock blocks the legacy writer",
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
    );
  if (row.fabric_active === true)
    throw new CapabilityRuntimeError(
      "active Capability Fabric owns this writer surface",
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
    );
}

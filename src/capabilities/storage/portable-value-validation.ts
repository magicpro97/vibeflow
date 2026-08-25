import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import { CapabilityValidationError, text } from "../wire/primitives.js";

export function validatePortablePublicScalar(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CapabilityValidationError("portable public number must be finite", path);
    return;
  }
  if (typeof value !== "string")
    throw new CapabilityValidationError("portable input value must be a public scalar", path);
  const result = text(value, path, { max: 8_192 });
  try {
    assertPublicProjectionSafe(result, path, { maxBytes: 8_192 });
  } catch {
    throw new CapabilityValidationError(
      "portable public string contains private or credential material",
      path,
      "integrity_failure",
    );
  }
  if (
    result.startsWith("/") ||
    result.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(result) ||
    /^~[\\/]/.test(result) ||
    /^file:/i.test(result)
  )
    throw new CapabilityValidationError("portable public string contains an absolute path", path);
}

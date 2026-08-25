import type { JsonScalar } from "../../actions/types.js";
import type { CapabilityInputDeclarationV1, CapabilityManifestV1 } from "../manifest/types.js";
import { patternMatches } from "../manifest/validation-helpers.js";
import { canonicalRelativePrefix } from "../permissions/scope.js";
import type { CapabilityLockEntryV1 } from "../wire/lock.js";
import { CapabilityValidationError } from "../wire/primitives.js";

function fail(inputId: string, message: string): never {
  throw new CapabilityValidationError(
    `lock input ${inputId} ${message}`,
    `lock.packages.${inputId}`,
    "integrity_failure",
  );
}

function validatePublicValue(declaration: CapabilityInputDeclarationV1, value: JsonScalar): void {
  if (declaration.type === "boolean") {
    if (typeof value !== "boolean") fail(declaration.input_id, "requires a boolean");
    return;
  }
  if (declaration.type === "integer") {
    if (!Number.isSafeInteger(value)) fail(declaration.input_id, "requires an integer");
    const integer = value as number;
    if (declaration.min !== null && integer < declaration.min)
      fail(declaration.input_id, "is below its retained-manifest minimum");
    if (declaration.max !== null && integer > declaration.max)
      fail(declaration.input_id, "is above its retained-manifest maximum");
    return;
  }
  if (typeof value !== "string") fail(declaration.input_id, "requires a string");
  if (declaration.type === "enum" && !declaration.enum_values.includes(value))
    fail(declaration.input_id, "is outside its retained-manifest enum");
  if (declaration.pattern !== null && !patternMatches(declaration.pattern, value))
    fail(declaration.input_id, "does not match its retained-manifest pattern");
  if (declaration.type === "project-path")
    canonicalRelativePrefix(value, `lock.inputs.${declaration.input_id}`, false);
}

export function validateLockInputsAgainstManifest(
  entry: CapabilityLockEntryV1,
  manifest: CapabilityManifestV1,
): void {
  const declarations = new Map(manifest.inputs.map((row) => [row.input_id, row]));
  const present = new Set<string>();
  for (const row of entry.public_inputs) {
    const declaration = declarations.get(row.input_id);
    if (!declaration) fail(row.input_id, "is absent from the retained manifest");
    if (declaration.type === "secret-handle")
      fail(row.input_id, "is secret-declared and cannot appear in public_inputs");
    validatePublicValue(declaration, row.value);
    present.add(row.input_id);
  }
  for (const inputId of entry.secret_input_ids) {
    const declaration = declarations.get(inputId);
    if (!declaration || declaration.type !== "secret-handle")
      fail(inputId, "is not a secret-handle in the retained manifest");
    if (present.has(inputId)) fail(inputId, "appears in both public and secret input sets");
    present.add(inputId);
  }
  for (const declaration of manifest.inputs)
    if (declaration.required && !present.has(declaration.input_id))
      fail(declaration.input_id, "is required by the retained manifest but missing");
}

import { CAPABILITY_MANIFEST_INPUT_TYPE } from "../../actions/capability-manifest-vocabulary-contract.js";
import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { CapabilityPublicInputV1 } from "../../actions/request-types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityInputDeclarationV1 } from "../manifest/types.js";
import { patternMatches } from "../manifest/validation-helpers.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityExecutionPrivateInputBindingV1 } from "../private-input/types.js";
import { bytewise } from "../wire/primitives.js";
import { privateActionInputBindingDigest } from "./action-materialization.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

type PrivateReferenceV1 = Extract<CapabilityPublicInputV1["value"], object>;

export interface CapabilityPrivateInputPatchBindingV1 {
  binding_digest: string;
  prior_binding_digest: string;
  patch_digest: string;
}

export interface CapabilityPrivateInputAuthorityV1 {
  validateReference(input: {
    scope: CapabilityScope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_id: string;
    reference: PrivateReferenceV1;
  }): void;
  resolveCurrentBinding(input: {
    scope: CapabilityScope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_ids: string[];
  }): string;
  resolvePatchedBinding?(input: {
    scope: CapabilityScope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    current_binding_digest: string;
    current_input_ids: string[];
    replacements: Array<{ input_id: string; reference: PrivateReferenceV1 }>;
    patch_digest: string;
  }): CapabilityPrivateInputPatchBindingV1;
  materializeExecutionBinding?(input: {
    scope: CapabilityScope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_ids: string[];
    action_root_locator: Exclude<
      import("../../actions/types.js").PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >;
    preparation_digest: string | null;
  }): CapabilityExecutionPrivateInputBindingV1;
}

export class UnavailableCapabilityPrivateInputAuthorityV1
  implements CapabilityPrivateInputAuthorityV1
{
  validateReference(): void {
    throw new CapabilityRuntimeError(
      "a credential broker with durable private-input authority is unavailable",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  }

  resolveCurrentBinding(input: { input_ids: string[] }): string {
    if (input.input_ids.length > 0) this.validateReference();
    return digestV1("VF-PRIVATE-INPUT-BINDING-EMPTY\0v1\0", input);
  }
}

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN);
}

function validatePublicValue(declaration: CapabilityInputDeclarationV1, value: unknown): void {
  if (declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.BOOLEAN) {
    if (typeof value !== "boolean") invalid(`input ${declaration.input_id} requires a boolean`);
    return;
  }
  if (declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.INTEGER) {
    if (!Number.isSafeInteger(value)) invalid(`input ${declaration.input_id} requires an integer`);
    const integer = value as number;
    if (declaration.min !== null && integer < declaration.min)
      invalid(`input ${declaration.input_id} is below its minimum`);
    if (declaration.max !== null && integer > declaration.max)
      invalid(`input ${declaration.input_id} is above its maximum`);
    return;
  }
  if (typeof value !== "string") invalid(`input ${declaration.input_id} requires a string`);
  if (
    declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.ENUM &&
    !declaration.enum_values.includes(value as string)
  )
    invalid(`input ${declaration.input_id} is outside its enum`);
  if (declaration.pattern !== null && !patternMatches(declaration.pattern, value as string))
    invalid(`input ${declaration.input_id} does not match its pattern`);
  if (
    declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.PROJECT_PATH &&
    ((value as string).startsWith("/") || (value as string).split(/[\\/]/u).includes(".."))
  )
    invalid(`input ${declaration.input_id} is not a bounded project path`);
}

export function materializePackageInputs(input: {
  pkg: ResolvedCapabilityPackageV1;
  values: CapabilityPublicInputV1[];
  scope: CapabilityScope;
  scopeIdentityDigest: string;
  privateInputs: CapabilityPrivateInputAuthorityV1;
}): ResolvedCapabilityPackageV1 {
  const declarations = new Map(input.pkg.manifest.inputs.map((row) => [row.input_id, row]));
  if (new Set(input.values.map((row) => row.input_id)).size !== input.values.length)
    invalid("capability inputs must be unique");
  const publicInputs: ResolvedCapabilityPackageV1["public_inputs"] = [];
  const secretInputIds: string[] = [];
  for (const value of input.values) {
    const declaration = declarations.get(value.input_id);
    if (!declaration) invalid(`capability input ${value.input_id} is undeclared`);
    const privateReference = typeof value.value === "object" && value.value !== null;
    if (
      (declaration as CapabilityInputDeclarationV1).type ===
      CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE
    ) {
      if (!privateReference) invalid(`secret input ${value.input_id} requires an opaque binding`);
      input.privateInputs.validateReference({
        scope: input.scope,
        scope_identity_digest: input.scopeIdentityDigest,
        package_id: input.pkg.pin.id,
        package_pin_digest: input.pkg.pin.pin_digest,
        manifest_digest: input.pkg.manifest_digest,
        input_id: value.input_id,
        reference: value.value as PrivateReferenceV1,
      });
      secretInputIds.push(value.input_id);
    } else {
      if (privateReference) invalid(`public input ${value.input_id} cannot use a private binding`);
      validatePublicValue(declaration as CapabilityInputDeclarationV1, value.value);
      publicInputs.push({
        input_id: value.input_id,
        value: value.value as import("../../actions/types.js").JsonScalar,
      });
    }
  }
  for (const declaration of input.pkg.manifest.inputs) {
    if (input.values.some((row) => row.input_id === declaration.input_id)) continue;
    if (
      declaration.default_value !== null &&
      declaration.type !== CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE
    ) {
      validatePublicValue(declaration, declaration.default_value);
      publicInputs.push({ input_id: declaration.input_id, value: declaration.default_value });
    } else if (declaration.required)
      invalid(`required capability input ${declaration.input_id} is missing`);
  }
  publicInputs.sort((a, b) => bytewise(a.input_id, b.input_id));
  secretInputIds.sort(bytewise);
  return {
    ...input.pkg,
    public_inputs: publicInputs,
    secret_input_ids: secretInputIds,
    private_input_binding_digest:
      secretInputIds.length > 0
        ? privateActionInputBindingDigest(input.values)
        : digestV1("VF-PRIVATE-INPUT-BINDING-EMPTY\0v1\0", {
            schema_version: "1.0",
            scope: input.scope,
            scope_identity_digest: input.scopeIdentityDigest,
            package_id: input.pkg.pin.id,
            package_pin_digest: input.pkg.pin.pin_digest,
            manifest_digest: input.pkg.manifest_digest,
          }),
  };
}

export function materializeCurrentPackageInputs(input: {
  pkg: ResolvedCapabilityPackageV1;
  publicInputs: ResolvedCapabilityPackageV1["public_inputs"];
  secretInputIds: string[];
  scope: CapabilityScope;
  scopeIdentityDigest: string;
  privateInputs: CapabilityPrivateInputAuthorityV1;
}): ResolvedCapabilityPackageV1 {
  const declarations = new Map(input.pkg.manifest.inputs.map((row) => [row.input_id, row]));
  if (
    new Set(input.publicInputs.map((row) => row.input_id)).size !== input.publicInputs.length ||
    new Set(input.secretInputIds).size !== input.secretInputIds.length
  )
    invalid("current capability input set is duplicated");
  for (const row of input.publicInputs) {
    const declaration = declarations.get(row.input_id);
    if (!declaration || declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE)
      invalid(`current public input ${row.input_id} is not declared by the selected package`);
    validatePublicValue(declaration, row.value);
  }
  for (const inputId of input.secretInputIds) {
    if (declarations.get(inputId)?.type !== CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE)
      invalid(`current secret input ${inputId} is not declared by the selected package`);
  }
  for (const declaration of input.pkg.manifest.inputs) {
    if (
      declaration.required &&
      !input.publicInputs.some((row) => row.input_id === declaration.input_id) &&
      !input.secretInputIds.includes(declaration.input_id)
    )
      invalid(`required capability input ${declaration.input_id} is missing from current state`);
  }
  const binding = input.privateInputs.resolveCurrentBinding({
    scope: input.scope,
    scope_identity_digest: input.scopeIdentityDigest,
    package_id: input.pkg.pin.id,
    package_pin_digest: input.pkg.pin.pin_digest,
    manifest_digest: input.pkg.manifest_digest,
    input_ids: [...input.secretInputIds].sort(bytewise),
  });
  return {
    ...input.pkg,
    public_inputs: structuredClone(input.publicInputs),
    secret_input_ids: [...input.secretInputIds].sort(bytewise),
    private_input_binding_digest: binding,
  };
}

/** Configure is a non-empty patch. Omitted current public/private rows survive. */
export function materializePatchedPackageInputs(input: {
  pkg: ResolvedCapabilityPackageV1;
  values: CapabilityPublicInputV1[];
  scope: CapabilityScope;
  scopeIdentityDigest: string;
  privateInputs: CapabilityPrivateInputAuthorityV1;
}): ResolvedCapabilityPackageV1 {
  if (input.values.length === 0) invalid("configure requires a non-empty input patch");
  if (new Set(input.values.map((row) => row.input_id)).size !== input.values.length)
    invalid("capability inputs must be unique");
  const declarations = new Map(input.pkg.manifest.inputs.map((row) => [row.input_id, row]));
  const publicInputs = new Map(input.pkg.public_inputs.map((row) => [row.input_id, row.value]));
  const secretInputIds = new Set(input.pkg.secret_input_ids);
  const privateReplacements: Array<{ input_id: string; reference: PrivateReferenceV1 }> = [];
  for (const value of input.values) {
    const declaration = declarations.get(value.input_id);
    if (!declaration) invalid(`capability input ${value.input_id} is undeclared`);
    const privateReference = typeof value.value === "object" && value.value !== null;
    if (
      (declaration as CapabilityInputDeclarationV1).type ===
      CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE
    ) {
      if (!privateReference) invalid(`secret input ${value.input_id} requires an opaque binding`);
      input.privateInputs.validateReference({
        scope: input.scope,
        scope_identity_digest: input.scopeIdentityDigest,
        package_id: input.pkg.pin.id,
        package_pin_digest: input.pkg.pin.pin_digest,
        manifest_digest: input.pkg.manifest_digest,
        input_id: value.input_id,
        reference: value.value as PrivateReferenceV1,
      });
      secretInputIds.add(value.input_id);
      privateReplacements.push({
        input_id: value.input_id,
        reference: value.value as PrivateReferenceV1,
      });
    } else {
      if (privateReference) invalid(`public input ${value.input_id} cannot use a private binding`);
      validatePublicValue(declaration as CapabilityInputDeclarationV1, value.value);
      publicInputs.set(value.input_id, value.value as import("../../actions/types.js").JsonScalar);
    }
  }
  const sortedSecretIds = [...secretInputIds].sort(bytewise);
  const patchDigest = digestV1("VF-CAPABILITY-CONFIGURE-INPUT-PATCH\0v1\0", {
    schema_version: "1.0",
    prior_binding_digest: input.pkg.private_input_binding_digest,
    patch: [...input.values].sort((a, b) => bytewise(a.input_id, b.input_id)),
  });
  const resolvedPatch =
    privateReplacements.length === 0
      ? null
      : input.privateInputs.resolvePatchedBinding?.({
          scope: input.scope,
          scope_identity_digest: input.scopeIdentityDigest,
          package_id: input.pkg.pin.id,
          package_pin_digest: input.pkg.pin.pin_digest,
          manifest_digest: input.pkg.manifest_digest,
          current_binding_digest: input.pkg.private_input_binding_digest,
          current_input_ids: [...input.pkg.secret_input_ids].sort(bytewise),
          replacements: privateReplacements.sort((a, b) => bytewise(a.input_id, b.input_id)),
          patch_digest: patchDigest,
        });
  if (
    privateReplacements.length > 0 &&
    (!resolvedPatch ||
      resolvedPatch.prior_binding_digest !== input.pkg.private_input_binding_digest ||
      resolvedPatch.patch_digest !== patchDigest)
  )
    throw new CapabilityRuntimeError(
      "private input patch aggregation is unavailable",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  const binding = resolvedPatch?.binding_digest ?? input.pkg.private_input_binding_digest;
  return {
    ...input.pkg,
    public_inputs: [...publicInputs]
      .map(([input_id, value]) => ({ input_id, value }))
      .sort((a, b) => bytewise(a.input_id, b.input_id)),
    secret_input_ids: sortedSecretIds,
    private_input_binding_digest: binding,
  };
}

import { CAPABILITY_MANIFEST_INPUT_TYPE } from "../../actions/capability-manifest-vocabulary-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import { validateCapabilityManifest } from "../manifest/validation.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { validateImmutablePackagePin } from "../source/pins.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import type {
  CapabilityBrowserDetailResponseV1,
  CapabilityQueryItemV1,
  PublicCapabilityInputStateV1,
} from "../wire/query.js";
import type {
  CapabilityDetailRequestV1,
  CapabilityPackageReaderV1,
  CapabilityPrivateInputPresenceReaderV1,
} from "./types.js";

function selectItem(
  items: readonly CapabilityQueryItemV1[],
  request: CapabilityDetailRequestV1,
): CapabilityQueryItemV1 {
  const matches = items.filter(
    (item) =>
      item.package_id === request.package_id &&
      (request.package_pin_digest === undefined ||
        item.package_pin_digest === request.package_pin_digest) &&
      (request.version === undefined || item.version === request.version) &&
      (request.content_sha256 === undefined || item.content_sha256 === request.content_sha256),
  );
  if (matches.length === 0)
    throw new CapabilityRuntimeError(
      "capability package detail was not found",
      CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND,
    );
  if (matches.length !== 1)
    throw new CapabilityRuntimeError(
      "capability package detail selector is ambiguous",
      CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE,
    );
  const item = matches[0] as CapabilityQueryItemV1;
  if (item.package_pin_digest === null || item.content_sha256 === null)
    throw new CapabilityRuntimeError(
      "capability package has no retained immutable identity",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  return item;
}

function inputState(
  declaration: import("../manifest/types.js").CapabilityInputDeclarationV1,
  publicInputs: ReadonlyMap<string, string | number | boolean | null>,
  privateInputs: CapabilityPrivateInputPresenceReaderV1 | undefined,
  identity: {
    scope: CapabilityScope;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
  },
): PublicCapabilityInputStateV1 {
  if (declaration.type === CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE) {
    const current = privateInputs?.readValidatedPresence({
      ...identity,
      input_id: declaration.input_id,
    }) ?? {
      kind: "unset" as const,
    };
    return { declaration, current };
  }
  return publicInputs.has(declaration.input_id)
    ? {
        declaration,
        current: { kind: "public", value: publicInputs.get(declaration.input_id) ?? null },
      }
    : { declaration, current: { kind: "unset" } };
}

export function projectCapabilityDetail(input: {
  request: CapabilityDetailRequestV1;
  items: readonly CapabilityQueryItemV1[];
  source_watermark: string;
  lock: CapabilityLockV1 | null;
  packages: CapabilityPackageReaderV1 | undefined;
  privateInputs: CapabilityPrivateInputPresenceReaderV1 | undefined;
}): CapabilityBrowserDetailResponseV1 {
  const item = selectItem(input.items, input.request);
  const package_pin_digest = item.package_pin_digest as string;
  const content_sha256 = item.content_sha256 as string;
  if (!input.packages)
    throw new CapabilityRuntimeError(
      "capability detail package reader is unavailable",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  const pkg = input.packages.read({
    package_id: item.package_id,
    package_pin_digest,
    version: item.version as string,
    content_sha256,
  });
  if (!pkg)
    throw new CapabilityRuntimeError(
      "capability detail package is absent from the validated cache",
      CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND,
    );
  validateImmutablePackagePin(pkg.pin);
  validateCapabilityManifest(pkg.manifest, pkg.files);
  if (
    pkg.pin.id !== item.package_id ||
    pkg.pin.version !== item.version ||
    pkg.pin.pin_digest !== package_pin_digest ||
    pkg.pin.content_sha256 !== content_sha256 ||
    pkg.manifest.id !== pkg.pin.id ||
    pkg.manifest.version !== pkg.pin.version ||
    pkg.manifest_digest !== digestV1("VF-CAPABILITY-MANIFEST\0v1\0", pkg.manifest)
  )
    throw new CapabilityRuntimeError(
      "capability detail identity closure is inconsistent",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const installed = input.lock?.packages.find(
    (entry) =>
      entry.package_id === pkg.pin.id &&
      entry.pin.pin_digest === pkg.pin.pin_digest &&
      entry.manifest_digest === pkg.manifest_digest,
  );
  const publicInputs = new Map(
    installed?.public_inputs.map((row) => [row.input_id, row.value]) ?? [],
  );
  const identity = {
    scope: input.request.scope,
    package_id: pkg.pin.id,
    package_pin_digest: pkg.pin.pin_digest,
    manifest_digest: pkg.manifest_digest,
  };
  const inputs = pkg.manifest.inputs.map((declaration) =>
    inputState(declaration, publicInputs, input.privateInputs, identity),
  );
  return {
    schema_version: "1.0",
    item,
    package_pin_digest,
    content_sha256,
    manifest_digest: pkg.manifest_digest,
    inputs,
    input_schema_digest: digestV1("VF-CAPABILITY-INPUT-SCHEMA\0v1\0", {
      schema_version: "1.0",
      package_id: pkg.pin.id,
      version: pkg.pin.version,
      content_sha256,
      inputs: pkg.manifest.inputs,
    }),
    source_watermark: input.source_watermark,
  };
}

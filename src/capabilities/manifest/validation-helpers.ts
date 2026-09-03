import { createHash } from "node:crypto";
import {
  CAPABILITY_MANIFEST_INPUT_TYPE,
  CAPABILITY_MANIFEST_INPUT_TYPES,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import type { JsonScalar } from "../../actions/types.js";
import { canonicalRelativePrefix } from "../permissions/scope.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  integer,
  localId,
  rawSha256,
  text,
} from "../wire/primitives.js";
import type { CapabilityInputDeclarationV1, CapabilityTemplateValueV1 } from "./types.js";

export function inTreePath(value: unknown, path: string): string {
  return canonicalRelativePrefix(value, path, false);
}

export function verifyFile(
  files: ReadonlyMap<string, Uint8Array>,
  relativePath: string,
  expectedSha256: unknown,
  path: string,
  maxBytes = 16 * 1024 * 1024,
): Uint8Array {
  const expected = rawSha256(expectedSha256, `${path}.sha256`);
  const bytes = files.get(relativePath);
  if (!bytes) throw new CapabilityValidationError("referenced package file is missing", path);
  if (bytes.byteLength > maxBytes)
    throw new CapabilityValidationError(
      "referenced package file exceeds byte limit",
      path,
      "bounds",
    );
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== expected)
    throw new CapabilityValidationError(
      "referenced package file hash mismatch",
      path,
      "integrity_failure",
    );
  return bytes;
}

function quantified(pattern: string, index: number): { end: number; variable: boolean } | null {
  const token = pattern[index];
  if (token === "*" || token === "+" || token === "?") return { end: index + 1, variable: true };
  if (token !== "{") return null;
  const match = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/);
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum =
    match[2] === undefined
      ? minimum
      : match[2] === ""
        ? Number.POSITIVE_INFINITY
        : Number(match[2]);
  if (minimum > 256 || maximum > 256 || maximum < minimum)
    throw new CapabilityValidationError(
      "pattern repetition exceeds linear matcher bounds",
      "pattern",
    );
  return { end: index + match[0].length, variable: minimum !== maximum };
}

function assertLinearPattern(pattern: string, path: string): void {
  let variableQuantifiers = 0;
  let lastAtom: "atom" | "group" | "none" = "none";
  let depth = 0;
  for (let index = 0; index < pattern.length; ) {
    const current = pattern[index] as string;
    if (current === "\\") {
      if (index + 1 >= pattern.length)
        throw new CapabilityValidationError("invalid input pattern", path);
      lastAtom = "atom";
      index += 2;
      continue;
    }
    if (current === "[") {
      let closed = false;
      for (index += 1; index < pattern.length; index += 1) {
        if (pattern[index] === "\\") index += 1;
        else if (pattern[index] === "]") {
          closed = true;
          index += 1;
          break;
        }
      }
      if (!closed) throw new CapabilityValidationError("invalid input pattern", path);
      lastAtom = "atom";
      continue;
    }
    if (current === "|")
      throw new CapabilityValidationError(
        "pattern alternation is outside the guaranteed-linear grammar",
        path,
      );
    if (current === "(" && pattern[index + 1] === "?")
      throw new CapabilityValidationError("pattern uses an unsupported group construct", path);
    if (current === "(") {
      depth += 1;
      lastAtom = "none";
      index += 1;
      continue;
    }
    if (current === ")") {
      if (depth === 0) throw new CapabilityValidationError("invalid input pattern", path);
      depth -= 1;
      lastAtom = "group";
      index += 1;
      continue;
    }
    const repetition = quantified(pattern, index);
    if (repetition) {
      if (lastAtom === "none" || lastAtom === "group")
        throw new CapabilityValidationError(
          "pattern repeats an unsupported or grouped expression",
          path,
        );
      if (repetition.variable && ++variableQuantifiers > 1)
        throw new CapabilityValidationError("pattern has more than one variable repetition", path);
      lastAtom = "none";
      index = repetition.end;
      continue;
    }
    lastAtom = current === "^" || current === "$" ? "none" : "atom";
    index += 1;
  }
  if (depth !== 0) throw new CapabilityValidationError("invalid input pattern", path);
}

function safePattern(value: unknown, path: string): string | null {
  if (value === null) return null;
  const pattern = text(value, path, { max: 1_024 });
  if (/\\[1-9]/.test(pattern))
    throw new CapabilityValidationError("pattern uses a backreference", path);
  assertLinearPattern(pattern, path);
  try {
    new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    throw new CapabilityValidationError("invalid input pattern", path);
  }
  return pattern;
}

export function patternMatches(pattern: string, value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 8_192)
    throw new CapabilityValidationError("pattern input exceeds byte limit", "value", "bounds");
  return new RegExp(`^(?:${safePattern(pattern, "pattern")})$`, "u").test(value);
}

function scalar(value: unknown, path: string): JsonScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new CapabilityValidationError("expected public scalar", path);
}

export function validateInputDeclaration(value: CapabilityInputDeclarationV1, path: string): void {
  localId(value.input_id, `${path}.input_id`);
  text(value.label, `${path}.label`, { min: 1, max: 256 });
  if (!CAPABILITY_MANIFEST_INPUT_TYPES.some((candidate) => candidate === value.type))
    throw new CapabilityValidationError("invalid input type", `${path}.type`);
  if (typeof value.required !== "boolean")
    throw new CapabilityValidationError("required must be boolean", `${path}.required`);
  const defaultValue = scalar(value.default_value, `${path}.default_value`);
  if (!Array.isArray(value.enum_values) || value.enum_values.length > 256)
    throw new CapabilityValidationError("invalid enum values", `${path}.enum_values`);
  const enumValues = value.enum_values.map((item, index) =>
    text(item, `${path}.enum_values[${index}]`, { min: 1, max: 256 }),
  );
  if (enumValues.length > 0) assertSortedUnique(enumValues, bytewise, `${path}.enum_values`);
  const min =
    value.min === null ? null : integer(value.min, `${path}.min`, Number.MIN_SAFE_INTEGER);
  const max =
    value.max === null ? null : integer(value.max, `${path}.max`, Number.MIN_SAFE_INTEGER);
  if (min !== null && max !== null && min > max)
    throw new CapabilityValidationError("input min exceeds max", path);
  const pattern = safePattern(value.pattern, `${path}.pattern`);
  const emptyShared = () => {
    if (enumValues.length || min !== null || max !== null)
      throw new CapabilityValidationError(
        "irrelevant input fields must be canonical empty/null",
        path,
      );
  };
  if (value.type === CAPABILITY_MANIFEST_INPUT_TYPE.STRING) {
    emptyShared();
    if (defaultValue !== null && typeof defaultValue !== "string")
      throw new CapabilityValidationError("string default has wrong type", `${path}.default_value`);
    if (typeof defaultValue === "string" && pattern && !patternMatches(pattern, defaultValue))
      throw new CapabilityValidationError(
        "string default fails its pattern",
        `${path}.default_value`,
      );
  } else if (value.type === CAPABILITY_MANIFEST_INPUT_TYPE.BOOLEAN) {
    emptyShared();
    if (pattern !== null || (defaultValue !== null && typeof defaultValue !== "boolean"))
      throw new CapabilityValidationError("boolean input has non-canonical fields", path);
  } else if (value.type === CAPABILITY_MANIFEST_INPUT_TYPE.INTEGER) {
    if (
      enumValues.length ||
      pattern !== null ||
      (defaultValue !== null && !Number.isSafeInteger(defaultValue))
    )
      throw new CapabilityValidationError("integer input has non-canonical fields", path);
    if (
      typeof defaultValue === "number" &&
      ((min !== null && defaultValue < min) || (max !== null && defaultValue > max))
    )
      throw new CapabilityValidationError(
        "integer default is outside bounds",
        `${path}.default_value`,
      );
  } else if (value.type === CAPABILITY_MANIFEST_INPUT_TYPE.ENUM) {
    if (enumValues.length === 0 || min !== null || max !== null || pattern !== null)
      throw new CapabilityValidationError("enum input has non-canonical fields", path);
    if (
      defaultValue !== null &&
      (typeof defaultValue !== "string" || !enumValues.includes(defaultValue))
    )
      throw new CapabilityValidationError("enum default is not declared", `${path}.default_value`);
  } else if (value.type === CAPABILITY_MANIFEST_INPUT_TYPE.PROJECT_PATH) {
    emptyShared();
    if (pattern !== null || (defaultValue !== null && typeof defaultValue !== "string"))
      throw new CapabilityValidationError("project-path input has non-canonical fields", path);
    if (typeof defaultValue === "string")
      canonicalRelativePrefix(defaultValue, `${path}.default_value`, false);
  } else if (
    defaultValue !== null ||
    enumValues.length ||
    min !== null ||
    max !== null ||
    pattern !== null
  ) {
    throw new CapabilityValidationError(
      "secret input cannot define a default or public constraints",
      path,
    );
  }
}

export function collectInputRefs(
  value: CapabilityTemplateValueV1,
  path: string,
  output: Array<{ id: string; path: string }>,
  depth = 0,
): void {
  if (depth > 32)
    throw new CapabilityValidationError("template nesting exceeds limit", path, "bounds");
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    text(value, path, { max: 8_192 });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024)
      throw new CapabilityValidationError("template array exceeds limit", path);
    value.forEach((item, index) => collectInputRefs(item, `${path}[${index}]`, output, depth + 1));
    return;
  }
  if (!value || typeof value !== "object")
    throw new CapabilityValidationError("invalid template value", path);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "input_ref") {
    output.push({
      id: localId((value as { input_ref: unknown }).input_ref, `${path}.input_ref`),
      path,
    });
    return;
  }
  if (keys.length > 1_024)
    throw new CapabilityValidationError("template object exceeds limit", path);
  for (const key of keys.sort(bytewise)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new CapabilityValidationError("forbidden template key", path);
    text(key, `${path}.${key}`, { min: 1, max: 256 });
    collectInputRefs(
      (value as Record<string, CapabilityTemplateValueV1>)[key] as CapabilityTemplateValueV1,
      `${path}.${key}`,
      output,
      depth + 1,
    );
  }
}

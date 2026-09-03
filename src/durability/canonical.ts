import { createHash } from "node:crypto";
import { durabilityError } from "./errors.js";
import { positiveSafeLimit } from "./limits.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CanonicalJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function assertUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        durabilityError("invalid_value", `${label} contains an unpaired high surrogate`);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      durabilityError("invalid_value", `${label} contains an unpaired low surrogate`);
    }
  }
}

interface RenderState {
  nodes: number;
  bytes: number;
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
  stack: Set<object>;
  output: string[];
}

function emit(state: RenderState, text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > state.maxBytes - state.bytes)
    durabilityError("bounds", "canonical JSON byte limit exceeded");
  state.bytes += bytes;
  state.output.push(text);
}

function renderString(value: string, label: string, state: RenderState): void {
  assertUnicode(value, label);
  emit(state, '"');
  let plain = "";
  const flush = () => {
    if (plain) emit(state, plain);
    plain = "";
  };
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    let escaped: string | null = null;
    if (character === '"') escaped = '\\"';
    else if (character === "\\") escaped = "\\\\";
    else if (code < 0x20) {
      escaped =
        ({ 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" } as Record<number, string>)[code] ??
        `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (escaped !== null) {
      flush();
      emit(state, escaped);
    } else {
      plain += character;
      if (plain.length >= 4_096) flush();
    }
  }
  flush();
  emit(state, '"');
}

function renderCanonical(value: unknown, depth: number, state: RenderState): void {
  state.nodes++;
  if (state.nodes > state.maxNodes) durabilityError("bounds", "canonical JSON node limit exceeded");
  if (depth > state.maxDepth) durabilityError("bounds", "canonical JSON depth limit exceeded");
  if (value === null) {
    emit(state, "null");
    return;
  }
  if (typeof value === "boolean") {
    emit(state, value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      durabilityError("invalid_value", "canonical JSON number is not finite");
    emit(state, JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    renderString(value, "canonical JSON string", state);
    return;
  }
  if (typeof value !== "object")
    durabilityError("invalid_value", `canonical JSON does not admit ${typeof value}`);
  if (state.stack.has(value)) durabilityError("invalid_value", "canonical JSON contains a cycle");
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key === "symbol" ||
            (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
        )
      )
        durabilityError("invalid_value", "canonical JSON array has an extra property");
      emit(state, "[");
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          durabilityError("invalid_value", "canonical JSON array is sparse or accessor-backed");
        if (index > 0) emit(state, ",");
        renderCanonical(descriptor.value, depth + 1, state);
      }
      emit(state, "]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      durabilityError("invalid_value", "canonical JSON object must have a plain prototype");
    const reflected = Reflect.ownKeys(value);
    if (reflected.some((key) => typeof key === "symbol"))
      durabilityError("invalid_value", "canonical JSON object has a symbol key");
    const keys = reflected as string[];
    for (const key of keys) {
      assertUnicode(key, "canonical JSON key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        durabilityError("invalid_value", "canonical JSON object has a hidden or accessor property");
    }
    keys.sort();
    emit(state, "{");
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      if (index > 0) emit(state, ",");
      renderString(key, "canonical JSON key", state);
      emit(state, ":");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      renderCanonical((descriptor as PropertyDescriptor).value, depth + 1, state);
    }
    emit(state, "}");
  } finally {
    state.stack.delete(value);
  }
}

export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const state: RenderState = {
    nodes: 0,
    bytes: 0,
    maxDepth: positiveSafeLimit(
      options.maxDepth ?? DEFAULT_MAX_DEPTH,
      "canonical JSON depth limit",
    ),
    maxNodes: positiveSafeLimit(options.maxNodes ?? DEFAULT_MAX_NODES, "canonical JSON node limit"),
    maxBytes: positiveSafeLimit(options.maxBytes ?? DEFAULT_MAX_BYTES, "canonical JSON byte limit"),
    stack: new Set(),
    output: [],
  };
  renderCanonical(value, 0, state);
  return state.output.join("");
}

export function canonicalJsonBytes(value: unknown, options?: CanonicalJsonOptions): Buffer {
  return Buffer.from(canonicalJson(value, options), "utf8");
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestHex(digest: string): string {
  if (!DIGEST_PATTERN.test(digest))
    durabilityError(
      "invalid_value",
      "digest must be sha256 plus 64 lowercase hexadecimal characters",
    );
  return digest.slice("sha256:".length);
}

function assertDigestDomain(domain: string): void {
  if (
    typeof domain !== "string" ||
    !domain.endsWith("\0v1\0") ||
    domain.length <= 4 ||
    Buffer.byteLength(domain, "utf8") > 256 ||
    [...domain].some((character) => character.charCodeAt(0) > 0x7f)
  )
    durabilityError(
      "invalid_value",
      "digest domain must be bounded ASCII ending in literal NUL-v1-NUL",
    );
}

export function digestV1Bytes(domain: string, bytes: Uint8Array): string {
  assertDigestDomain(domain);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  const hash = createHash("sha256");
  hash.update(Buffer.from(domain, "utf8"));
  hash.update(length);
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

export function digestV1(domain: string, value: unknown): string {
  return digestV1Bytes(domain, canonicalJsonBytes(value));
}

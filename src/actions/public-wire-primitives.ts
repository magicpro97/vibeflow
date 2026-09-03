const UTF8 = new TextEncoder();
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MILLISECOND_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const isPlainWireRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function hasExactWireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field)) &&
    keys.every((field) => field !== "__proto__" && field !== "prototype" && field !== "constructor")
  );
}

export const utf8WireBytes = (value: string): number => UTF8.encode(value).byteLength;

export function isBoundedWireText(
  value: unknown,
  options: { maxBytes: number; minBytes?: number; ascii?: boolean },
): value is string {
  if (typeof value !== "string" || value !== value.normalize("NFC")) return false;
  const bytes = utf8WireBytes(value);
  if (bytes < (options.minBytes ?? 1) || bytes > options.maxBytes) return false;
  if (options.ascii) return /^[\x21-\x7e]+$/u.test(value);
  return !/[\p{Cc}\p{Cf}]/u.test(value);
}

export const isBoundedWireIdentity = (value: unknown): value is string =>
  isBoundedWireText(value, { maxBytes: 512 });

export const isSha256WireDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);

export function isExactWireTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !MILLISECOND_ISO.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export const isNonnegativeSafeWireInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function compareUtf8Wire(left: string, right: string): number {
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function sameWireValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameWireValue(value, right[index]))
    );
  if (!isPlainWireRecord(left) || !isPlainWireRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(compareUtf8Wire);
  const rightKeys = Object.keys(right).sort(compareUtf8Wire);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.hasOwn(right, key) &&
        sameWireValue(left[key], right[key]),
    )
  );
}

export function isBoundedJsonWireValue(
  value: unknown,
  maxBytes: number,
  options: { maxDepth?: number; maxNodes?: number } = {},
): boolean {
  const state = { nodes: 0 };
  if (!isJsonWireValue(value, 0, state, options.maxDepth ?? 32, options.maxNodes ?? 16_384))
    return false;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && utf8WireBytes(encoded) <= maxBytes;
  } catch {
    return false;
  }
}

function isJsonWireValue(
  value: unknown,
  depth: number,
  state: { nodes: number },
  maxDepth: number,
  maxNodes: number,
): boolean {
  state.nodes += 1;
  if (state.nodes > maxNodes || depth > maxDepth) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonWireValue(item, depth + 1, state, maxDepth, maxNodes));
  if (!isPlainWireRecord(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    if (
      !isBoundedWireText(key, { maxBytes: 256 }) ||
      !isJsonWireValue(field, depth + 1, state, maxDepth, maxNodes)
    )
      return false;
  }
  return true;
}

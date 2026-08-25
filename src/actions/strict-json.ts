import type { JsonValue } from "./types.js";

export class ActionValidationError extends Error {
  readonly code: "invalid_request" | "unsupported_schema_version" | "target_unsupported";
  readonly path: string;

  constructor(
    message: string,
    path = "$",
    code: ActionValidationError["code"] = "invalid_request",
  ) {
    super(`${path}: ${message}`);
    this.name = "ActionValidationError";
    this.code = code;
    this.path = path;
  }
}

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_COLLECTION_ITEMS = 1_024;
const MAX_STRING_BYTES = 256 * 1024;

class StrictJsonParser {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly source: string) {
    if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES)
      throw new ActionValidationError("JSON body exceeds byte limit");
  }

  parse(): JsonValue {
    const result = this.value(0, "$", false);
    this.space();
    if (this.offset !== this.source.length)
      throw new ActionValidationError("unexpected trailing JSON", `$@${this.offset}`);
    return result;
  }

  private space(): void {
    while (/\s/u.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private value(depth: number, path: string, key: boolean): JsonValue {
    this.space();
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new ActionValidationError("JSON node limit exceeded", path);
    if (depth > MAX_DEPTH) throw new ActionValidationError("JSON depth limit exceeded", path);
    const char = this.source[this.offset];
    if (char === "{") return this.object(depth + 1, path);
    if (char === "[") return this.array(depth + 1, path);
    if (char === '"') return this.string(path, key);
    if (this.source.startsWith("true", this.offset)) {
      this.offset += 4;
      return true;
    }
    if (this.source.startsWith("false", this.offset)) {
      this.offset += 5;
      return false;
    }
    if (this.source.startsWith("null", this.offset)) {
      this.offset += 4;
      return null;
    }
    const number = this.source
      .slice(this.offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) throw new ActionValidationError("invalid JSON value", `${path}@${this.offset}`);
    this.offset += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) throw new ActionValidationError("number must be finite", path);
    return parsed;
  }

  private string(path: string, key: boolean): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      this.offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        let decoded: unknown;
        try {
          decoded = JSON.parse(this.source.slice(start, this.offset));
        } catch {
          throw new ActionValidationError("invalid JSON string", path);
        }
        if (typeof decoded !== "string") throw new ActionValidationError("invalid string", path);
        if (Buffer.byteLength(decoded, "utf8") > MAX_STRING_BYTES)
          throw new ActionValidationError("string exceeds byte limit", path);
        if (key && POLLUTION_KEYS.has(decoded))
          throw new ActionValidationError("prototype-pollution key is forbidden", path);
        return decoded;
      }
      if ((char?.charCodeAt(0) ?? 32) < 32)
        throw new ActionValidationError("unescaped control character", path);
    }
    throw new ActionValidationError("unterminated JSON string", path);
  }

  private object(depth: number, path: string): JsonValue {
    this.offset += 1;
    const output: Record<string, JsonValue> = {};
    const keys = new Set<string>();
    this.space();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return output;
    }
    while (true) {
      this.space();
      if (this.source[this.offset] !== '"')
        throw new ActionValidationError("object key must be a string", path);
      const name = this.string(path, true);
      if (keys.has(name))
        throw new ActionValidationError(`duplicate key ${JSON.stringify(name)}`, path);
      keys.add(name);
      if (keys.size > MAX_COLLECTION_ITEMS)
        throw new ActionValidationError("object field limit exceeded", path);
      this.space();
      if (this.source[this.offset] !== ":")
        throw new ActionValidationError("missing colon after object key", path);
      this.offset += 1;
      output[name] = this.value(depth, `${path}.${name}`, false);
      this.space();
      const delimiter = this.source[this.offset];
      this.offset += 1;
      if (delimiter === "}") return output;
      if (delimiter !== ",") throw new ActionValidationError("invalid object delimiter", path);
    }
  }

  private array(depth: number, path: string): JsonValue {
    this.offset += 1;
    const output: JsonValue[] = [];
    this.space();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return output;
    }
    while (true) {
      if (output.length >= MAX_COLLECTION_ITEMS)
        throw new ActionValidationError("array item limit exceeded", path);
      output.push(this.value(depth, `${path}[${output.length}]`, false));
      this.space();
      const delimiter = this.source[this.offset];
      this.offset += 1;
      if (delimiter === "]") return output;
      if (delimiter !== ",") throw new ActionValidationError("invalid array delimiter", path);
    }
  }
}

export function parseStrictJson(source: string): JsonValue {
  return new StrictJsonParser(source).parse();
}

export function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "$",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ActionValidationError("expected object", path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ActionValidationError("object prototype is forbidden", path);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (POLLUTION_KEYS.has(key))
      throw new ActionValidationError("prototype-pollution key is forbidden", `${path}.${key}`);
    if (!allowed.has(key))
      throw new ActionValidationError(`unknown field ${JSON.stringify(key)}`, path);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key))
      throw new ActionValidationError(`missing field ${JSON.stringify(key)}`, path);
  }
  return record;
}

export function boundedString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; control?: boolean } = {},
): string {
  if (typeof value !== "string") throw new ActionValidationError("expected string", path);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < (options.min ?? 1) || bytes > (options.max ?? 4_096))
    throw new ActionValidationError("string byte length is out of bounds", path);
  if (options.control !== true && /\p{Cc}/u.test(value))
    throw new ActionValidationError("control characters are forbidden", path);
  return value;
}

export function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new ActionValidationError("expected bounded non-negative integer", path);
  return value as number;
}

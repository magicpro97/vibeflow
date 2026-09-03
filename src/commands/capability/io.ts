import { lstatSync, readFileSync } from "node:fs";
import { ActionValidationError, parseStrictJson } from "../../actions/strict-json.js";
import { CapabilityCliUsageError } from "./parser-types.js";

const MAX_JSON_BYTES = 1024 * 1024;

function decodeUtf8(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_JSON_BYTES)
    throw new ActionValidationError(`${label} exceeds byte limit`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ActionValidationError(`${label} must be valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff)
    throw new ActionValidationError(`${label} must not start with a UTF-8 BOM`);
  return text;
}

function safeFileOperation<T>(label: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")
      throw new CapabilityCliUsageError(`${label} could not be read`);
    throw error;
  }
}

export function readStrictJsonFile(path: string, label = "JSON request file"): unknown {
  const stat = safeFileOperation(label, () => lstatSync(path));
  if (stat.isSymbolicLink())
    throw new CapabilityCliUsageError(`${label} must reference a regular file, not a symlink`);
  if (!stat.isFile()) throw new CapabilityCliUsageError(`${label} must reference a regular file`);
  return parseStrictJson(
    decodeUtf8(
      safeFileOperation(label, () => readFileSync(path)),
      label,
    ),
  );
}

export function readStrictJsonStdin(
  reader: (() => Uint8Array | string) | undefined,
  label = "standard input",
): unknown {
  const raw = reader ? reader() : readFileSync(0);
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  return parseStrictJson(decodeUtf8(bytes, label));
}

export function readStrictJsonSource(
  path: string,
  reader: (() => Uint8Array | string) | undefined,
  label: string,
): unknown {
  return path === "-" ? readStrictJsonStdin(reader, label) : readStrictJsonFile(path, label);
}

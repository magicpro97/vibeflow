import { inTreePath } from "../manifest/validation-helpers.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  rawSha256,
} from "../wire/primitives.js";

export interface ArchiveEntryDescriptorV1 {
  path: string;
  kind: "file" | "directory" | "symlink" | "hardlink" | "device" | "socket";
  expanded_size: number;
  transport_sha256: string | null;
}

export function validateArchiveEntries(entries: readonly ArchiveEntryDescriptorV1[]): void {
  if (entries.length > 10_000)
    throw new CapabilityValidationError("archive entry count exceeds limit", "entries", "bounds");
  let total = 0;
  const files: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = inTreePath(entry.path, `entries[${index}].path`);
    if (entry.kind !== "file" && entry.kind !== "directory")
      throw new CapabilityValidationError(
        "archive link or special entry is forbidden",
        `entries[${index}].kind`,
      );
    if (
      !Number.isSafeInteger(entry.expanded_size) ||
      entry.expanded_size < 0 ||
      entry.expanded_size > 16 * 1024 * 1024
    )
      throw new CapabilityValidationError(
        "archive entry size exceeds limit",
        `entries[${index}].expanded_size`,
        "bounds",
      );
    total += entry.expanded_size;
    if (entry.kind === "file") {
      if (entry.transport_sha256 === null)
        throw new CapabilityValidationError("file transport hash is required", `entries[${index}]`);
      rawSha256(entry.transport_sha256, `entries[${index}].transport_sha256`);
      files.push(path);
    } else if (entry.transport_sha256 !== null || entry.expanded_size !== 0) {
      throw new CapabilityValidationError(
        "directory archive entry must be canonical empty",
        `entries[${index}]`,
      );
    }
  }
  if (total > 64 * 1024 * 1024)
    throw new CapabilityValidationError("expanded archive exceeds limit", "entries", "bounds");
  files.sort(bytewise);
  assertSortedUnique(files, bytewise, "entries");
}

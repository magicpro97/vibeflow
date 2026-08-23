export const TRACE_LIMITS = {
  maxTextBytes: 64 * 1024,
  maxReferenceBytes: 4 * 1024,
  maxArrayItems: 512,
  maxRecordBytes: 512 * 1024,
  maxJournalBytes: 16 * 1024 * 1024,
  maxDepth: 32,
} as const;

export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

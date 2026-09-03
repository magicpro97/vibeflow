export function decodeConversationManifest(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid manifest JSON");
  }
}

export function conversationManifestVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = (value as Record<string, unknown>).manifest;
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).version
    : undefined;
}

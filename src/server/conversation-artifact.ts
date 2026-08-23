import type { ArtifactRegistry } from "../orchestrator/trace/artifacts.js";

const OPAQUE_ARTIFACT = /^artifact_[A-Za-z0-9_-]{43}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface ConversationArtifactAuthority {
  registry: Pick<ArtifactRegistry, "resolve">;
  store: {
    readArtifactRef(conversationId: string, internalRef: string): Uint8Array | null;
  };
}

const missing = (): Response => Response.json({ code: "artifact_not_found" }, { status: 404 });

/** Resolve public identity first; only the verified durable store may read bytes. */
export async function handleConversationArtifact(
  authority: ConversationArtifactAuthority,
  conversationId: string,
  opaqueId: string,
): Promise<Response> {
  if (!conversationId || !OPAQUE_ARTIFACT.test(opaqueId)) return missing();
  try {
    const resolution = authority.registry.resolve(conversationId, opaqueId);
    if (!resolution || !/^vf-artifact-[0-9a-f]{64}$/.test(resolution.internalRef)) return missing();
    const content = authority.store.readArtifactRef(conversationId, resolution.internalRef);
    if (!content?.length || content.length > MAX_ARTIFACT_BYTES) return missing();
    return new Response(content, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${opaqueId}.bin"`,
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "artifact_read_failed" }, { status: 500 });
  }
}

import type { ArtifactRegistryPreparation, RebuildableArtifactRegistry } from "./artifacts.js";
import type { InternalTraceStoreRecord } from "./types.js";

/** Once the journal is fsynced it is authoritative; registry recovery is best effort. */
export function settleDurableRegistry(
  prepared: ArtifactRegistryPreparation | undefined,
  registry: Partial<RebuildableArtifactRegistry> | undefined,
  conversationId: string,
  records: readonly InternalTraceStoreRecord[],
): void {
  if (!prepared) return;
  try {
    prepared.commit();
  } catch {
    try {
      prepared.rollback();
    } catch {}
    try {
      if (typeof registry?.rebuildConversation === "function") {
        registry.rebuildConversation(conversationId, records);
      } else if (typeof registry?.rebuild === "function") {
        registry.rebuild(records);
      }
    } catch {}
  }
}

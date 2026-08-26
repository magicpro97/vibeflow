import { digestV1 } from "../../durability/index.js";

export function lineageStorageKey(rootSessionId: string): string {
  return digestV1("VF-LINEAGE-STORAGE-KEY\0v1\0", {
    schema_version: "1.0",
    root_session_id: rootSessionId,
  });
}

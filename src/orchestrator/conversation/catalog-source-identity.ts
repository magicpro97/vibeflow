import type { ConversationDurableRecord } from "./artifact-validation.js";
import {
  type ConversationSourceDiagnosticV1,
  diagnostic,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

export function hasSafeCatalogSourceIdentities(record: ConversationDurableRecord): boolean {
  const identities = [
    record.manifest.conversation_id,
    record.manifest.revision_id,
    record.manifest.parent_conversation_id,
    record.manifest.parent_revision_id,
    ...Object.values(record.child_revisions),
  ];
  return identities.every((identity) => identity === null || isSafeCatalogIdentifier(identity));
}

export function unsafeCatalogSourceIdentityDiagnostic(
  recordId: string,
): ConversationSourceDiagnosticV1 {
  return diagnostic(
    "invalid-manifest",
    "conversation-manifest",
    recordId,
    "manifest contains an unsafe public identity",
  );
}

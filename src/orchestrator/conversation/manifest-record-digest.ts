/**
 * The durable conversation manifest record digest, and the one digest form an upgrade can leave
 * behind inside it.
 *
 * `assertConversationManifest` injects `project_id` in place on read, so a record written before
 * conversations were bound to a project hashes to a different value once normalized — while every
 * digest persisted *about* that record at the time (`visibility.manifest_record_digest`, or a
 * digest handed back into `ConversationRevisionArtifactStore.prepare`) was taken over the record as
 * it lay on disk. Comparing only the current form makes such a record look changed, and fails a
 * revision that was prepared-but-unpublished at upgrade time with "prepared revision manifest
 * digest mismatch" / "published revision artifact authority changed" / "committed revision
 * publication closure changed".
 *
 * Lives in its own leaf so the artifact store, the revision source, and both deferred-commit
 * validators share one rule — importing it from `revision-source` would cycle (the artifact store
 * is what `revision-source` reads through).
 */
import { digestV1 } from "../../durability/index.js";
import type { ConversationDurableRecord } from "./artifact-validation.js";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "./conversation-catalog-contract.js";

/** Domain separation of a durable manifest record digest; its producer and matcher share it. */
export const MANIFEST_RECORD_DOMAIN = "VF-CONVERSATION-MANIFEST-RECORD\0v1\0";

/**
 * Does a recomputed manifest record digest match one persisted by an earlier build?
 *
 * `record` is the record *as the digest producer builds it* (`revisionManifestRecord`, or the
 * inline record `ConversationRevisionArtifactStore.prepare` hashes) — not the raw stored record,
 * whose `resume_bindings`/`artifacts`/`child_revisions` are not part of what was hashed.
 *
 * The legacy preimage (that record with the injected field removed) is accepted only where the
 * injected value is the reserved default, so the tolerance cannot mask a real change: a record
 * actually filed into another project has no legacy form here, and a digest that matches neither
 * form is still a mismatch.
 */
export function manifestRecordDigestMatches(
  persisted: string,
  record: ConversationDurableRecord,
): boolean {
  if (digestV1(MANIFEST_RECORD_DOMAIN, record) === persisted) return true;
  if (record.manifest.project_id !== CONVERSATION_DEFAULT_PROJECT_ID) return false;
  const { project_id: _projectId, ...legacyManifest } = record.manifest;
  return digestV1(MANIFEST_RECORD_DOMAIN, { ...record, manifest: legacyManifest }) === persisted;
}

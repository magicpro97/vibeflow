import * as fs from "node:fs";
import { basename } from "node:path";
import { digestV1 } from "../../durability/index.js";
import { auditJournal } from "../trace/journal-cursor.js";
import { traceJournalPath } from "../trace/store.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
} from "../trace/types.js";
import {
  type ConversationDurableRecord,
  assertConversationDurableRecord,
} from "./artifact-validation.js";
import {
  isSafeCatalogIdentifier,
  projectPublicParticipantSummaries,
  safePublicRoleReference,
} from "./catalog-public.js";
import type {
  ConversationJournalHeadV1,
  ConversationSourceInventoryV1,
  ValidatedConversationSourceV1,
} from "./catalog-source-types.js";
export type {
  ConversationJournalHeadV1,
  ConversationSourceInventoryV1,
  ValidatedConversationSourceV1,
} from "./catalog-source-types.js";
import {
  type PrivateDirectorySnapshotV1,
  type PrivateFileSnapshotV1,
  assertPrivateDirectorySnapshot,
  assertPrivateFileSnapshot,
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  openPrivateChildDirectoryReadOnly,
  readPrivateDirectoryNames,
  readPrivateFileBytesAt,
  tryOpenPrivateFileReadOnlyAt,
} from "./catalog-read-safety.js";
import {
  hasSafeCatalogSourceIdentities,
  unsafeCatalogSourceIdentityDiagnostic,
} from "./catalog-source-identity.js";
import type { PublicParticipantSummaryV1 } from "./catalog-types.js";
import { conversationManifestPath } from "./durable-operation-authority.js";
import { foldConversation } from "./fold.js";
import {
  type ConversationSourceDiagnosticV1,
  compareConversationDiagnostics,
  diagnostic,
} from "./lineage-types.js";

const MANIFEST_NAME = /^[0-9a-f]{64}\.json$/;

export interface ReadConversationSourceInventoryOptions {
  artifactRoot: string;
  traceRoot: string;
}

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

function decodeManifest(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid manifest JSON");
  }
}

function manifestVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = (value as Record<string, unknown>).manifest;
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).version
    : undefined;
}

function foldOnlyJournal(records: readonly InternalTraceStoreRecord[]): {
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
} {
  const projected = records.map((record) => {
    const stored = structuredClone(record.stored_event) as unknown as Record<string, unknown>;
    const event = stored.event as { type: string; payload: Record<string, unknown> };
    if (event.type === "capability_action_projection") {
      stored.event = { type: "coordinator_decision", payload: { projection_only: true } };
    }
    const publicSessionRef =
      record.native_session_id === null
        ? null
        : event.type === "native_history_reconciled" &&
            typeof event.payload.public_session_ref === "string"
          ? event.payload.public_session_ref
          : "vf-fold-session";
    return { ...stored, public_session_ref: publicSessionRef } as unknown as PublicStoredTraceEvent;
  });
  const folded = foldConversation(projected);
  return { lifecycle: folded.lifecycle, health: folded.health };
}

function validateJournal(
  snapshot: PrivateFileSnapshotV1,
  record: ConversationDurableRecord,
): { head: ConversationJournalHeadV1; records: InternalTraceStoreRecord[] } {
  const id = record.manifest.conversation_id;
  let records: InternalTraceStoreRecord[];
  try {
    records = auditJournal(snapshot.fd, false, id).records;
    assertPrivateFileSnapshot(snapshot);
  } finally {
    fs.closeSync(snapshot.fd);
  }
  const manifest = record.manifest;
  if (
    records.some(
      ({ stored_event: event }) =>
        event.revision_id !== manifest.revision_id ||
        event.workflow_id !== manifest.workflow_id ||
        event.run_id !== manifest.run_id,
    )
  )
    throw new Error("journal correlation does not match manifest");
  let participants: PublicParticipantSummaryV1[];
  let lifecycle: ConversationLifecycle = "INIT";
  let health: ConversationHealth = "healthy";
  if (records.length) {
    const configured = records[0]?.stored_event.event;
    if (
      configured?.type !== "conversation_configured" ||
      configured.payload.topic !== manifest.topic ||
      configured.payload.policy !== manifest.policy ||
      configured.payload.max_rounds !== manifest.max_rounds
    )
      throw new Error("journal configuration does not match manifest");
    const configuredById = new Map(
      configured.payload.participants.map((participant) => [
        participant.participant_id,
        participant,
      ]),
    );
    if (
      configuredById.size !== manifest.bindings.length ||
      record.binding_authorities.some((authority) => {
        const participant = configuredById.get(authority.participant_id);
        const binding = manifest.bindings.find(
          (candidate) => candidate.participant_id === authority.participant_id,
        );
        return (
          !participant ||
          !binding ||
          participant.engine !== authority.engine ||
          participant.model !== authority.model ||
          participant.role_ref !== binding.input.roleRef ||
          !isSafeCatalogIdentifier(participant.participant_id)
        );
      })
    )
      throw new Error("journal participants do not match manifest authority");
    participants = projectPublicParticipantSummaries(configured.payload.participants);
    ({ lifecycle, health } = foldOnlyJournal(records));
  } else {
    participants = record.binding_authorities
      .map((authority, index) => ({
        participant_id: authority.participant_id,
        role_ref: safePublicRoleReference(manifest.bindings[index]?.input.roleRef ?? "unavailable"),
        engine: authority.engine,
        model: authority.model,
      }))
      .sort((left, right) => compareBytes(left.participant_id, right.participant_id));
  }
  let previousRecordDigest: string | null = null;
  for (const item of records) {
    previousRecordDigest = digestV1("VF-CONVERSATION-CATALOG-JOURNAL-RECORD\0v1\0", {
      schema_version: "1.0",
      conversation_id: id,
      previous_record_digest: previousRecordDigest,
      record: item,
    });
  }
  const last = records.at(-1)?.stored_event;
  const recordDigest = digestV1("VF-CONVERSATION-CATALOG-JOURNAL-HEAD\0v1\0", {
    schema_version: "1.0",
    conversation_id: id,
    revision_id: manifest.revision_id,
    last_seq: last?.seq ?? 0,
    last_record_digest: previousRecordDigest,
    bytes_length: snapshot.size,
  });
  return {
    head: {
      schema_version: "1.0",
      record_id: id,
      record_digest: recordDigest,
      last_seq: last?.seq ?? 0,
      updated_at: last?.ts ?? manifest.created_at,
      lifecycle,
      health,
      participants,
    },
    records: structuredClone(records),
  };
}

function addManifest(
  artifactRoot: string,
  traceRoot: string,
  artifactDirectory: PrivateDirectorySnapshotV1,
  journalDirectory: PrivateDirectorySnapshotV1 | null,
  name: string,
  sources: ValidatedConversationSourceV1[],
  diagnostics: ConversationSourceDiagnosticV1[],
): void {
  if (!MANIFEST_NAME.test(name)) {
    diagnostics.push(
      diagnostic(
        "invalid-manifest-filename",
        "conversation-manifest",
        name,
        "manifest filename is not a lowercase hash",
      ),
    );
    return;
  }
  let decoded: unknown;
  try {
    decoded = decodeManifest(readPrivateFileBytesAt(artifactDirectory, name, 512 * 1024));
  } catch {
    diagnostics.push(
      diagnostic(
        "invalid-manifest",
        "conversation-manifest",
        name,
        "manifest is unreadable or malformed",
      ),
    );
    return;
  }
  const version = manifestVersion(decoded);
  if (version !== "1.0") {
    diagnostics.push(
      diagnostic(
        typeof version === "string" ? "unsupported-schema-version" : "invalid-manifest",
        "conversation-manifest",
        name,
        typeof version === "string"
          ? "manifest schema is unsupported and remains read-only"
          : "manifest does not declare a supported schema",
      ),
    );
    return;
  }
  try {
    assertConversationDurableRecord(decoded, undefined, true);
  } catch {
    diagnostics.push(
      diagnostic(
        "invalid-manifest",
        "conversation-manifest",
        name,
        "manifest failed strict validation",
      ),
    );
    return;
  }
  const record = decoded as ConversationDurableRecord;
  if (!hasSafeCatalogSourceIdentities(record)) {
    diagnostics.push(unsafeCatalogSourceIdentityDiagnostic(name));
    return;
  }
  const id = record.manifest.conversation_id;
  if (basename(conversationManifestPath(artifactRoot, id)) !== name) {
    diagnostics.push(
      diagnostic(
        "invalid-manifest-filename",
        "conversation-manifest",
        name,
        "manifest identity does not match its hashed filename",
      ),
    );
    return;
  }
  const journalName = basename(traceJournalPath(traceRoot, id));
  const journal =
    journalDirectory?.state === "valid"
      ? tryOpenPrivateFileReadOnlyAt(journalDirectory, journalName, 16 * 1024 * 1024, true)
      : null;
  if (!journal) {
    diagnostics.push(
      diagnostic(
        "missing-journal",
        "conversation-journal",
        id,
        "manifest has no existing journal; no journal was created",
      ),
    );
    return;
  }
  try {
    const validatedJournal = validateJournal(journal, record);
    sources.push({
      manifest: structuredClone(record.manifest),
      manifest_record: structuredClone(record),
      manifest_digest: digestV1("VF-CONVERSATION-MANIFEST-RECORD\0v1\0", record),
      journal_head: validatedJournal.head,
      journal_records: validatedJournal.records,
    });
  } catch (error) {
    const mismatch = error instanceof Error && error.message.includes("match manifest");
    diagnostics.push(
      diagnostic(
        mismatch ? "manifest-journal-mismatch" : "invalid-journal",
        "conversation-journal",
        id,
        mismatch ? "journal does not match manifest authority" : "journal is unreadable or invalid",
      ),
    );
  }
}

export function readConversationSourceInventory(
  options: ReadConversationSourceInventoryOptions,
): ConversationSourceInventoryV1 {
  const sources: ValidatedConversationSourceV1[] = [];
  const diagnostics: ConversationSourceDiagnosticV1[] = [];
  const artifactRoot = inspectPrivateDirectoryReadOnly(options.artifactRoot);
  const traceRoot = inspectPrivateDirectoryReadOnly(options.traceRoot);
  let journalDirectory: PrivateDirectorySnapshotV1 | null = null;
  try {
    if (artifactRoot.state === "invalid" || traceRoot.state === "invalid") {
      diagnostics.push(
        diagnostic("invalid-source-root", "inventory", null, "conversation source root is unsafe"),
      );
    } else if (artifactRoot.state === "valid") {
      if (traceRoot.state === "valid") {
        journalDirectory = openPrivateChildDirectoryReadOnly(traceRoot, "conversations");
        if (journalDirectory.state === "invalid")
          throw new Error("unsafe conversation journal directory");
      }
      assertPrivateDirectorySnapshot(artifactRoot);
      if (traceRoot.state === "valid") assertPrivateDirectorySnapshot(traceRoot);
      for (const name of readPrivateDirectoryNames(artifactRoot)) {
        if (!name.endsWith(".json")) continue;
        addManifest(
          artifactRoot.path,
          traceRoot.path,
          artifactRoot,
          journalDirectory,
          name,
          sources,
          diagnostics,
        );
      }
      assertPrivateDirectorySnapshot(artifactRoot);
      if (traceRoot.state === "valid") assertPrivateDirectorySnapshot(traceRoot);
    }
  } catch {
    sources.length = 0;
    diagnostics.push(
      diagnostic(
        "invalid-source-root",
        "inventory",
        null,
        "conversation source changed while read",
      ),
    );
  } finally {
    if (journalDirectory) closePrivateDirectorySnapshot(journalDirectory);
    closePrivateDirectorySnapshot(traceRoot);
    closePrivateDirectorySnapshot(artifactRoot);
  }
  sources.sort((left, right) =>
    compareBytes(left.manifest.conversation_id, right.manifest.conversation_id),
  );
  diagnostics.sort(compareConversationDiagnostics);
  const observedSourceDigest = digestV1("VF-CONVERSATION-OBSERVED-SOURCE-INVENTORY\0v1\0", {
    schema_version: "1.0",
    sources: sources.map((source) => ({
      conversation_id: source.manifest.conversation_id,
      manifest_digest: source.manifest_digest,
      journal_head_digest: source.journal_head.record_digest,
    })),
    degraded: diagnostics.length > 0,
  });
  const state = diagnostics.length ? "degraded" : sources.length ? "ready" : "empty";
  return {
    schema_version: "1.0",
    state,
    authoritative: state !== "degraded",
    sources,
    diagnostics,
    observed_source_digest: observedSourceDigest,
  };
}

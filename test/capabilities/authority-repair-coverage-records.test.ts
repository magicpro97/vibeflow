import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AuthorityRepairArtifactStoreV1,
  AUTHORITY_REPAIR_CONTENT_TARGET_KIND as C,
  AUTHORITY_REPAIR_DIGEST_DOMAIN as DD,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND as J,
  AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND as JS,
  AUTHORITY_REPAIR_STRATEGY as S,
  assertAuthorityEpochRepairBase,
  assertAuthorityRepairSteps,
  authorityRepairDigestObjectPath,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairLostTailDigest,
  authorityRepairProposedRestoredDigest,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  materializeAuthorityEpochRepairBase,
  materializeAuthorityRepairAbsenceEvidence,
  materializeAuthorityRepairSteps,
  planAuthorityRepair,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityEpochRepairBaseV1,
  AuthorityRepairJournalSourceSelectorV1,
  AuthorityRepairPlanningCandidateV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";
import {
  assertJournalSource,
  assertNonCompoundLocator,
  assertTargetPreimage,
} from "../../src/capabilities/authority-repair/validation.js";
import { acquireProcessLock, canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
const createdAt = "2026-08-28T03:00:00.000Z";
const digest = (label: string) => digestV1("VF-REPAIR-COVERAGE\0v1\0", { label });
const raw = (label: string) => createHash("sha256").update(label).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function epochBase(recoverySource = false, lostTail = false): AuthorityEpochRepairBaseV1 {
  const scopeId = digest("epoch-scope");
  const journalIdentity = digest("epoch-journal");
  const headCorrupt = raw("head-corrupt");
  const headRestored = raw("head-restored");
  const eventCorrupt = raw("event-corrupt");
  const eventRestored = raw("event-restored");
  const lastValid = digest("event-last-valid");
  const sourceSelector: AuthorityRepairJournalSourceSelectorV1 = recoverySource
    ? {
        kind: JS.RECOVERY_GENERATION,
        expected_current_pointer_digest: digest("selected-pointer"),
        generation_id: "generation-selected-1",
        generation_digest: digest("selected-generation"),
      }
    : { kind: JS.CANONICAL };
  const headQuarantine = digestV1(DD.QUARANTINE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: "project",
    scope_id: scopeId,
    journal_identity_digest: journalIdentity,
    corrupt_bytes_sha256: headCorrupt,
  });
  const headRestore = digestV1(DD.RESTORE_SOURCE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: "project",
    scope_id: scopeId,
    journal_identity_digest: journalIdentity,
    restore_bytes_sha256: headRestored,
    last_valid_record_digest: lastValid,
  });
  const eventLostSha = lostTail ? raw("event-lost") : null;
  const eventLostDigest = lostTail
    ? digestV1(DD.LOST_TAIL, {
        corrupt_bytes_sha256: eventCorrupt,
        last_valid_record_digest: lastValid,
        lost_tail_sha256: eventLostSha,
      })
    : null;
  return materializeAuthorityEpochRepairBase({
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    authority_scope: "project",
    scope_id: scopeId,
    head_corrupt_bytes_sha256: headCorrupt,
    head_quarantine_ref: headQuarantine,
    head_restore_source_ref: headRestore,
    restored_head_bytes_sha256: headRestored,
    restored_head_digest: digest("restored-head"),
    head_expected_current_pointer_digest: digestV1(DD.JSON_HEAD_CURRENT, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "authority-epoch",
      authority_scope: "project",
      scope_id: scopeId,
      current_bytes_sha256: headCorrupt,
    }),
    head_replacement_pointer_digest: digestV1(DD.JSON_HEAD_CURRENT, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "authority-epoch",
      authority_scope: "project",
      scope_id: scopeId,
      current_bytes_sha256: headRestored,
    }),
    event_journal_identity_digest: journalIdentity,
    event_source_selector: sourceSelector,
    event_corrupt_bytes_sha256: eventCorrupt,
    event_quarantine_ref: digestV1(DD.QUARANTINE, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "authority-epoch",
      authority_scope: "project",
      scope_id: scopeId,
      journal_identity_digest: journalIdentity,
      corrupt_bytes_sha256: eventCorrupt,
    }),
    event_restore_source_ref: digestV1(DD.RESTORE_SOURCE, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "authority-epoch",
      authority_scope: "project",
      scope_id: scopeId,
      journal_identity_digest: journalIdentity,
      restore_bytes_sha256: eventRestored,
      last_valid_record_digest: lastValid,
    }),
    event_restore_bytes_sha256: eventRestored,
    event_last_valid_record_digest: lastValid,
    event_lost_tail_sha256: eventLostSha,
    event_lost_tail_digest: eventLostDigest,
    event_expected_current_pointer_digest: recoverySource ? digest("selected-pointer") : null,
    event_repair_base_generation_digest: digest("repair-generation"),
    event_repair_base_pointer_digest: digest("repair-pointer"),
  });
}

function journalSteps(): AuthorityRepairStepsV1 {
  const draft: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "conversation-journal",
    authority_scope: "conversation",
    scope_id: "root-session-journal-1",
    strategy: S.NEW_JOURNAL_GENERATION,
    target_locator: {
      strategy: S.NEW_JOURNAL_GENERATION,
      journal_identity_digest: digest("conversation-journal"),
      source_selector: { kind: JS.CANONICAL },
    },
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: raw("journal-corrupt"),
      quarantine_ref: "",
      absence_evidence_digest: null,
    },
    restore_source_ref: "",
    restore_bytes_sha256: raw("journal-restore"),
    last_valid_record_digest: digest("journal-last-valid"),
    lost_tail_sha256: raw("journal-lost-tail"),
    lost_tail_digest: null,
    expected_current_pointer_digest: null,
    replacement_current_pointer_digest: digest("replacement-pointer"),
    recovery_link_digest: digest("recovery-link"),
    journal_identity_digest: digest("conversation-journal"),
    authority_epoch_repair_base_digest: null,
  };
  draft.target_preimage.quarantine_ref = authorityRepairQuarantineRef(draft) as string;
  draft.restore_source_ref = authorityRepairRestoreSourceRef(draft);
  draft.lost_tail_digest = authorityRepairLostTailDigest(draft);
  return materializeAuthorityRepairSteps(draft);
}

function compoundSteps(base: AuthorityEpochRepairBaseV1): AuthorityRepairStepsV1 {
  if (!base.event_last_valid_record_digest)
    throw new Error("compound fixture requires an event prefix");
  return materializeAuthorityRepairSteps({
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: base.authority_scope,
    scope_id: base.scope_id,
    strategy: S.REPLACE_AUTHORITY_EPOCH_COMPOUND,
    target_locator: null,
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: base.head_corrupt_bytes_sha256,
      quarantine_ref: base.head_quarantine_ref,
      absence_evidence_digest: null,
    },
    restore_source_ref: base.head_restore_source_ref,
    restore_bytes_sha256: base.restored_head_bytes_sha256,
    last_valid_record_digest: base.event_last_valid_record_digest,
    lost_tail_sha256: base.event_lost_tail_sha256,
    lost_tail_digest: base.event_lost_tail_digest,
    expected_current_pointer_digest: base.event_expected_current_pointer_digest,
    replacement_current_pointer_digest: base.event_repair_base_pointer_digest,
    recovery_link_digest: base.event_repair_base_generation_digest,
    journal_identity_digest: base.event_journal_identity_digest,
    authority_epoch_repair_base_digest: base.base_digest,
  });
}

describe("authority repair validators and epoch records", () => {
  test("validates canonical and selected-generation epoch bases and detects tamper", () => {
    const canonical = epochBase();
    const selected = epochBase(true, true);
    expect(assertAuthorityEpochRepairBase(canonical)).toEqual(canonical);
    expect(assertAuthorityEpochRepairBase(selected)).toEqual(selected);
    const tampered = { ...selected, event_restore_source_ref: digest("tampered") };
    expect(() => assertAuthorityEpochRepairBase(tampered)).toThrow(/derived pointer|evidence/);
    expect(() =>
      assertAuthorityEpochRepairBase({ ...selected, event_lost_tail_digest: null }),
    ).toThrow(/lost-tail/);
  });

  test("exercises every JSON, journal, and content locator shape", () => {
    const jsonTargets: unknown[] = [
      { kind: J.CONVERSATION_MANIFEST, conversation_id: "conversation-1" },
      { kind: J.LINEAGE_HEAD, root_session_id: "root-1", lineage_storage_key: "lineage-1" },
      {
        kind: J.LINEAGE_RESERVATION,
        root_session_id: "root-1",
        lineage_storage_key: "lineage-1",
      },
      { kind: J.CAPABILITY_LOCK, scope: "project", scope_identity_digest: digest("scope") },
      { kind: J.AUTHORITY_EPOCH_ZERO_HEAD, scope: "user", scope_identity_digest: digest("user") },
      { kind: J.SCOPE_IDENTITY, scope: "project" },
    ];
    for (const target of jsonTargets)
      expect(() =>
        assertNonCompoundLocator({ strategy: S.REPLACE_JSON_HEAD, target }),
      ).not.toThrow();

    const contentTargets: unknown[] = [
      {
        kind: C.CONVERSATION_OBJECT,
        object_schema_id: "conversation/1",
        record_digest: digest("1"),
      },
      {
        kind: C.AUTHORITY_REPAIR_OBJECT,
        object_schema_id: "vf.authority-repair-steps/1",
        record_digest: digest("2"),
      },
      { kind: C.CAPABILITY_OBJECT, object_schema_id: "capability/1", record_digest: digest("3") },
      { kind: C.LINEAGE_ASSOCIATION, association_id: "association-1", record_digest: digest("4") },
      {
        kind: C.REVISION_OPERATION_HEADER,
        operation_id: "operation-1",
        record_digest: digest("5"),
      },
      {
        kind: C.CAPABILITY_OPERATION_HEADER,
        operation_id: "operation-2",
        record_digest: digest("6"),
      },
      {
        kind: C.AUTHORITY_CHANGE_OPERATION_HEADER,
        operation_id: "operation-3",
        record_digest: digest("7"),
      },
      { kind: C.AUTHORITY_REPAIR_HEADER, operation_id: "operation-4", record_digest: digest("8") },
      { kind: C.ACTION_RECORD, key: { proposal_id: "proposal-1" } },
      {
        kind: C.ACTION_BLOB,
        blob_kind: "preview",
        content_digest: digest("9"),
        raw_sha256: raw("blob"),
        byte_length: 4,
        binding_record_digest: digest("10"),
      },
      { kind: C.CAPABILITY_GENERATION, generation_id: "generation-1", record_digest: digest("11") },
      {
        kind: C.CAPABILITY_RUNTIME_EVIDENCE_BLOB,
        content_digest: digest("12"),
        raw_sha256: raw("evidence"),
        byte_length: 8,
        binding_digest: digest("13"),
      },
      {
        kind: C.CAPABILITY_RUNTIME_EVIDENCE_BINDING,
        content_digest: digest("14"),
        binding_digest: digest("15"),
      },
      { kind: C.CAPABILITY_OUTBOX_PAYLOAD, public_payload_digest: digest("16") },
    ];
    for (const target of contentTargets)
      expect(() =>
        assertNonCompoundLocator({ strategy: S.RESTORE_CONTENT_ADDRESSED_OBJECT, target }),
      ).not.toThrow();

    expect(() => assertJournalSource({ kind: JS.CANONICAL })).not.toThrow();
    expect(() =>
      assertJournalSource({
        kind: JS.RECOVERY_GENERATION,
        expected_current_pointer_digest: digest("pointer"),
        generation_id: "generation-selected",
        generation_digest: digest("generation"),
      }),
    ).not.toThrow();
    expect(() => assertJournalSource({ kind: "unknown" })).toThrow(/source kind/);
    expect(() =>
      assertNonCompoundLocator({
        strategy: S.REPLACE_JSON_HEAD,
        target: { kind: "unknown-json-target" },
      }),
    ).toThrow(/JSON-head target kind/);
    expect(() => assertNonCompoundLocator({ strategy: "unknown" })).toThrow(/strategy/);
  });

  test("covers absent preimages, journal lost tails, and compound proposed state", () => {
    const absent = {
      presence: "absent",
      corrupt_bytes_sha256: null,
      quarantine_ref: null,
      absence_evidence_digest: digest("absence"),
    } as const;
    expect(() => assertTargetPreimage(absent)).not.toThrow();
    expect(() => assertTargetPreimage({ ...absent, quarantine_ref: digest("bad") })).toThrow(
      /absent target/,
    );
    const journal = journalSteps();
    expect(assertAuthorityRepairSteps(journal)).toEqual(journal);
    expect(authorityRepairLostTailDigest(journal)).toBe(journal.lost_tail_digest);
    const compound = compoundSteps(epochBase());
    expect(assertAuthorityRepairSteps(compound)).toEqual(compound);
    expect(authorityRepairProposedRestoredDigest(compound)).toStartWith("sha256:");
    expect(() =>
      authorityRepairLostTailDigest({
        ...journal,
        target_preimage: absent,
      }),
    ).toThrow(/absent repair/);

    const contentDraft: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "conversation-content",
      authority_scope: "conversation",
      scope_id: "root-session-content-1",
      strategy: S.RESTORE_CONTENT_ADDRESSED_OBJECT,
      target_locator: {
        strategy: S.RESTORE_CONTENT_ADDRESSED_OBJECT,
        target: {
          kind: C.CONVERSATION_OBJECT,
          object_schema_id: "conversation-object/1",
          record_digest: digest("content-record"),
        },
      },
      target_preimage: {
        presence: "present",
        corrupt_bytes_sha256: raw("content-corrupt"),
        quarantine_ref: "",
        absence_evidence_digest: null,
      },
      restore_source_ref: "",
      restore_bytes_sha256: raw("content-restore"),
      last_valid_record_digest: digest("content-last-valid"),
      lost_tail_sha256: null,
      lost_tail_digest: null,
      expected_current_pointer_digest: null,
      replacement_current_pointer_digest: null,
      recovery_link_digest: null,
      journal_identity_digest: null,
      authority_epoch_repair_base_digest: null,
    };
    contentDraft.target_preimage.quarantine_ref = authorityRepairQuarantineRef(
      contentDraft,
    ) as string;
    contentDraft.restore_source_ref = authorityRepairRestoreSourceRef(contentDraft);
    const content = materializeAuthorityRepairSteps(contentDraft);
    expect(assertAuthorityRepairSteps(content)).toEqual(content);
    expect(() =>
      assertAuthorityRepairSteps({
        ...content,
        expected_current_pointer_digest: digest("forbidden-content-pointer"),
      }),
    ).toThrow(/content restoration has pointer/);
  });
});

describe("authority repair absence and epoch artifacts", () => {
  test("persists and reads an absent repair evidence object", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-absence-"));
    roots.push(root);
    const scopeId = digest("absence-scope");
    const locator = {
      strategy: S.REPLACE_JSON_HEAD,
      target: { kind: J.CAPABILITY_LOCK, scope: "project", scope_identity_digest: scopeId },
    } as const;
    const evidence = materializeAuthorityRepairAbsenceEvidence({
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "capability-lock",
      authority_scope: "project",
      scope_id: scopeId,
      target_locator: locator,
      observed_at: createdAt,
    });
    const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "capability-lock",
      authority_scope: "project",
      scope_id: scopeId,
      strategy: S.REPLACE_JSON_HEAD,
      target_locator: locator,
      target_preimage: {
        presence: "absent",
        corrupt_bytes_sha256: null,
        quarantine_ref: null,
        absence_evidence_digest: evidence.evidence_digest,
      },
      restore_source_ref: "",
      restore_bytes_sha256: raw("absent-restore"),
      last_valid_record_digest: digest("absent-last-valid"),
      lost_tail_sha256: null,
      lost_tail_digest: null,
      expected_current_pointer_digest: "",
      replacement_current_pointer_digest: "",
      recovery_link_digest: null,
      journal_identity_digest: null,
      authority_epoch_repair_base_digest: null,
    };
    steps.restore_source_ref = authorityRepairRestoreSourceRef(steps);
    steps.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(steps);
    steps.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(steps);
    const candidate: AuthorityRepairPlanningCandidateV1 = {
      candidate_id: "candidate-absence-1",
      control_state: "current-valid",
      action_domain: "capability",
      action_root_locator: { kind: "capability", scope: "project", scope_identity_digest: scopeId },
      authorization: {
        schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
        control_scope: "project",
        control_scope_identity_digest: scopeId,
        authority_epoch: 1,
        authority_head_digest: digest("authority-head"),
        authority_head_checkpoint_digest: null,
        target_domain: "capability-lock",
        target_authority_scope: "project",
        target_scope_id: scopeId,
      },
      steps,
      created_at: createdAt,
      expires_at: "2026-08-28T03:05:00.000Z",
    };
    const planned = planAuthorityRepair(candidate);
    const store = new AuthorityRepairArtifactStoreV1(root);
    const lock = acquireProcessLock(store.paths.writerLock, {
      operation: "persist-absence",
      coverageRoot: store.paths.root,
    });
    try {
      store.persistPlanArtifacts(lock, {
        closure: planned.closure,
        restore_bytes: Buffer.from("absent-restore"),
        absence_evidence: evidence,
      });
    } finally {
      lock.release();
    }
    expect(store.readAbsenceEvidence(planned.closure.steps)).toEqual(evidence);
    expect(() => store.readQuarantine(planned.closure.steps)).toThrow(/no quarantine/);
  });

  test("reads a canonical epoch base by digest and rejects a path mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-epoch-artifact-"));
    roots.push(root);
    const store = new AuthorityRepairArtifactStoreV1(root);
    const base = epochBase(true, true);
    mkdirSync(store.paths.objects, { recursive: true, mode: 0o700 });
    writeFileSync(
      authorityRepairDigestObjectPath(store.paths.objects, base.base_digest),
      canonicalJsonBytes(base),
      {
        mode: 0o600,
      },
    );
    expect(store.readEpochBase(base.base_digest)).toEqual(base);
    expect(() => store.readAbsenceEvidence(journalSteps())).toThrow(/present repair/);
  });
});

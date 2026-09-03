import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  type PrivateProjectorNativeIdentifierBindingV1,
  RevisionNativeBindingStore,
} from "./revision-native-binding-store.js";
import {
  PARTICIPANT_START_RECONCILIATION_MODE,
  type ParticipantStartReconciliationModeV1,
  isParticipantStartReconciliationModeV1,
} from "./revision-participant-receipt.js";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function assertEvidence(value: unknown): asserts value is RevisionLanePrivateEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid revision lane evidence");
  const record = value as RevisionLanePrivateEvidenceV1;
  if (
    Object.keys(record).sort().join(",") !==
      [
        "adapter_evidence_ref",
        "attempt_key",
        "content_digest",
        "native_session_id",
        "native_reference_digest",
        "operation_id",
        "participant_id",
        "recorded_at",
        "root_session_id",
        "schema_version",
        "start_generation",
      ]
        .sort()
        .join(",") ||
    record.schema_version !== "1.0" ||
    typeof record.root_session_id !== "string" ||
    record.root_session_id.length === 0 ||
    Buffer.byteLength(record.root_session_id, "utf8") > 200 ||
    !/^vf-operation-[0-9a-f]{64}$/.test(record.operation_id) ||
    !/^vf-start-[0-9a-f]{64}$/.test(record.attempt_key) ||
    !Number.isSafeInteger(record.start_generation) ||
    record.start_generation < 0 ||
    typeof record.participant_id !== "string" ||
    record.participant_id.length === 0 ||
    Buffer.byteLength(record.participant_id, "utf8") > 200 ||
    (record.native_session_id !== null &&
      (typeof record.native_session_id !== "string" ||
        record.native_session_id.length === 0 ||
        Buffer.byteLength(record.native_session_id, "utf8") > 4096)) ||
    (record.adapter_evidence_ref !== null &&
      (typeof record.adapter_evidence_ref !== "string" ||
        record.adapter_evidence_ref.length === 0 ||
        Buffer.byteLength(record.adapter_evidence_ref, "utf8") > 4096)) ||
    (record.native_reference_digest !== null && !DIGEST.test(record.native_reference_digest)) ||
    typeof record.recorded_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.recorded_at) ||
    !/^sha256:[0-9a-f]{64}$/.test(record.content_digest)
  )
    throw new Error("invalid revision lane evidence");
  const { content_digest: _digest, ...preimage } = record;
  if (digestV1("VF-REVISION-LANE-PRIVATE-EVIDENCE\0v1\0", preimage) !== record.content_digest)
    throw new Error("invalid revision lane evidence digest");
}

export interface RevisionLanePrivateEvidenceV1 {
  schema_version: "1.0";
  root_session_id: string;
  operation_id: string;
  participant_id: string;
  start_generation: number;
  attempt_key: string;
  native_session_id: string | null;
  adapter_evidence_ref: string | null;
  native_reference_digest: string | null;
  recorded_at: string;
  content_digest: string;
}

export class RevisionLaneEvidenceStore {
  private readonly root: string;
  private readonly lock: string;
  private readonly nativeBindings: RevisionNativeBindingStore;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(resolve(artifactRoot), "revisions", "v1", "lane-evidence"),
    );
    this.lock = join(this.root, "writer.lock");
    this.nativeBindings = new RevisionNativeBindingStore(artifactRoot);
  }

  write(
    input: Omit<
      RevisionLanePrivateEvidenceV1,
      "schema_version" | "content_digest" | "native_reference_digest"
    > & {
      reconciliation_mode: ParticipantStartReconciliationModeV1;
      adapter_reference_utf8: string;
      absence_proved: boolean;
    },
  ): {
    ref: string | null;
    digest: string | null;
  } {
    if (
      !/^vf-operation-[0-9a-f]{64}$/.test(input.operation_id) ||
      !/^vf-start-[0-9a-f]{64}$/.test(input.attempt_key) ||
      !Number.isSafeInteger(input.start_generation) ||
      input.start_generation < 0 ||
      !isParticipantStartReconciliationModeV1(input.reconciliation_mode)
    )
      throw new Error("invalid revision lane evidence identity");
    const {
      reconciliation_mode: reconciliationMode,
      adapter_reference_utf8: adapterReference,
      absence_proved: absenceProved,
      ...evidenceInput
    } = input;
    const identifier = absenceProved
      ? null
      : this.nativeBindings.write({
          root_session_id: input.root_session_id,
          identifier_kind:
            reconciliationMode === PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE
              ? "process-lease"
              : input.native_session_id
                ? "provider-session"
                : "adapter-reference",
          identifier_utf8:
            reconciliationMode === PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE ||
            !input.native_session_id
              ? adapterReference
              : input.native_session_id,
        });
    const preimage = {
      schema_version: "1.0" as const,
      ...structuredClone(evidenceInput),
      native_reference_digest: identifier?.binding_digest ?? null,
    };
    const digest = digestV1("VF-REVISION-LANE-PRIVATE-EVIDENCE\0v1\0", preimage);
    const record = { ...preimage, content_digest: digest };
    const lock = acquireProcessLock(this.lock, { operation: `revision-lane:${input.attempt_key}` });
    try {
      createOrVerifyPrivateFile(
        join(this.root, `${digest.slice(7)}.json`),
        canonicalJsonBytes(record),
        {
          lock,
          maxBytes: MAX_EVIDENCE_BYTES,
        },
      );
    } finally {
      lock.release();
    }
    return identifier ? { ref: identifier.binding_digest, digest } : { ref: null, digest: null };
  }

  read(ref: string, expectedDigest?: string): RevisionLanePrivateEvidenceV1 | null {
    if (!DIGEST.test(ref) || expectedDigest === undefined || !DIGEST.test(expectedDigest))
      throw new Error("invalid revision lane evidence reference");
    const bytes = privateFileBytes(
      join(this.root, `${expectedDigest.slice(7)}.json`),
      MAX_EVIDENCE_BYTES,
    );
    if (bytes === null) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertEvidence(value);
    const binding = this.nativeBindings.read(ref, value.root_session_id);
    if (
      value.content_digest !== expectedDigest ||
      value.native_reference_digest !== ref ||
      !binding ||
      !canonicalJsonBytes(value).equals(bytes)
    )
      throw new Error("revision lane evidence storage authority mismatch");
    return structuredClone(value);
  }

  readNativeReference(
    ref: string,
    rootSessionId: string,
  ): PrivateProjectorNativeIdentifierBindingV1 | null {
    return this.nativeBindings.read(ref, rootSessionId);
  }
}

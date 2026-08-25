import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { SuspectedLiteralPublicationBindingV1 } from "../../actions/index.js";
import {
  type JsonValue,
  type ProcessLock,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";

const MAX_RECORD = 256 * 1024;
const MAX_CONTENT = 64 * 1024;
const STAGING = /^vf-literal-[0-9a-f]{64}$/;
const RULES_DIGEST = digestV1("VF-SUSPECTED-LITERAL-RULES\0v1\0", {
  schema_version: "1.0",
  classifier_profile: "vf-secret-classifier/1",
  rule_ids: ["credential-assignment"],
});

export interface SuspectedLiteralFindingV1 {
  rule_id: string;
  classification: "suspected";
  start_utf8_byte: number;
  end_utf8_byte: number;
}

export interface SuspectedLiteralStagingRecordV1 {
  schema_version: "1.0";
  private_staging_id: string;
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  source_event_id: string;
  private_content_ref: string;
  content_utf8_sha256: string;
  content_byte_length: number;
  classifier_profile: "vf-secret-classifier/1";
  projector_version: "vf-public-projector/1";
  rules_digest: string;
  findings: SuspectedLiteralFindingV1[];
  staged_content_digest: string;
  findings_digest: string;
  staged_at: string;
  expires_at: string;
  record_digest: string;
}

export interface SuspectedLiteralStagingFrameV1 {
  schema_version: "1.0";
  private_staging_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  staging_record_digest: string;
  state: "available" | "reserved" | "consumed" | "expired";
  proposal_id: string | null;
  consumption: {
    kind: "public-literal";
    operation_id: string;
    publication_event_digest: string;
  } | null;
  recorded_at: string;
  frame_digest: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findings(content: string): SuspectedLiteralFindingV1[] {
  const output: SuspectedLiteralFindingV1[] = [];
  const matcher = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu;
  for (const match of content.matchAll(matcher)) {
    const start = Buffer.byteLength(content.slice(0, match.index), "utf8");
    output.push({
      rule_id: "credential-assignment",
      classification: "suspected",
      start_utf8_byte: start,
      end_utf8_byte: start + Buffer.byteLength(match[0], "utf8"),
    });
  }
  return output;
}

function frame(
  record: SuspectedLiteralStagingRecordV1,
  prior: SuspectedLiteralStagingFrameV1 | null,
  input: Pick<
    SuspectedLiteralStagingFrameV1,
    "state" | "proposal_id" | "consumption" | "recorded_at"
  >,
): SuspectedLiteralStagingFrameV1 {
  const preimage = {
    schema_version: "1.0" as const,
    private_staging_id: record.private_staging_id,
    sequence: (prior?.sequence ?? -1) + 1,
    previous_frame_digest: prior?.frame_digest ?? null,
    staging_record_digest: record.record_digest,
    ...structuredClone(input),
  };
  return {
    ...preimage,
    frame_digest: digestV1("VF-SUSPECTED-LITERAL-STAGING-FRAME\0v1\0", preimage),
  };
}

export class LiteralStagingStoreV1 {
  private readonly records: string;
  private readonly blobs: string;
  private readonly frames: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "actions", "v1"));
    this.records = ensurePrivateDirectory(join(root, "literal-records"));
    this.blobs = ensurePrivateDirectory(join(root, "literal-blobs"));
    this.frames = ensurePrivateDirectory(join(root, "literal-staging"));
    this.lockPath = join(root, "literal-staging.writer.lock");
  }

  private assertId(id: string): void {
    if (!STAGING.test(id)) throw new Error("invalid literal staging id");
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private codec(id: string) {
    return {
      domain: "literal-staging" as const,
      maxFrames: 3,
      maxPayloadBytes: MAX_RECORD,
      maxAggregateBytes: MAX_RECORD * 3,
      validatePayload: (payload: Record<string, unknown>) => {
        const value = payload as unknown as SuspectedLiteralStagingFrameV1;
        const { frame_digest: _digest, ...preimage } = value;
        if (
          value.private_staging_id !== id ||
          digestV1("VF-SUSPECTED-LITERAL-STAGING-FRAME\0v1\0", preimage) !== value.frame_digest
        )
          throw new Error("invalid literal staging frame");
      },
      computePayloadDigest: (payload: Record<string, unknown>) =>
        (payload as unknown as SuspectedLiteralStagingFrameV1).frame_digest,
      validateJournalIdentity: (payload: Record<string, unknown>) =>
        payload.private_staging_id === id,
    };
  }

  stage(input: {
    private_staging_id: string;
    root_session_id: string;
    conversation_id: string;
    revision_id: string;
    source_event_id: string;
    content: string;
    staged_at: string;
  }): SuspectedLiteralPublicationBindingV1 {
    this.assertId(input.private_staging_id);
    const content = input.content.normalize("NFC");
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_CONTENT)
      throw new Error("literal staging content is empty or oversized");
    const classified = findings(content);
    if (classified.length === 0) throw new Error("literal staging content is not suspected");
    const contentSha = sha256(bytes);
    const contentRef = `actions/v1/literal-blobs/${contentSha}.bin`;
    const stagedDigest = digestV1("VF-SUSPECTED-LITERAL-STAGED-CONTENT\0v1\0", {
      schema_version: "1.0",
      content_utf8_sha256: contentSha,
      content_byte_length: bytes.length,
    });
    const findingsDigest = digestV1("VF-SUSPECTED-LITERAL-FINDINGS\0v1\0", classified);
    const withoutDigest = {
      schema_version: "1.0" as const,
      private_staging_id: input.private_staging_id,
      root_session_id: input.root_session_id,
      conversation_id: input.conversation_id,
      revision_id: input.revision_id,
      source_event_id: input.source_event_id,
      private_content_ref: contentRef,
      content_utf8_sha256: contentSha,
      content_byte_length: bytes.length,
      classifier_profile: "vf-secret-classifier/1" as const,
      projector_version: "vf-public-projector/1" as const,
      rules_digest: RULES_DIGEST,
      findings: classified,
      staged_content_digest: stagedDigest,
      findings_digest: findingsDigest,
      staged_at: input.staged_at,
      expires_at: new Date(Date.parse(input.staged_at) + 10 * 60_000).toISOString(),
    };
    const record = {
      ...withoutDigest,
      record_digest: digestV1("VF-SUSPECTED-LITERAL-STAGING-RECORD\0v1\0", withoutDigest),
    };
    this.withLock(`literal-stage:${input.private_staging_id}`, (lock) => {
      createOrVerifyPrivateFile(join(this.blobs, `${contentSha}.bin`), bytes, {
        lock,
        maxBytes: MAX_CONTENT,
      });
      createOrVerifyPrivateFile(
        join(this.records, `${input.private_staging_id}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: MAX_RECORD },
      );
      if (this.readFrames(input.private_staging_id).length === 0)
        appendVffrFrame(
          join(this.frames, `${input.private_staging_id}.frames`),
          "literal-staging",
          frame(record, null, {
            state: "available",
            proposal_id: null,
            consumption: null,
            recorded_at: input.staged_at,
          }) as unknown as JsonValue,
          { ...this.codec(input.private_staging_id), lock },
        );
    });
    return this.binding(record);
  }

  readRecord(id: string): SuspectedLiteralStagingRecordV1 | null {
    this.assertId(id);
    const bytes = privateFileBytes(join(this.records, `${id}.json`), MAX_RECORD);
    if (!bytes) return null;
    const record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as SuspectedLiteralStagingRecordV1;
    const { record_digest: _digest, ...preimage } = record;
    if (
      !canonicalJsonBytes(record).equals(bytes) ||
      digestV1("VF-SUSPECTED-LITERAL-STAGING-RECORD\0v1\0", preimage) !== record.record_digest
    )
      throw new Error("literal staging record is corrupt");
    return structuredClone(record);
  }

  readFrames(id: string): SuspectedLiteralStagingFrameV1[] {
    this.assertId(id);
    const path = join(this.frames, `${id}.frames`);
    if (privateFileBytes(path, MAX_RECORD * 3) === null) return [];
    return readVffrFile(path, this.codec(id)).map((item) =>
      structuredClone(item.payload as unknown as SuspectedLiteralStagingFrameV1),
    );
  }

  binding(record: SuspectedLiteralStagingRecordV1): SuspectedLiteralPublicationBindingV1 {
    return {
      schema_version: "1.0",
      private_staging_id: record.private_staging_id,
      staging_record_digest: record.record_digest,
      staged_content_digest: record.staged_content_digest,
      findings_digest: record.findings_digest,
      projector_version: record.projector_version,
      rules_digest: record.rules_digest,
      staged_at: record.staged_at,
      expires_at: record.expires_at,
    };
  }

  reserve(binding: SuspectedLiteralPublicationBindingV1, proposalId: string, at: string): void {
    this.withLock(`literal-reserve:${binding.private_staging_id}`, (lock) => {
      const record = this.readRecord(binding.private_staging_id);
      const current = this.readFrames(binding.private_staging_id).at(-1);
      if (
        !record ||
        canonicalJsonBytes(this.binding(record)).compare(canonicalJsonBytes(binding)) !== 0
      )
        throw new Error("literal staging binding changed");
      if (Date.parse(at) >= Date.parse(record.expires_at))
        throw new Error("literal staging expired");
      if (current?.state === "reserved" && current.proposal_id === proposalId) return;
      if (current?.state !== "available") throw new Error("literal staging is not available");
      const next = frame(record, current, {
        state: "reserved",
        proposal_id: proposalId,
        consumption: null,
        recorded_at: at,
      });
      appendVffrFrame(
        join(this.frames, `${record.private_staging_id}.frames`),
        "literal-staging",
        next as unknown as JsonValue,
        { ...this.codec(record.private_staging_id), lock },
      );
    });
  }

  content(binding: SuspectedLiteralPublicationBindingV1): string {
    const record = this.readRecord(binding.private_staging_id);
    if (
      !record ||
      canonicalJsonBytes(this.binding(record)).compare(canonicalJsonBytes(binding)) !== 0
    )
      throw new Error("literal staging binding changed");
    const bytes = privateFileBytes(
      join(this.blobs, `${record.content_utf8_sha256}.bin`),
      MAX_CONTENT,
    );
    if (
      !bytes ||
      bytes.length !== record.content_byte_length ||
      sha256(bytes) !== record.content_utf8_sha256
    )
      throw new Error("literal staging content is corrupt");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
    if (canonicalJsonBytes(findings(content)).compare(canonicalJsonBytes(record.findings)) !== 0)
      throw new Error("literal staging reclassification changed");
    return content;
  }

  consume(
    binding: SuspectedLiteralPublicationBindingV1,
    proposalId: string,
    operationId: string,
    eventDigest: string,
    at: string,
  ): void {
    this.withLock(`literal-consume:${binding.private_staging_id}`, (lock) => {
      const record = this.readRecord(binding.private_staging_id);
      const current = this.readFrames(binding.private_staging_id).at(-1);
      if (!record || current?.proposal_id !== proposalId)
        throw new Error("literal staging reservation changed");
      const consumption = {
        kind: "public-literal" as const,
        operation_id: operationId,
        publication_event_digest: eventDigest,
      };
      if (current.state === "consumed") {
        if (canonicalJsonBytes(current.consumption).compare(canonicalJsonBytes(consumption)) !== 0)
          throw new Error("literal staging consumption conflict");
        return;
      }
      if (current.state !== "reserved") throw new Error("literal staging is not reserved");
      const next = frame(record, current, {
        state: "consumed",
        proposal_id: proposalId,
        consumption,
        recorded_at: at,
      });
      appendVffrFrame(
        join(this.frames, `${record.private_staging_id}.frames`),
        "literal-staging",
        next as unknown as JsonValue,
        { ...this.codec(record.private_staging_id), lock },
      );
    });
  }
}

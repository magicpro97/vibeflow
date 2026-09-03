import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { PublicOversizedHandoffCandidateV1 } from "../../actions/error-details.js";
import {
  actionIdempotencyFileKey,
  oversizedHandoffIssuanceFileKey,
} from "../../actions/idempotency.js";
import type { OversizedHandoffCandidateV1 } from "../../actions/index.js";
import { validateOversizedCandidate } from "../../actions/internal-candidate-validation.js";
import {
  type JsonValue,
  type ProcessLock,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import {
  contextHandoffPromptDigest,
  contextHandoffRejectedPromptBytes,
} from "./handoff-selection.js";
import type { PromptHandoffProjectionV1, PublicHandoffSourceV1 } from "./handoff-types.js";

const MAX_OBJECT = 17 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface OversizedHandoffRejectedProjectionV1 {
  schema_version: "1.0";
  source: PublicHandoffSourceV1;
  source_public_head_digest: string;
  selection_plan_digest: string;
  mandatory_projection_digest: string;
  prompt_budget_bytes: number;
  prompt_projection: PromptHandoffProjectionV1;
  shared_prompt_byte_length: number;
  shared_prompt_sha256: string;
  content_digest: string;
}

export interface OversizedHandoffCandidateIssuanceFrameV1 {
  schema_version: "1.0";
  sequence: 0 | 1;
  previous_frame_digest: string | null;
  state: "prepared" | "visible";
  principal_digest: string;
  authority_scope_digest: string;
  idempotency_key_digest: string;
  canonical_request_digest: string;
  candidate_id: string;
  candidate_digest: string;
  created_at: string;
  expires_at: string;
  visible_at: string | null;
  frame_digest: string;
}

function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicCandidate(
  candidate: OversizedHandoffCandidateV1,
): PublicOversizedHandoffCandidateV1 {
  const { private_candidate_ref: _private, ...visible } = candidate;
  return structuredClone(visible);
}

function frame(
  prior: OversizedHandoffCandidateIssuanceFrameV1 | null,
  input: Omit<
    OversizedHandoffCandidateIssuanceFrameV1,
    "schema_version" | "sequence" | "previous_frame_digest" | "frame_digest"
  >,
): OversizedHandoffCandidateIssuanceFrameV1 {
  const preimage = {
    schema_version: "1.0" as const,
    sequence: (prior ? 1 : 0) as 0 | 1,
    previous_frame_digest: prior?.frame_digest ?? null,
    ...structuredClone(input),
  };
  return {
    ...preimage,
    frame_digest: digestV1("VF-OVERSIZED-HANDOFF-ISSUANCE-FRAME\0v1\0", preimage),
  };
}

export class OversizedHandoffStoreV1 {
  private readonly objects: string;
  private readonly actionObjects: string;
  private readonly issuance: string;
  private readonly idempotency: string;
  private readonly lockPath: string;
  private readonly objectLockPath: string;

  constructor(
    artifactRoot: string,
    private readonly fault?: (point: "after-prepared") => void,
  ) {
    const root = resolve(artifactRoot);
    this.objects = ensurePrivateDirectory(join(root, "objects", "v1"));
    this.objectLockPath = join(root, "objects", "oversized-handoff.writer.lock");
    const actions = ensurePrivateDirectory(join(root, "actions", "v1"));
    this.actionObjects = ensurePrivateDirectory(join(actions, "objects"));
    this.issuance = ensurePrivateDirectory(join(actions, "oversized-handoff-issuance"));
    this.idempotency = ensurePrivateDirectory(join(actions, "idempotency"));
    this.lockPath = join(actions, "writer.lock");
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private issuanceKey(input: {
    principal_digest: string;
    authority_scope_digest: string;
    idempotency_key_digest: string;
  }): string {
    return `sha256:${oversizedHandoffIssuanceFileKey(
      input.principal_digest,
      input.authority_scope_digest,
      input.idempotency_key_digest,
    )}`;
  }

  private codec(key: string) {
    return {
      domain: "oversized-handoff-issuance" as const,
      maxFrames: 2,
      maxPayloadBytes: 8 * 1024,
      maxAggregateBytes: 16 * 1024,
      validatePayload: (payload: Record<string, unknown>) => {
        const value = payload as unknown as OversizedHandoffCandidateIssuanceFrameV1;
        const { frame_digest: _digest, ...preimage } = value;
        if (
          digestV1("VF-OVERSIZED-HANDOFF-ISSUANCE-FRAME\0v1\0", preimage) !== value.frame_digest ||
          this.issuanceKey(value) !== key
        )
          throw new Error("invalid oversized handoff issuance frame");
      },
      computePayloadDigest: (payload: Record<string, unknown>) =>
        (payload as unknown as OversizedHandoffCandidateIssuanceFrameV1).frame_digest,
      validateJournalIdentity: (payload: Record<string, unknown>) =>
        this.issuanceKey(payload as unknown as OversizedHandoffCandidateIssuanceFrameV1) === key,
    };
  }

  private frames(key: string): OversizedHandoffCandidateIssuanceFrameV1[] {
    if (!DIGEST.test(key)) throw new Error("invalid oversized issuance key");
    const path = join(this.issuance, `${digestHex(key)}.frames`);
    if (privateFileBytes(path, 16 * 1024) === null) return [];
    const rows = readVffrFile(path, this.codec(key)).map(
      ({ payload }) => payload as unknown as OversizedHandoffCandidateIssuanceFrameV1,
    );
    if (
      rows.length > 2 ||
      rows.some((row, index) => row.sequence !== index) ||
      rows[0]?.state !== "prepared" ||
      rows[0].previous_frame_digest !== null ||
      rows[0].visible_at !== null ||
      (rows[1] &&
        (rows[1].state !== "visible" ||
          rows[1].previous_frame_digest !== rows[0].frame_digest ||
          rows[1].visible_at === null ||
          Date.parse(rows[1].visible_at) < Date.parse(rows[0].created_at) ||
          rows[1].principal_digest !== rows[0].principal_digest ||
          rows[1].authority_scope_digest !== rows[0].authority_scope_digest ||
          rows[1].idempotency_key_digest !== rows[0].idempotency_key_digest ||
          rows[1].canonical_request_digest !== rows[0].canonical_request_digest ||
          rows[1].candidate_id !== rows[0].candidate_id ||
          rows[1].candidate_digest !== rows[0].candidate_digest ||
          rows[1].created_at !== rows[0].created_at ||
          rows[1].expires_at !== rows[0].expires_at))
    )
      throw new Error("invalid oversized handoff issuance chain");
    return structuredClone(rows);
  }

  materializeRejected(
    input: Omit<
      OversizedHandoffRejectedProjectionV1,
      | "schema_version"
      | "mandatory_projection_digest"
      | "shared_prompt_byte_length"
      | "shared_prompt_sha256"
      | "content_digest"
    >,
  ): OversizedHandoffRejectedProjectionV1 {
    const promptBytes = contextHandoffRejectedPromptBytes(input.prompt_projection);
    const preimage = {
      schema_version: "1.0" as const,
      ...structuredClone(input),
      mandatory_projection_digest: contextHandoffPromptDigest(input.prompt_projection),
      shared_prompt_byte_length: promptBytes.length,
      shared_prompt_sha256: rawSha(promptBytes),
    };
    return {
      ...preimage,
      content_digest: digestV1("VF-OVERSIZED-HANDOFF-REJECTED-PROJECTION\0v1\0", preimage),
    };
  }

  issue(input: {
    rejected: OversizedHandoffRejectedProjectionV1;
    principal_digest: string;
    authority_scope_digest: string;
    idempotency_key_digest: string;
    canonical_request_digest: string;
    created_at: string;
  }): PublicOversizedHandoffCandidateV1 {
    const rejected = this.validateRejected(input.rejected);
    if (rejected.shared_prompt_byte_length <= rejected.prompt_budget_bytes)
      throw new Error("handoff projection is not oversized");
    const privateRef = `objects/v1/${digestHex(rejected.content_digest)}.json`;
    const candidatePreimage = {
      schema_version: "1.0" as const,
      source: structuredClone(rejected.source),
      source_public_head_digest: rejected.source_public_head_digest,
      selection_plan_digest: rejected.selection_plan_digest,
      mandatory_projection_digest: rejected.mandatory_projection_digest,
      prompt_budget_bytes: rejected.prompt_budget_bytes,
      encoded_candidate_bytes: rejected.shared_prompt_byte_length,
      overflow_bytes: rejected.shared_prompt_byte_length - rejected.prompt_budget_bytes,
      private_candidate_ref: privateRef,
      created_at: input.created_at,
      expires_at: new Date(Date.parse(input.created_at) + 10 * 60_000).toISOString(),
    };
    const candidateDigest = digestV1("VF-OVERSIZED-HANDOFF-CANDIDATE\0v1\0", candidatePreimage);
    const candidate: OversizedHandoffCandidateV1 = {
      ...candidatePreimage,
      candidate_id: `vf-oversized-handoff-${digestHex(candidateDigest)}`,
      candidate_digest: candidateDigest,
    };
    validateOversizedCandidate(candidate, "$.candidate");
    const key = this.issuanceKey(input);
    const objectLock = acquireProcessLock(this.objectLockPath, {
      operation: `oversized-object:${digestHex(rejected.content_digest)}`,
    });
    try {
      createOrVerifyPrivateFile(
        join(this.objects, `${digestHex(rejected.content_digest)}.json`),
        canonicalJsonBytes(rejected),
        { lock: objectLock, maxBytes: MAX_OBJECT },
      );
    } finally {
      objectLock.release();
    }
    return this.withLock(`oversized-handoff:${digestHex(key)}`, (lock) => {
      const actionKey = actionIdempotencyFileKey(
        input.principal_digest,
        input.authority_scope_digest,
        input.idempotency_key_digest,
      );
      if (privateFileBytes(join(this.idempotency, `${actionKey}.frames`), 16 * 1024 * 1024))
        throw new Error("oversized handoff issuance idempotency conflict");
      const retained = this.frames(key);
      if (retained.length) {
        const prepared = retained[0];
        if (
          !prepared ||
          prepared.principal_digest !== input.principal_digest ||
          prepared.authority_scope_digest !== input.authority_scope_digest ||
          prepared.idempotency_key_digest !== input.idempotency_key_digest ||
          prepared.canonical_request_digest !== input.canonical_request_digest
        )
          throw new Error("oversized handoff issuance idempotency conflict");
        const stored = this.readCandidate(prepared.candidate_id, prepared.candidate_digest);
        if (!stored) throw new Error("prepared oversized candidate is absent");
        this.readRejected(stored);
        if (retained.length === 1) {
          const visibleAt = input.created_at;
          if (
            Date.parse(visibleAt) < Date.parse(prepared.created_at) ||
            Date.parse(visibleAt) >= Date.parse(prepared.expires_at)
          )
            throw new Error("prepared oversized candidate expired before visibility");
          const visible = frame(prepared, {
            state: "visible",
            principal_digest: prepared.principal_digest,
            authority_scope_digest: prepared.authority_scope_digest,
            idempotency_key_digest: prepared.idempotency_key_digest,
            canonical_request_digest: prepared.canonical_request_digest,
            candidate_id: prepared.candidate_id,
            candidate_digest: prepared.candidate_digest,
            created_at: prepared.created_at,
            expires_at: prepared.expires_at,
            visible_at: visibleAt,
          });
          appendVffrFrame(
            join(this.issuance, `${digestHex(key)}.frames`),
            "oversized-handoff-issuance",
            visible as unknown as JsonValue,
            { ...this.codec(key), lock },
          );
        }
        return publicCandidate(stored);
      }
      createOrVerifyPrivateFile(
        join(this.actionObjects, `${digestHex(candidate.candidate_digest)}.json`),
        canonicalJsonBytes(candidate),
        { lock, maxBytes: 16 * 1024 },
      );
      const prepared = frame(null, {
        state: "prepared",
        principal_digest: input.principal_digest,
        authority_scope_digest: input.authority_scope_digest,
        idempotency_key_digest: input.idempotency_key_digest,
        canonical_request_digest: input.canonical_request_digest,
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.candidate_digest,
        created_at: input.created_at,
        expires_at: candidate.expires_at,
        visible_at: null,
      });
      appendVffrFrame(
        join(this.issuance, `${digestHex(key)}.frames`),
        "oversized-handoff-issuance",
        prepared as unknown as JsonValue,
        { ...this.codec(key), lock },
      );
      this.fault?.("after-prepared");
      const visible = frame(prepared, {
        state: "visible",
        principal_digest: prepared.principal_digest,
        authority_scope_digest: prepared.authority_scope_digest,
        idempotency_key_digest: prepared.idempotency_key_digest,
        canonical_request_digest: prepared.canonical_request_digest,
        candidate_id: prepared.candidate_id,
        candidate_digest: prepared.candidate_digest,
        created_at: prepared.created_at,
        expires_at: prepared.expires_at,
        visible_at: input.created_at,
      });
      appendVffrFrame(
        join(this.issuance, `${digestHex(key)}.frames`),
        "oversized-handoff-issuance",
        visible as unknown as JsonValue,
        { ...this.codec(key), lock },
      );
      return publicCandidate(candidate);
    });
  }

  readCandidate(id: string, digest: string): OversizedHandoffCandidateV1 | null {
    if (id !== `vf-oversized-handoff-${digestHex(digest)}`) return null;
    const bytes = privateFileBytes(
      join(this.actionObjects, `${digestHex(digest)}.json`),
      16 * 1024,
    );
    if (!bytes) return null;
    const candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!canonicalJsonBytes(candidate).equals(bytes))
      throw new Error("oversized candidate is non-canonical");
    validateOversizedCandidate(candidate, "$.candidate");
    return structuredClone(candidate as OversizedHandoffCandidateV1);
  }

  readRejected(candidate: OversizedHandoffCandidateV1): OversizedHandoffRejectedProjectionV1 {
    const match = /^objects\/v1\/([0-9a-f]{64})\.json$/.exec(candidate.private_candidate_ref);
    if (!match) throw new Error("invalid oversized private ref");
    const digest = `sha256:${match[1]}`;
    const bytes = privateFileBytes(join(this.objects, `${digestHex(digest)}.json`), MAX_OBJECT);
    if (!bytes) throw new Error("oversized rejected projection is absent");
    return this.validateRejected(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      bytes,
    );
  }

  private validateRejected(value: unknown, bytes?: Buffer): OversizedHandoffRejectedProjectionV1 {
    const row = value as OversizedHandoffRejectedProjectionV1;
    const { content_digest: _digest, ...preimage } = row;
    const prompt = contextHandoffRejectedPromptBytes(row.prompt_projection);
    if (
      row.schema_version !== "1.0" ||
      contextHandoffPromptDigest(row.prompt_projection) !== row.mandatory_projection_digest ||
      prompt.length !== row.shared_prompt_byte_length ||
      rawSha(prompt) !== row.shared_prompt_sha256 ||
      digestV1("VF-OVERSIZED-HANDOFF-REJECTED-PROJECTION\0v1\0", preimage) !== row.content_digest ||
      (bytes && !canonicalJsonBytes(row).equals(bytes))
    )
      throw new Error("invalid oversized rejected projection");
    return structuredClone(row);
  }
}

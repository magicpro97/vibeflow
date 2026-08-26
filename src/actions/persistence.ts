import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type ProcessLock,
  type VffrDomain,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../durability/index.js";
import {
  validateAuthorityEvent,
  validateChallengeChain,
  validateChallengeFrame,
  validateDispatchRecord,
  validateIdempotencyBinding,
  validateIdempotencyChain,
} from "./persistence-validation.js";
import { MAX_ACTION_PROPOSAL_BYTES } from "./proposal-validation.js";
import { assertProposal } from "./records.js";
import { foldActionAuthority } from "./state.js";
import type {
  ActionAuthorityEventV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
  ApprovalChallengeFrameV1,
} from "./types.js";

export interface ActionIdempotencyBindingV1 {
  schema_version: "1.0";
  sequence: 0 | 1;
  previous_frame_digest: string | null;
  state: "prepared" | "visible";
  principal_digest: string;
  authority_scope_digest: string;
  idempotency_key_digest: string;
  canonical_request_digest: string;
  proposal_id: string;
  proposal_digest: string;
  created_at: string;
  visible_at: string | null;
  retain_until: string;
  binding_digest: string;
}

type JournalRecord = ActionAuthorityEventV1 | ActionIdempotencyBindingV1 | ApprovalChallengeFrameV1;

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = MAX_ACTION_PROPOSAL_BYTES;
const MAX_AUTHORITY_EVENT_BYTES = MAX_PROPOSAL_BYTES + 16 * 1024;
const MAX_NAMESPACE_FILES = 16_384;

export function boundedActionNamespaceNames(names: readonly string[], grammar: RegExp): string[] {
  if (names.length > MAX_NAMESPACE_FILES) throw new Error("durable action namespace exceeds bound");
  const selected = names.filter((name) => grammar.test(name)).sort();
  return selected;
}

function recordDigest(domain: VffrDomain, payload: Record<string, unknown>): string {
  const field =
    domain === "action-authority"
      ? "event_digest"
      : domain === "action-idempotency"
        ? "binding_digest"
        : "frame_digest";
  const { [field]: _omitted, ...preimage } = payload;
  const digestDomain =
    domain === "action-authority"
      ? "VF-ACTION-AUTHORITY-EVENT\0v1\0"
      : domain === "action-idempotency"
        ? "VF-ACTION-IDEMPOTENCY-BINDING\0v1\0"
        : "VF-APPROVAL-CHALLENGE-FRAME\0v1\0";
  return digestV1(digestDomain, preimage);
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid durable action record");
  return value as Record<string, unknown>;
}

export class ActionFilePersistence {
  readonly actionRoot: string;
  readonly root: string;
  private readonly proposals: string;
  private readonly operations: string;
  private readonly idempotency: string;
  private readonly challenges: string;
  private readonly dispatches: string;
  private readonly oversizedHandoffIssuance: string;
  private readonly lockPath: string;

  constructor(actionRoot: string) {
    this.root = ensurePrivateDirectory(join(actionRoot, "actions", "v1"));
    this.actionRoot = dirname(dirname(this.root));
    this.proposals = ensurePrivateDirectory(join(this.root, "proposals"));
    this.operations = ensurePrivateDirectory(join(this.root, "operations"));
    this.idempotency = ensurePrivateDirectory(join(this.root, "idempotency"));
    this.challenges = ensurePrivateDirectory(join(this.root, "challenges"));
    this.dispatches = ensurePrivateDirectory(join(this.root, "dispatch"));
    this.oversizedHandoffIssuance = ensurePrivateDirectory(
      join(this.root, "oversized-handoff-issuance"),
    );
    this.lockPath = join(this.root, "writer.lock");
  }

  withLock<T>(operation: string, action: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return action(lock);
    } finally {
      lock.release();
    }
  }

  proposalPath(proposalId: string): string {
    return join(this.proposals, `${this.safeId(proposalId)}.json`);
  }

  authorityPath(proposalId: string): string {
    return join(this.operations, `${this.safeId(proposalId)}.frames`);
  }

  challengePath(challengeId: string): string {
    return join(this.challenges, `${this.safeId(challengeId)}.frames`);
  }

  idempotencyPath(fileKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(fileKey)) throw new Error("invalid idempotency file key");
    return join(this.idempotency, `${fileKey}.frames`);
  }

  hasOversizedHandoffIssuance(fileKey: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(fileKey)) throw new Error("invalid oversized issuance key");
    return (
      privateFileBytes(join(this.oversizedHandoffIssuance, `${fileKey}.frames`), MAX_FILE_BYTES) !==
      null
    );
  }

  dispatchPath(operationId: string): string {
    return join(this.dispatches, `${this.safeId(operationId)}.json`);
  }

  writeProposal(lock: ProcessLock, proposal: ActionProposalV1): void {
    assertProposal(proposal);
    createOrVerifyPrivateFile(
      this.proposalPath(proposal.proposal_id),
      canonicalJsonBytes(proposal),
      {
        lock,
        maxBytes: MAX_PROPOSAL_BYTES,
      },
    );
  }

  readProposal(proposalId: string): ActionProposalV1 | null {
    const bytes = privateFileBytes(this.proposalPath(proposalId), MAX_PROPOSAL_BYTES);
    if (!bytes) return null;
    const parsed = strictRecord(JSON.parse(bytes.toString("utf8"))) as unknown as ActionProposalV1;
    if (!canonicalJsonBytes(parsed).equals(bytes))
      throw new Error("proposal bytes are not canonical");
    assertProposal(parsed);
    return parsed;
  }

  writeDispatch(lock: ProcessLock, record: ActionDispatchRecordV1): void {
    validateDispatchRecord(record);
    createOrVerifyPrivateFile(this.dispatchPath(record.operation_id), canonicalJsonBytes(record), {
      lock,
      maxBytes: 128 * 1024,
    });
  }

  readDispatch(operationId: string): ActionDispatchRecordV1 | null {
    const bytes = privateFileBytes(this.dispatchPath(operationId), 128 * 1024);
    if (!bytes) return null;
    const record = strictRecord(
      JSON.parse(bytes.toString("utf8")),
    ) as unknown as ActionDispatchRecordV1;
    if (!canonicalJsonBytes(record).equals(bytes))
      throw new Error("dispatch bytes are not canonical");
    return validateDispatchRecord(record);
  }

  readAuthority(proposalId: string): ActionAuthorityEventV1[] {
    const path = this.authorityPath(proposalId);
    if (privateFileBytes(path, MAX_FILE_BYTES) === null) return [];
    const frames = readVffrFile(path, this.options("action-authority", proposalId));
    const events = frames.map((frame) => validateAuthorityEvent(frame.payload));
    foldActionAuthority(events);
    return events;
  }

  appendAuthority(lock: ProcessLock, event: ActionAuthorityEventV1): void {
    const existing = this.readAuthority(event.proposal_id);
    foldActionAuthority([...existing, validateAuthorityEvent(event)]);
    appendVffrFrame(
      this.authorityPath(event.proposal_id),
      "action-authority",
      event as unknown as Record<string, never>,
      { ...this.options("action-authority", event.proposal_id), lock },
    );
  }

  readIdempotency(path: string): ActionIdempotencyBindingV1[] {
    if (privateFileBytes(path, MAX_FILE_BYTES) === null) return [];
    return validateIdempotencyChain(
      readVffrFile(path, this.options("action-idempotency", basename(path))).map(
        (frame) => frame.payload,
      ),
    );
  }

  appendIdempotency(lock: ProcessLock, path: string, binding: ActionIdempotencyBindingV1): void {
    const existing = this.readIdempotency(path);
    validateIdempotencyChain([...existing, binding]);
    appendVffrFrame(path, "action-idempotency", binding as unknown as Record<string, never>, {
      ...this.options("action-idempotency", basename(path)),
      lock,
    });
  }

  readChallenge(challengeId: string): ApprovalChallengeFrameV1[] {
    const path = this.challengePath(challengeId);
    if (privateFileBytes(path, MAX_FILE_BYTES) === null) return [];
    return validateChallengeChain(
      readVffrFile(path, this.options("approval-challenge", challengeId)).map(
        (frame) => frame.payload,
      ),
    );
  }

  appendChallenge(lock: ProcessLock, frame: ApprovalChallengeFrameV1): void {
    const existing = this.readChallenge(frame.challenge_id);
    validateChallengeChain([...existing, frame]);
    appendVffrFrame(
      this.challengePath(frame.challenge_id),
      "approval-challenge",
      frame as unknown as Record<string, never>,
      { ...this.options("approval-challenge", frame.challenge_id), lock },
    );
  }

  proposalIds(): string[] {
    return boundedActionNamespaceNames(
      readdirSync(this.proposals),
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/,
    )
      .map((name) => name.slice(0, -5))
      .sort();
  }

  idempotencyChainsForProposal(proposalId: string): ActionIdempotencyBindingV1[][] {
    return this.namespaceFiles(this.idempotency, /^[a-f0-9]{64}\.frames$/).flatMap((name) => {
      try {
        const chain = this.readIdempotency(join(this.idempotency, name));
        return chain[0]?.proposal_id === proposalId ? [chain] : [];
      } catch {
        return [];
      }
    });
  }

  consumedChallengesByDigest(frameDigest: string): ApprovalChallengeFrameV1[] {
    const matches: ApprovalChallengeFrameV1[] = [];
    for (const name of this.namespaceFiles(this.challenges, /^[A-Za-z0-9_-]{43}\.frames$/)) {
      try {
        const frame = this.readChallenge(name.slice(0, -".frames".length)).at(-1);
        if (frame?.state === "consumed" && frame.frame_digest === frameDigest) matches.push(frame);
      } catch {
        // An unrelated corrupt challenge cannot substitute for the exact digest.
      }
    }
    return matches;
  }

  private options(domain: VffrDomain, identity: string) {
    return {
      domain,
      maxFrames: domain === "approval-challenge" ? 6 : 4_096,
      maxPayloadBytes:
        domain === "action-authority" ? MAX_AUTHORITY_EVENT_BYTES : MAX_PROPOSAL_BYTES,
      maxAggregateBytes: MAX_FILE_BYTES,
      validatePayload: (payload: Record<string, unknown>) => {
        if (domain === "action-authority") validateAuthorityEvent(payload);
        else if (domain === "action-idempotency") validateIdempotencyBinding(payload);
        else validateChallengeFrame(payload);
      },
      computePayloadDigest: (payload: Record<string, unknown>) => recordDigest(domain, payload),
      validateJournalIdentity: (payload: Record<string, unknown>) => {
        if (domain === "action-authority") return payload.proposal_id === identity;
        if (domain === "approval-challenge") return payload.challenge_id === identity;
        const namespace = digestV1("VF-ACTION-IDEMPOTENCY-FILE-KEY\0v1\0", {
          schema_version: "1.0",
          principal_digest: payload.principal_digest,
          authority_scope_digest: payload.authority_scope_digest,
          idempotency_key_digest: payload.idempotency_key_digest,
        });
        return basename(identity) === `${namespace.slice("sha256:".length)}.frames`;
      },
    };
  }

  private safeId(value: string): string {
    if (!ID.test(value)) throw new Error("invalid durable action identity");
    return value;
  }

  private namespaceFiles(directory: string, grammar: RegExp): string[] {
    return boundedActionNamespaceNames(readdirSync(directory), grammar);
  }
}

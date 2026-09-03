import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  AGENT_ACTION_CANDIDATE_DIGEST_PREFIX,
  AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX,
  AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT,
} from "./conversation-agent-action-candidate-contract.js";
import {
  type DurableAgentActionCandidateReceiptV1,
  validateReceipt,
} from "./conversation-agent-action-candidate-receipts.js";
import {
  ConversationAgentActionCandidateResponseConflictError,
  DIGEST_FILE,
  type DurableAgentActionCandidateResponseBindingV1,
  type DurableAgentActionCandidateStageV1,
  MAX_NAMESPACE_FILES,
  MAX_RECORD_BYTES,
  assertResponseBindingStage,
  decode,
  materializeResponseBinding,
  requireDigest,
  requireOpaqueId,
  validateResponseBinding,
  validateStage,
} from "./conversation-agent-action-candidate-records.js";

/** Private immutable staging and terminal receipts for recoverable agent action candidates. */
export class ConversationAgentActionCandidateStoreV1 {
  private readonly responseBindings: string;
  private readonly receipts: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    const root = ensurePrivateDirectory(
      join(
        resolve(artifactRoot),
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.ACTIONS,
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.VERSION,
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.ROOT,
      ),
    );
    this.responseBindings = ensurePrivateDirectory(
      join(root, AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.RESPONSE_BINDINGS),
    );
    this.receipts = ensurePrivateDirectory(
      join(root, AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.RECEIPTS),
    );
    this.lockPath = join(root, AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.WRITER_LOCK);
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private path(root: string, digest: string): string {
    requireDigest(digest, "candidate record path digest");
    return join(root, `${digest.slice(AGENT_ACTION_CANDIDATE_DIGEST_PREFIX.length)}.json`);
  }

  writeStage(stage: DurableAgentActionCandidateStageV1): void {
    validateStage(stage);
    const binding = materializeResponseBinding(stage);
    this.withLock(
      `${AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX.STAGE}${binding.response_binding_key_digest}`,
      (lock) => {
        const current = this.readResponseBinding(binding.response_binding_key_digest);
        if (current) {
          if (canonicalJsonBytes(current).equals(canonicalJsonBytes(binding))) return;
          throw new ConversationAgentActionCandidateResponseConflictError(
            "one completed response can bind only one agent action candidate",
          );
        }
        createOrVerifyPrivateFile(
          this.path(this.responseBindings, binding.response_binding_key_digest),
          canonicalJsonBytes(binding),
          { lock, maxBytes: MAX_RECORD_BYTES },
        );
      },
    );
  }

  private readResponseBinding(
    bindingKeyDigest: string,
  ): DurableAgentActionCandidateResponseBindingV1 | null {
    const bytes = privateFileBytes(
      this.path(this.responseBindings, bindingKeyDigest),
      MAX_RECORD_BYTES,
    );
    return bytes === null ? null : decode(bytes, validateResponseBinding);
  }

  private responseBindingRecords(): DurableAgentActionCandidateResponseBindingV1[] {
    const entries = readdirSync(this.responseBindings);
    if (entries.length > MAX_NAMESPACE_FILES)
      throw new Error("agent action candidate namespace exceeds bound");
    const names = entries.filter((name) => DIGEST_FILE.test(name)).sort();
    return names
      .map((name) =>
        this.readResponseBinding(`${AGENT_ACTION_CANDIDATE_DIGEST_PREFIX}${name.slice(0, -5)}`),
      )
      .filter(
        (binding): binding is DurableAgentActionCandidateResponseBindingV1 => binding !== null,
      );
  }

  stagesForConversation(conversationId: string): DurableAgentActionCandidateStageV1[] {
    requireOpaqueId(conversationId, "candidate conversation id");
    return this.responseBindingRecords()
      .filter((binding) => binding.conversation_id === conversationId)
      .map((binding) => {
        const stage = structuredClone(binding.stage);
        assertResponseBindingStage(binding, stage);
        return stage;
      });
  }

  conversationIds(): string[] {
    return [...new Set(this.responseBindingRecords().map((binding) => binding.conversation_id))];
  }

  writeReceipt(receipt: DurableAgentActionCandidateReceiptV1): void {
    validateReceipt(receipt);
    const binding = this.responseBindingRecords().find(
      (candidate) => candidate.record_digest === receipt.record_digest,
    );
    if (!binding) throw new Error("candidate receipt has no response-key binding");
    assertResponseBindingStage(binding, binding.stage);
    this.withLock(
      `${AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX.RECEIPT}${receipt.record_digest}`,
      (lock) =>
        createOrVerifyPrivateFile(
          this.path(this.receipts, receipt.record_digest),
          canonicalJsonBytes(receipt),
          { lock, maxBytes: MAX_RECORD_BYTES },
        ),
    );
  }

  readReceipt(recordDigest: string): DurableAgentActionCandidateReceiptV1 | null {
    const bytes = privateFileBytes(this.path(this.receipts, recordDigest), MAX_RECORD_BYTES);
    return bytes === null ? null : decode(bytes, validateReceipt);
  }
}

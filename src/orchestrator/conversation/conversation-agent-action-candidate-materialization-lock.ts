import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
} from "../../durability/index.js";
import {
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX,
  AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT,
} from "./conversation-agent-action-candidate-contract.js";

interface ProcessMaterializationV1 {
  requested: boolean;
  promise: Promise<void>;
}

const processMaterializations = new Map<string, ProcessMaterializationV1>();

/** Serializes proposal publication and its private terminal receipt across process lifetimes. */
export class ConversationAgentActionCandidateMaterializationLockV1 {
  private readonly root: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(
        resolve(artifactRoot),
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.ACTIONS,
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.VERSION,
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.ROOT,
        AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT.MATERIALIZATION_LOCKS,
      ),
    );
  }

  run(conversationId: string, task: () => Promise<void>): Promise<void> {
    const key = join(
      this.root,
      `${digestHex(
        digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.MATERIALIZATION_LOCK, conversationId),
      )}.lock`,
    );
    const current = processMaterializations.get(key);
    if (current) {
      current.requested = true;
      return current.promise;
    }
    const state = { requested: false, promise: Promise.resolve() };
    const execution = (async () => {
      const lock = acquireProcessLock(key, {
        operation: `${AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX.MATERIALIZE}${digestHex(
          digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.OPAQUE_ID, conversationId),
        )}`,
        timeoutMs: 30_000,
      });
      try {
        do {
          state.requested = false;
          await task();
        } while (state.requested);
      } finally {
        lock.release();
      }
    })();
    state.promise = execution.finally(() => {
      if (processMaterializations.get(key) === state) processMaterializations.delete(key);
    });
    processMaterializations.set(key, state);
    return state.promise;
  }
}

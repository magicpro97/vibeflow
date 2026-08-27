import { ENGINES, type Engine, isAgentEngine } from "../../core/agent-contract.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueTargetParticipantsV1,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";

export type ConversationEngine = Engine;

export const HOME_COMPOSER_INTENT_KIND = Object.freeze({
  EMPTY: "empty",
  INVALID: "invalid",
  MESSAGE: "message",
  ADD_PARTICIPANT: "add-participant",
  REMOVE_PARTICIPANT: "remove-participant",
  INSTALL_CAPABILITY: "install-capability",
  REMOVE_CAPABILITY: "remove-capability",
} as const);

export const HOME_COMPOSER_CAPABILITY_COMMAND = Object.freeze({
  INSTALL: "install",
  REMOVE: "remove",
} as const);

export const HOME_COMPOSER_SCOPE_FLAG = Object.freeze({
  USER: "--user",
  PROJECT: "--project",
} as const);

export type ComposerIntent =
  | { kind: typeof HOME_COMPOSER_INTENT_KIND.EMPTY }
  | { kind: typeof HOME_COMPOSER_INTENT_KIND.INVALID; message: string }
  | {
      kind: typeof HOME_COMPOSER_INTENT_KIND.MESSAGE;
      content: string;
      targets: ConversationMessageQueueTargetParticipantsV1;
    }
  | {
      kind: typeof HOME_COMPOSER_INTENT_KIND.ADD_PARTICIPANT;
      roleRef: string;
      engine: ConversationEngine;
      model: string | null;
    }
  | { kind: typeof HOME_COMPOSER_INTENT_KIND.REMOVE_PARTICIPANT; participantId: string }
  | {
      kind: typeof HOME_COMPOSER_INTENT_KIND.INSTALL_CAPABILITY;
      packageId: string;
      scope: CapabilityScope;
    }
  | {
      kind: typeof HOME_COMPOSER_INTENT_KIND.REMOVE_CAPABILITY;
      packageId: string;
      scope: CapabilityScope;
    };

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_PARTICIPANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function parseComposerIntent(source: string): ComposerIntent {
  const text = source.normalize("NFC").trim();
  if (!text) return { kind: HOME_COMPOSER_INTENT_KIND.EMPTY };

  const add = /^\+([^@\s]+)@([a-z]+)(?::([^\s]+))?$/i.exec(text);
  if (add) {
    const [, roleRef = "", rawEngine = "", model] = add;
    const engine = rawEngine.toLowerCase();
    if (!isAgentEngine(engine))
      return {
        kind: HOME_COMPOSER_INTENT_KIND.INVALID,
        message: `Choose one of: ${ENGINES.join(", ")}.`,
      };
    if (!SAFE_REFERENCE.test(roleRef))
      return {
        kind: HOME_COMPOSER_INTENT_KIND.INVALID,
        message: "The agent role is not a safe reference.",
      };
    return {
      kind: HOME_COMPOSER_INTENT_KIND.ADD_PARTICIPANT,
      roleRef,
      engine,
      model: model ?? null,
    };
  }

  const removeParticipant = /^-@([^\s]+)$/u.exec(text);
  if (removeParticipant) {
    const participantId = removeParticipant[1] ?? "";
    return SAFE_PARTICIPANT.test(participantId)
      ? { kind: HOME_COMPOSER_INTENT_KIND.REMOVE_PARTICIPANT, participantId }
      : {
          kind: HOME_COMPOSER_INTENT_KIND.INVALID,
          message: "Choose an agent from this conversation.",
        };
  }

  const capability = /^\/(install|remove)\s+([^\s]+)(?:\s+(--user|--project))?$/u.exec(text);
  if (capability) {
    const packageId = capability[2] ?? "";
    if (!SAFE_REFERENCE.test(packageId))
      return {
        kind: HOME_COMPOSER_INTENT_KIND.INVALID,
        message: "The capability package reference is invalid.",
      };
    const common: { packageId: string; scope: CapabilityScope } = {
      packageId,
      scope:
        capability[3] === HOME_COMPOSER_SCOPE_FLAG.USER
          ? CAPABILITY_SCOPE.USER
          : CAPABILITY_SCOPE.PROJECT,
    };
    return capability[1] === HOME_COMPOSER_CAPABILITY_COMMAND.INSTALL
      ? { kind: HOME_COMPOSER_INTENT_KIND.INSTALL_CAPABILITY, ...common }
      : { kind: HOME_COMPOSER_INTENT_KIND.REMOVE_CAPABILITY, ...common };
  }

  const targeted = /^@([^\s]+)\s+([\s\S]+)$/u.exec(text);
  if (targeted) {
    const participantId = targeted[1] ?? "";
    if (!SAFE_PARTICIPANT.test(participantId))
      return {
        kind: HOME_COMPOSER_INTENT_KIND.INVALID,
        message: "Choose an agent from this conversation.",
      };
    return {
      kind: HOME_COMPOSER_INTENT_KIND.MESSAGE,
      content: targeted[2]?.trim() ?? "",
      targets: [participantId],
    };
  }

  if (text.startsWith("/") || text.startsWith("+") || text.startsWith("-@"))
    return {
      kind: HOME_COMPOSER_INTENT_KIND.INVALID,
      message: "That command is incomplete. Choose a suggestion below.",
    };
  return {
    kind: HOME_COMPOSER_INTENT_KIND.MESSAGE,
    content: text,
    targets: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
  };
}

export interface ActivationToken {
  readonly rootSessionId: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  addCleanup(cleanup: () => void): void;
}

/** Deduplicates closeable resources owned by one activation epoch. */
export class ActivationResourceRegistry<Resource extends { close(): void }> {
  private readonly resources = new Map<string, Resource>();

  get size(): number {
    return this.resources.size;
  }

  getOrCreate(key: string, create: () => Resource): Resource {
    const current = this.resources.get(key);
    if (current) return current;
    const resource = create();
    this.resources.set(key, resource);
    return resource;
  }

  release(key: string, expected?: Resource): void {
    const current = this.resources.get(key);
    if (!current || (expected && current !== expected)) return;
    this.resources.delete(key);
    current.close();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const [key, resource] of this.resources) {
      if (keys.has(key)) continue;
      this.resources.delete(key);
      resource.close();
    }
  }

  close(): void {
    const current = [...this.resources.values()];
    this.resources.clear();
    for (const resource of current) resource.close();
  }
}

/** Owns every async resource for one selected root session. */
export class ActivationEpoch {
  private generation = 0;
  private controller: AbortController | null = null;
  private cleanups = new Set<() => void>();

  captureGeneration(): number {
    return this.generation;
  }

  isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  begin(rootSessionId: string): ActivationToken {
    this.invalidate();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () =>
      this.generation === generation &&
      this.controller === controller &&
      !controller.signal.aborted;
    return {
      rootSessionId,
      signal: controller.signal,
      isCurrent,
      addCleanup: (cleanup) => {
        if (!isCurrent()) {
          cleanup();
          return;
        }
        this.cleanups.add(cleanup);
      },
    };
  }

  close(): void {
    this.invalidate();
    this.generation += 1;
  }

  private invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    const pending = [...this.cleanups];
    this.cleanups.clear();
    for (const cleanup of pending) cleanup();
  }
}

import type { CapabilityScope } from "../../capabilities/manifest/types.js";
import { ENGINES, type Engine } from "../../core/types.js";

export type ConversationEngine = Engine;

export type ComposerIntent =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "message"; content: string; targets: "all" | string[] }
  | {
      kind: "add-participant";
      roleRef: string;
      engine: ConversationEngine;
      model: string | null;
    }
  | { kind: "remove-participant"; participantId: string }
  | { kind: "install-capability"; packageId: string; scope: CapabilityScope }
  | { kind: "remove-capability"; packageId: string; scope: CapabilityScope };

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_PARTICIPANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isConversationEngine(value: string): value is ConversationEngine {
  return (ENGINES as readonly string[]).includes(value);
}

export function parseComposerIntent(source: string): ComposerIntent {
  const text = source.normalize("NFC").trim();
  if (!text) return { kind: "empty" };

  const add = /^\+([^@\s]+)@([a-z]+)(?::([^\s]+))?$/i.exec(text);
  if (add) {
    const [, roleRef = "", rawEngine = "", model] = add;
    const engine = rawEngine.toLowerCase();
    if (!isConversationEngine(engine))
      return {
        kind: "invalid",
        message: "Choose one of: claude, codex, copilot, opencode, antigravity.",
      };
    if (!SAFE_REFERENCE.test(roleRef))
      return { kind: "invalid", message: "The agent role is not a safe reference." };
    return { kind: "add-participant", roleRef, engine, model: model ?? null };
  }

  const removeParticipant = /^-@([^\s]+)$/u.exec(text);
  if (removeParticipant) {
    const participantId = removeParticipant[1] ?? "";
    return SAFE_PARTICIPANT.test(participantId)
      ? { kind: "remove-participant", participantId }
      : { kind: "invalid", message: "Choose an agent from this conversation." };
  }

  const capability = /^\/(install|remove)\s+([^\s]+)(?:\s+(--user|--project))?$/u.exec(text);
  if (capability) {
    const packageId = capability[2] ?? "";
    if (!SAFE_REFERENCE.test(packageId))
      return { kind: "invalid", message: "The capability package reference is invalid." };
    const common: { packageId: string; scope: CapabilityScope } = {
      packageId,
      scope: capability[3] === "--user" ? "user" : "project",
    };
    return capability[1] === "install"
      ? { kind: "install-capability", ...common }
      : { kind: "remove-capability", ...common };
  }

  const targeted = /^@([^\s]+)\s+([\s\S]+)$/u.exec(text);
  if (targeted) {
    const participantId = targeted[1] ?? "";
    if (!SAFE_PARTICIPANT.test(participantId))
      return { kind: "invalid", message: "Choose an agent from this conversation." };
    return { kind: "message", content: targeted[2]?.trim() ?? "", targets: [participantId] };
  }

  if (text.startsWith("/") || text.startsWith("+") || text.startsWith("-@"))
    return { kind: "invalid", message: "That command is incomplete. Choose a suggestion below." };
  return { kind: "message", content: text, targets: "all" };
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

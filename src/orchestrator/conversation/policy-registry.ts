import { createHash } from "node:crypto";
import type {
  AgentBinding,
  MaterializedAgentBinding,
  PreviewAgentBinding,
} from "../../agents/binding.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import { projectPublicStoredTrace } from "../trace/project.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  TraceCorrelation,
  TraceEvent,
} from "../trace/types.js";
import type { BindingAuthoritySnapshot, ConversationArtifactStore } from "./artifact-store.js";
import { assertPublicQuoteReferenceV1 } from "./conversation-interaction-validation.js";
import {
  type PrivateFileRangeHandoffBindingV1,
  assertPrivateFileRangeHandoffBindingV1,
} from "./private-file-range-staging-store.js";
// biome-ignore format: production file ceiling
import type {
  ConversationBinding, ConversationHealth, ConversationManifest, ConversationOrchestrationResult, ConversationPolicy, MessageRequest, TerminalLifecycle,
} from "./types.js";
export { ConversationSubscribers } from "./subscribers.js";
type CorrelationPatch = Partial<
  Pick<
    TraceCorrelation,
    | "participant_id"
    | "role_ref"
    | "role_resolved_hash"
    | "skill_refs"
    | "skill_resolved_hashes"
    | "engine"
  >
>;
export interface RuntimeEmission {
  emission: { idempotency_key: string; event: TraceEvent };
  patch?: CorrelationPatch;
}
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function privateFileRangeAuthority(request: MessageRequest) {
  const privateFileRange = request.private_file_range;
  if (!privateFileRange) return undefined;
  assertPrivateFileRangeHandoffBindingV1(privateFileRange);
  return structuredClone(privateFileRange);
}

export const canonicalMessageRequest = (request: MessageRequest): MessageRequest => {
  if (
    typeof request.content !== "string" ||
    !request.content.trim() ||
    request.content.length > 65_536
  )
    throw new Error("invalid message content");
  const targets = request.target_participants;
  if (targets !== undefined && targets !== "all") {
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > 64 ||
      targets.some((target) => typeof target !== "string" || !target || target.length > 200)
    )
      throw new Error("invalid target participants");
  }
  const quoteRefs = request.quote_refs;
  if (quoteRefs !== undefined) {
    if (!Array.isArray(quoteRefs) || quoteRefs.length < 1 || quoteRefs.length > 8)
      throw new Error("invalid quote reference count");
    const seen = new Set<string>();
    for (const quote of quoteRefs) {
      assertPublicQuoteReferenceV1(quote);
      const key = `${quote.target_event_id}\0${quote.content_digest}`;
      if (seen.has(key)) throw new Error("duplicate quote reference");
      seen.add(key);
    }
  }
  return Object.freeze({
    content: request.content,
    target_participants:
      !targets || targets === "all" ? "all" : Object.freeze([...new Set(targets)].sort()),
    ...(quoteRefs ? { quote_refs: Object.freeze(structuredClone(quoteRefs)) } : {}),
    ...(privateFileRangeAuthority(request)
      ? { private_file_range: privateFileRangeAuthority(request) }
      : {}),
  }) as MessageRequest;
};
export const messageRevisionKey = (request: MessageRequest): string =>
  digest(
    (() => {
      const canonical = canonicalMessageRequest(request);
      return {
        content: canonical.content,
        target_participants: canonical.target_participants,
        quote_refs: canonical.quote_refs ?? [],
        private_file_range: canonical.private_file_range ?? null,
      };
    })(),
  );
export const conversationMessages = (
  records: readonly InternalTraceStoreRecord[],
): readonly MessageRequest[] =>
  Object.freeze(
    records
      .filter(({ stored_event: stored }) => stored.event.type === "user_message")
      .map(({ stored_event: stored }) =>
        canonicalMessageRequest(stored.event.payload as MessageRequest),
      ),
  );
export const projectConversationEvents = (
  records: readonly InternalTraceStoreRecord[],
  conversationId: string,
  artifactRegistry: ArtifactRegistry,
  afterSeq: number,
): PublicStoredTraceEvent[] => {
  const incompleteTerminal = records.findIndex(({ stored_event: stored }, index) => {
    if (stored.event.type !== "state_change" || !stored.event.payload.terminal) return false;
    const next = records[index + 1]?.stored_event.event;
    return (
      next?.type !== "conversation_terminal" ||
      next.payload.lifecycle !== stored.event.payload.lifecycle
    );
  });
  const visible = incompleteTerminal < 0 ? records : records.slice(0, incompleteTerminal);
  return visible
    .map((record) => projectPublicStoredTrace(record, { conversationId, artifactRegistry }))
    .filter((event) => event.seq > afterSeq);
};
export const conversationTransitionEpoch = (records: readonly InternalTraceStoreRecord[]): number =>
  Math.max(
    0,
    records.filter(
      ({ stored_event: stored }) =>
        stored.event.type === "state_change" &&
        !stored.event.payload.terminal &&
        (stored.event.payload.lifecycle === "ACTIVE" ||
          stored.event.payload.lifecycle === "PAUSED"),
    ).length - 1,
  );
export const isTerminalLifecycle = (value: string): value is TerminalLifecycle =>
  ["COMPLETED", "STOPPED", "FAILED", "ABORTED"].includes(value);
export const terminalResultStatus = (
  lifecycle: TerminalLifecycle,
): ConversationOrchestrationResult["status"] => {
  if (lifecycle === "COMPLETED") return "completed";
  if (lifecycle === "STOPPED") return "stopped";
  if (lifecycle === "FAILED") return "failed";
  return "aborted";
};
export const conversationTerminal = (
  status: ConversationOrchestrationResult["status"],
): TerminalLifecycle | null => {
  if (status === "completed") return "COMPLETED";
  if (status === "aborted") return "ABORTED";
  if (status === "failed") return "FAILED";
  return null;
};
export { projectOrchestrationResult } from "./boundary-projection.js";
const bindingAuthority = (
  participantId: string,
  binding: MaterializedAgentBinding,
): BindingAuthoritySnapshot => ({
  participant_id: participantId,
  engine: binding.resolved.engine,
  model: binding.resolved.model,
  session_mode: binding.resolved.sessionMode,
  role_source: binding.resolved.role.source,
  role_hash: binding.resolved.role.resolved_hash,
  skill_hashes: binding.resolved.skills.map((skill) => skill.resolved_hash),
});
export const bindingAuthorities = (
  manifest: ConversationManifest,
  bindings: readonly MaterializedAgentBinding[],
): BindingAuthoritySnapshot[] =>
  bindings.map((binding, index) =>
    bindingAuthority(manifest.bindings[index]?.participant_id ?? "", binding),
  );
export async function rehydrateConversation(
  id: string,
  store: ConversationArtifactStore,
  materialize: (
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ) => Promise<MaterializedAgentBinding>,
) {
  const record = store.readRecord(id);
  if (!record) throw new Error("conversation not found");
  const bindings = await Promise.all(
    record.manifest.bindings.map((binding) => materialize(binding, record.manifest)),
  );
  if (
    JSON.stringify(bindingAuthorities(record.manifest, bindings)) !==
    JSON.stringify(record.binding_authorities)
  ) {
    throw new Error("persisted binding authority changed");
  }
  return { record, bindings };
}
const bindingPatch = (
  binding: MaterializedAgentBinding,
  participantId: string,
): CorrelationPatch => ({
  participant_id: participantId,
  role_ref: binding.resolved.role.spec.name,
  role_resolved_hash: binding.resolved.role.resolved_hash,
  skill_refs: binding.resolved.skills.map((skill) => skill.ref),
  skill_resolved_hashes: binding.resolved.skills.map((skill) => skill.resolved_hash),
  engine: binding.resolved.engine,
});
export function configurationEmissions(
  manifest: ConversationManifest,
  bindings: readonly MaterializedAgentBinding[],
): RuntimeEmission[] {
  const output: RuntimeEmission[] = [
    {
      emission: {
        idempotency_key: "conversation:configured",
        event: {
          type: "conversation_configured",
          payload: {
            topic: manifest.topic,
            policy: manifest.policy,
            max_rounds: manifest.max_rounds,
            participants: bindings.map((binding, index) => ({
              participant_id: manifest.bindings[index]?.participant_id ?? "",
              role_ref: binding.resolved.role.spec.name,
              engine: binding.resolved.engine,
              model: binding.resolved.model,
            })),
          },
        },
      },
    },
    {
      emission: {
        idempotency_key: "conversation:coordinator",
        event: {
          type: "coordinator_decision",
          payload: { selected_policy: manifest.policy, reason: "explicit runtime policy" },
        },
      },
    },
  ];
  bindings.forEach((binding, index) => {
    const participantId = manifest.bindings[index]?.participant_id ?? "";
    const patch = bindingPatch(binding, participantId);
    output.push({
      patch,
      emission: {
        idempotency_key: `participant:${participantId}:bound`,
        event: {
          type: "participant_bound",
          payload: {
            participant_id: participantId,
            engine: binding.resolved.engine,
            model: binding.resolved.model,
            prompt_hash: binding.resolved.role.resolved_hash,
            tools: binding.resolved.role.spec.tools,
            sandbox: binding.resolved.sandbox ?? "read-only",
          },
        },
      },
    });
    for (const source of new Set(binding.resolved.skills.map((skill) => skill.source))) {
      const skills = binding.resolved.skills.filter((skill) => skill.source === source);
      output.push({
        patch,
        emission: {
          idempotency_key: `participant:${participantId}:skills:${source}`,
          event: {
            type: "skill_injected",
            payload: {
              skill_refs: skills.map((skill) => skill.ref),
              resolved_hashes: skills.map((skill) => skill.resolved_hash),
              source,
            },
          },
        },
      });
    }
  });
  output.push({
    emission: {
      idempotency_key: "conversation:active",
      event: {
        type: "state_change",
        payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
      },
    },
  });
  return output;
}
export function terminalEmissions(
  lifecycle: TerminalLifecycle,
  health: ConversationHealth,
  reason: string | null,
  finalScore: number | null,
): RuntimeEmission[] {
  return [
    {
      emission: {
        idempotency_key: "conversation:terminal-state",
        event: { type: "state_change", payload: { lifecycle, health, terminal: true, reason } },
      },
    },
    {
      emission: {
        idempotency_key: "conversation:terminal",
        event: {
          type: "conversation_terminal",
          payload: { lifecycle, terminal: true, final_score: finalScore },
        },
      },
    },
  ];
}
export function terminalJournalState(records: readonly InternalTraceStoreRecord[]): {
  hasState: boolean;
  winner: TerminalLifecycle | null;
} {
  const terminal = records.find(
    ({ stored_event: stored }) =>
      stored.idempotency_key === "conversation:terminal" &&
      stored.event.type === "conversation_terminal",
  );
  return {
    hasState: records.some(
      ({ stored_event: stored }) => stored.idempotency_key === "conversation:terminal-state",
    ),
    winner:
      terminal?.stored_event.event.type === "conversation_terminal"
        ? terminal.stored_event.event.payload.lifecycle
        : null,
  };
}
export interface RuntimeBinding {
  participantId: string;
  input: AgentBinding;
  materialized: MaterializedAgentBinding;
}
export interface RuntimeCreateRequest {
  topic: string;
  policy: string;
  maxRounds: number;
  baselineEnabled?: boolean;
  evaluatorAutoAdded?: boolean;
  repoRoot: string;
  phase: number;
  bindings: RuntimeBinding[];
  parent?: { conversationId: string; revisionId: string };
  private_file_range?: PrivateFileRangeHandoffBindingV1;
}
export interface RuntimePreviewRequest extends Omit<RuntimeCreateRequest, "bindings" | "parent"> {
  bindings: Array<{
    participantId: string;
    input: AgentBinding;
    preview: PreviewAgentBinding;
  }>;
}
export class ConversationPolicyRegistry {
  private readonly policies = new Map<string, ConversationPolicy>();
  constructor(policies: readonly ConversationPolicy[] = []) {
    for (const policy of policies) this.register(policy);
  }
  register(policy: ConversationPolicy): void {
    if (
      !policy?.name ||
      typeof policy.execute !== "function" ||
      typeof policy.dryRun !== "function"
    ) {
      throw new Error("invalid conversation policy");
    }
    if (this.policies.has(policy.name)) throw new Error(`duplicate policy: ${policy.name}`);
    this.policies.set(policy.name, policy);
  }
  require(name: string): ConversationPolicy {
    const policy = this.policies.get(name);
    if (!policy) throw new Error(`unknown conversation policy: ${name}`);
    return policy;
  }
}

import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import { projectPublicStoredTrace } from "../trace/project.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  TraceCorrelation,
  TraceEvent,
} from "../trace/types.js";
import type { BindingAuthoritySnapshot, ConversationArtifactStore } from "./artifact-store.js";
import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import {
  CONVERSATION_HEALTH,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_SANDBOX,
  CONVERSATION_TERMINAL_LIFECYCLES,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
// biome-ignore format: production file ceiling
import type {
  ConversationBinding, ConversationHealth, ConversationManifest, ConversationOrchestrationResult, ConversationPolicy, TerminalLifecycle,
} from "./types.js";
export { ConversationSubscribers } from "./subscribers.js";
export type {
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimePreviewRequest,
} from "./policy-registry-types.js";
export {
  canonicalMessageRequest,
  conversationMessages,
  messageRevisionKey,
} from "./conversation-message-request-authority.js";
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
export const projectConversationEvents = (
  records: readonly InternalTraceStoreRecord[],
  conversationId: string,
  artifactRegistry: ArtifactRegistry,
  afterSeq: number,
): PublicStoredTraceEvent[] => {
  const incompleteTerminal = records.findIndex(({ stored_event: stored }, index) => {
    if (
      stored.event.type !== CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE ||
      !stored.event.payload.terminal
    )
      return false;
    const next = records[index + 1]?.stored_event.event;
    return (
      next?.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL ||
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
        stored.event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE &&
        !stored.event.payload.terminal &&
        (stored.event.payload.lifecycle === CONVERSATION_LIFECYCLE.ACTIVE ||
          stored.event.payload.lifecycle === CONVERSATION_LIFECYCLE.PAUSED),
    ).length - 1,
  );
export const isTerminalLifecycle = (value: string): value is TerminalLifecycle =>
  CONVERSATION_TERMINAL_LIFECYCLES.some((lifecycle) => lifecycle === value);
export const terminalResultStatus = (
  lifecycle: TerminalLifecycle,
): ConversationOrchestrationResult["status"] => {
  if (lifecycle === CONVERSATION_LIFECYCLE.COMPLETED)
    return CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED;
  if (lifecycle === CONVERSATION_LIFECYCLE.STOPPED)
    return CONVERSATION_COMMAND_RESULT_STATUS.STOPPED;
  if (lifecycle === CONVERSATION_LIFECYCLE.FAILED) return CONVERSATION_COMMAND_RESULT_STATUS.FAILED;
  return CONVERSATION_COMMAND_RESULT_STATUS.ABORTED;
};
export const conversationTerminal = (
  status: ConversationOrchestrationResult["status"],
): TerminalLifecycle | null => {
  if (status === CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED)
    return CONVERSATION_LIFECYCLE.COMPLETED;
  if (status === CONVERSATION_COMMAND_RESULT_STATUS.ABORTED) return CONVERSATION_LIFECYCLE.ABORTED;
  if (status === CONVERSATION_COMMAND_RESULT_STATUS.FAILED) return CONVERSATION_LIFECYCLE.FAILED;
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
          type: CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_CONFIGURED,
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
          type: CONVERSATION_TRACE_EVENT_KIND.COORDINATOR_DECISION,
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
          type: CONVERSATION_TRACE_EVENT_KIND.PARTICIPANT_BOUND,
          payload: {
            participant_id: participantId,
            engine: binding.resolved.engine,
            model: binding.resolved.model,
            prompt_hash: binding.resolved.role.resolved_hash,
            tools: binding.resolved.role.spec.tools,
            sandbox: binding.resolved.sandbox ?? CONVERSATION_SANDBOX.READ_ONLY,
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
            type: CONVERSATION_TRACE_EVENT_KIND.SKILL_INJECTED,
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
        type: CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE,
        payload: {
          lifecycle: CONVERSATION_LIFECYCLE.ACTIVE,
          health: CONVERSATION_HEALTH.HEALTHY,
          terminal: false,
          reason: null,
        },
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
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE,
          payload: { lifecycle, health, terminal: true, reason },
        },
      },
    },
    {
      emission: {
        idempotency_key: "conversation:terminal",
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL,
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
      stored.event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL,
  );
  return {
    hasState: records.some(
      ({ stored_event: stored }) => stored.idempotency_key === "conversation:terminal-state",
    ),
    winner:
      terminal?.stored_event.event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL
        ? terminal.stored_event.event.payload.lifecycle
        : null,
  };
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

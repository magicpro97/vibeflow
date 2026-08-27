import type { MaterializedAgentBinding } from "../../agents/binding.js";
import { digestV1 } from "../../durability/index.js";
import type { ConversationManifest } from "./types.js";

export const CONVERSATION_REVISION_POLICY_AUTHORITY_SCHEMA_VERSION = "1.0" as const;
export const CONVERSATION_REVISION_POLICY_AUTHORITY_DIGEST_DOMAIN =
  "VF-CONVERSATION-REVISION-POLICY-AUTHORITY\0v1\0" as const;

/** Binds the existing source authority and the complete normalized target topology. */
export function conversationRevisionPolicyAuthorityDigest(input: {
  root_session_id: string;
  conversation_lock_digest: string;
  topology_digest: string;
  resolved_binding_set_digest: string;
}): string {
  return digestV1(CONVERSATION_REVISION_POLICY_AUTHORITY_DIGEST_DOMAIN, {
    schema_version: CONVERSATION_REVISION_POLICY_AUTHORITY_SCHEMA_VERSION,
    root_session_id: input.root_session_id,
    conversation_lock_digest: input.conversation_lock_digest,
    topology_digest: input.topology_digest,
    resolved_binding_set_digest: input.resolved_binding_set_digest,
  });
}

/** Public, ordered view of the exact role/sandbox/tool authority used by review. */
export function conversationRevisionTopologyPreview(input: {
  manifest: ConversationManifest;
  bindings: readonly MaterializedAgentBinding[];
}) {
  if (input.manifest.bindings.length !== input.bindings.length)
    throw new Error("conversation topology preview materialization is incomplete");
  return {
    policy: input.manifest.policy,
    participants: input.manifest.bindings.map((manifestBinding, index) => {
      const materialized = input.bindings[index];
      if (!materialized) throw new Error("conversation topology preview binding is absent");
      return {
        participant_id: manifestBinding.participant_id,
        role_ref: manifestBinding.input.roleRef,
        role_source: materialized.resolved.role.source,
        engine: materialized.resolved.engine,
        model: materialized.resolved.model,
        model_override: manifestBinding.input.modelOverride ?? null,
        session_mode: materialized.resolved.sessionMode,
        sandbox: materialized.resolved.sandbox,
        skill_refs: [...(manifestBinding.input.additionalSkillRefs ?? [])],
        native_tool_intents: [...materialized.resolved.tool_intents],
        host_tools: [...(manifestBinding.host_tools ?? [])],
      };
    }),
  };
}

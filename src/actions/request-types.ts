import type { CapabilityScope, EngineName, HostActionKind, JsonScalar } from "./types.js";

export interface ParticipantInputV1 {
  role_ref: string;
  engine: EngineName;
  model: string | null;
  skill_refs: string[];
}
export interface ParticipantBindingDeltaV1 {
  role_ref?: string;
  engine?: EngineName;
  model?: string | null;
  skill_refs?: string[];
}
export interface ConversationSettingDeltaV1 {
  policy?: string;
  max_rounds?: number;
  baseline_enabled?: boolean;
}
export interface ConversationPublicQuoteReferenceV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  target_event_id: string;
  target_kind: "user-message" | "completed-agent-response";
  content_digest: string;
  author_public_id: string;
}
export interface PackageSelectorV1 {
  id: string;
  version?: string;
  source_kind?: "registry" | "git" | "local-dev" | "legacy-adopt";
  content_sha256?: string;
  package_pin_digest?: string;
}
export interface CapabilityTargetSelectorV1 {
  engine: EngineName;
  participant_id: string | null;
}
export interface CapabilityPublicInputV1 {
  input_id: string;
  value: JsonScalar | { private_input_binding_id: string; binding_digest: string };
}
export type RuntimeEnforcementV1 =
  | "brokered"
  | "sandboxed"
  | "engine-enforced"
  | "disclosed-not-enforced"
  | "unsupported";
export type CapabilityPermissionKindScopeV1 =
  | {
      kind: "filesystem";
      scope: { root: "project" | "user-home"; access: "read" | "write"; path_prefix: string };
    }
  | {
      kind: "network";
      scope: {
        transport: "https" | "git-https" | "mcp-https";
        host: string;
        port: number | null;
        path_prefix: string;
      };
    }
  | {
      kind: "process";
      scope: { executable_class: string; argv_prefix: string[]; allow_additional_args: boolean };
    }
  | { kind: "shell"; scope: { adapter_id: string; template_id: string } }
  | {
      kind: "config";
      scope: {
        engine: EngineName;
        namespace: string;
        access: "read" | "write";
        key_prefix: string;
      };
    }
  | { kind: "secret"; scope: { input_ids: string[] } }
  | {
      kind: "hook";
      scope: { engine: EngineName; hook_point: string; participant_id: string | null };
    };
export type GrantedPermissionBindingV1 = CapabilityPermissionKindScopeV1 & {
  schema_version: "1.0";
  permission_id: string;
  target_ids: string[];
  enforcement: RuntimeEnforcementV1;
  binding_digest: string;
};
export interface GrantInputV1 {
  scope: CapabilityScope;
  principal_id: string;
  action_types: Array<HostActionKind | "capability.discover">;
  permissions: GrantedPermissionBindingV1[];
  target_engines: EngineName[];
  expires_at: string;
}
export interface RegistryTrustKeyInputV1 {
  transition: "added" | "rescoped" | "deprecated" | "revoked";
  key_id: string;
  algorithm: "Ed25519";
  public_key_spki_base64: string;
  registry_origin: string;
  publisher_id: string | null;
  valid_from: string;
  valid_until: string;
  reason: string | null;
}
export type PolicyJsonValueV1 =
  | JsonScalar
  | PolicyJsonValueV1[]
  | { [key: string]: PolicyJsonValueV1 };
export interface PublicCompactionInputV1 {
  schema_version: "1.0";
  profile: "vf-public-compaction/1";
  public_summary: string;
  retained_event_ids: string[];
  retained_artifact_ids: string[];
  input_digest: string;
}

export type HostActionRequestV1 =
  | { type: "conversation.add_participant"; participant: ParticipantInputV1 }
  | { type: "conversation.remove_participant"; participant_id: string }
  | {
      type: "conversation.update_participant";
      participant_id: string;
      changes: ParticipantBindingDeltaV1;
    }
  | { type: "conversation.update_settings"; changes: ConversationSettingDeltaV1 }
  | {
      type: "conversation.continue_message";
      content: string;
      target_participants: "all" | string[];
      quote_refs?: ConversationPublicQuoteReferenceV1[];
    }
  | {
      type: "conversation.select_lineage_head";
      root_session_id: string;
      candidate_conversation_id: string;
      candidate_revision_id: string;
    }
  | { type: "conversation.associate_lineages"; root_session_ids: string[]; reason: string }
  | {
      type: "conversation.publish_suspected_literal";
      private_staging_id: string;
      staging_record_digest: string;
      staged_content_digest: string;
      findings_digest: string;
    }
  | { type: "conversation.stop_operation"; operation_id: string }
  | { type: "conversation.abandon_revision_operation"; revision_operation_id: string }
  | { type: "conversation.retry_revision_operation"; revision_operation_id: string }
  | { type: "conversation.reconcile_revision_operation"; revision_operation_id: string }
  | {
      type: "context.compact";
      oversized_candidate_id: string;
      oversized_candidate_digest: string;
      profile: "vf-public-compaction/1";
      compaction_input: PublicCompactionInputV1;
    }
  | {
      type: "capability.install";
      package: PackageSelectorV1;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[];
      inputs: CapabilityPublicInputV1[];
    }
  | {
      type: "capability.update";
      package_id: string;
      selector: PackageSelectorV1;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[] | null;
      inputs: CapabilityPublicInputV1[] | null;
    }
  | {
      type: "capability.configure";
      package_id: string;
      scope: CapabilityScope;
      inputs: CapabilityPublicInputV1[];
    }
  | {
      type: "capability.retarget";
      package_id: string;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[];
    }
  | { type: "capability.remove"; package_id: string; scope: CapabilityScope; cascade: boolean }
  | { type: "capability.rollback_scope"; scope: CapabilityScope; generation_id: string }
  | {
      type: "capability.restore_package";
      package_id: string;
      scope: CapabilityScope;
      generation_id: string;
    }
  | { type: "capability.repair"; package_id: string | null; scope: CapabilityScope }
  | {
      type: "capability.adopt";
      scope: CapabilityScope;
      candidate_id: string;
      candidate_digest: string;
    }
  | { type: "grant.create"; grant: GrantInputV1 }
  | { type: "grant.renew"; grant_id: string; grant: GrantInputV1 }
  | { type: "grant.revoke"; scope: CapabilityScope; grant_id: string }
  | {
      type: "policy.update_authority";
      scope: CapabilityScope;
      replacement_authority_subtree: PolicyJsonValueV1;
    }
  | {
      type: "secret.revoke";
      scope: CapabilityScope;
      private_binding_id: string;
      expected_binding_digest: string;
    }
  | { type: "registry.trust_key"; scope: CapabilityScope; change: RegistryTrustKeyInputV1 }
  | { type: "authority.repair"; repair_id: string; plan_digest: string };

export type BrowserHostActionRequestV1 = Exclude<HostActionRequestV1, { type: "authority.repair" }>;

export function isHostActionKind(value: string): value is HostActionKind {
  return HOST_ACTION_KINDS.has(value as HostActionKind);
}

export const HOST_ACTION_KINDS: ReadonlySet<HostActionKind> = new Set<HostActionKind>([
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
  "conversation.continue_message",
  "conversation.select_lineage_head",
  "conversation.associate_lineages",
  "conversation.publish_suspected_literal",
  "conversation.stop_operation",
  "conversation.abandon_revision_operation",
  "conversation.retry_revision_operation",
  "conversation.reconcile_revision_operation",
  "context.compact",
  "capability.install",
  "capability.update",
  "capability.configure",
  "capability.retarget",
  "capability.remove",
  "capability.rollback_scope",
  "capability.restore_package",
  "capability.repair",
  "capability.adopt",
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "policy.update_authority",
  "secret.revoke",
  "registry.trust_key",
  "authority.repair",
]);

const _assertDiscriminants: Record<HostActionKind, true> = Object.fromEntries(
  [...HOST_ACTION_KINDS].map((kind) => [kind, true]),
) as Record<HostActionKind, true>;
void _assertDiscriminants;

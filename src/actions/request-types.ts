import type { ConversationMessageQueueQuoteTargetKindV1 } from "../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "../orchestrator/conversation/conversation-public-wire-contract.js";
import type {
  CAPABILITY_MANIFEST_PERMISSION_KIND,
  CapabilityManifestAccess,
  CapabilityManifestFilesystemRoot,
  CapabilityManifestNetworkTransport,
} from "./capability-manifest-vocabulary-contract.js";

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;
import type {
  CAPABILITY_SIGNATURE_ALGORITHM,
  CapabilityTrustTransition,
} from "./capability-security-contract.js";
import {
  type AuthorizableActionKind,
  type HOST_ACTION_KIND,
  HOST_ACTION_KIND_VALUES,
  type HostActionKind,
  isHostActionKind,
} from "./host-action-contract.js";
import type {
  ActionPackagePinSourceKind,
  ActionRuntimeEnforcement,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import type { CapabilityScope, EngineName, JsonScalar } from "./types.js";

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
  target_kind: ConversationMessageQueueQuoteTargetKindV1;
  content_digest: string;
  author_public_id: string;
}
export interface PackageSelectorV1 {
  id: string;
  version?: string;
  source_kind?: ActionPackagePinSourceKind;
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
export type RuntimeEnforcementV1 = ActionRuntimeEnforcement;
export type CapabilityPermissionKindScopeV1 =
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM;
      scope: {
        root: CapabilityManifestFilesystemRoot;
        access: CapabilityManifestAccess;
        path_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK;
      scope: {
        transport: CapabilityManifestNetworkTransport;
        host: string;
        port: number | null;
        path_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS;
      scope: { executable_class: string; argv_prefix: string[]; allow_additional_args: boolean };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL;
      scope: { adapter_id: string; template_id: string };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG;
      scope: {
        engine: EngineName;
        namespace: string;
        access: CapabilityManifestAccess;
        key_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET;
      scope: { input_ids: string[] };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK;
      scope: { engine: EngineName; hook_point: string; participant_id: string | null };
    };
export type GrantedPermissionBindingV1 = CapabilityPermissionKindScopeV1 & {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  permission_id: string;
  target_ids: string[];
  enforcement: RuntimeEnforcementV1;
  binding_digest: string;
};
export interface GrantInputV1 {
  scope: CapabilityScope;
  principal_id: string;
  action_types: AuthorizableActionKind[];
  permissions: GrantedPermissionBindingV1[];
  target_engines: EngineName[];
  expires_at: string;
}
export interface RegistryTrustKeyInputV1 {
  transition: CapabilityTrustTransition;
  key_id: string;
  algorithm: typeof CAPABILITY_SIGNATURE_ALGORITHM.ED25519;
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
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  profile: typeof CONVERSATION_PUBLIC_PROFILE.COMPACTION;
  public_summary: string;
  retained_event_ids: string[];
  retained_artifact_ids: string[];
  input_digest: string;
}

export type HostActionRequestV1 =
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT; participant: ParticipantInputV1 }
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT; participant_id: string }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT;
      participant_id: string;
      changes: ParticipantBindingDeltaV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS;
      changes: ConversationSettingDeltaV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE;
      content: string;
      target_participants: "all" | string[];
      quote_refs?: ConversationPublicQuoteReferenceV1[];
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD;
      root_session_id: string;
      candidate_conversation_id: string;
      candidate_revision_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES;
      root_session_ids: string[];
      reason: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL;
      private_staging_id: string;
      staging_record_digest: string;
      staged_content_digest: string;
      findings_digest: string;
    }
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION; operation_id: string }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION;
      revision_operation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION;
      revision_operation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION;
      revision_operation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONTEXT_COMPACT;
      oversized_candidate_id: string;
      oversized_candidate_digest: string;
      profile: PublicCompactionInputV1["profile"];
      compaction_input: PublicCompactionInputV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_INSTALL;
      package: PackageSelectorV1;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[];
      inputs: CapabilityPublicInputV1[];
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_UPDATE;
      package_id: string;
      selector: PackageSelectorV1;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[] | null;
      inputs: CapabilityPublicInputV1[] | null;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_CONFIGURE;
      package_id: string;
      scope: CapabilityScope;
      inputs: CapabilityPublicInputV1[];
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_RETARGET;
      package_id: string;
      scope: CapabilityScope;
      requested_targets: CapabilityTargetSelectorV1[];
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_REMOVE;
      package_id: string;
      scope: CapabilityScope;
      cascade: boolean;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_ROLLBACK_SCOPE;
      scope: CapabilityScope;
      generation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_RESTORE_PACKAGE;
      package_id: string;
      scope: CapabilityScope;
      generation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_REPAIR;
      package_id: string | null;
      scope: CapabilityScope;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_ADOPT;
      scope: CapabilityScope;
      candidate_id: string;
      candidate_digest: string;
    }
  | { type: typeof HOST_ACTION_KIND.GRANT_CREATE; grant: GrantInputV1 }
  | { type: typeof HOST_ACTION_KIND.GRANT_RENEW; grant_id: string; grant: GrantInputV1 }
  | { type: typeof HOST_ACTION_KIND.GRANT_REVOKE; scope: CapabilityScope; grant_id: string }
  | {
      type: typeof HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY;
      scope: CapabilityScope;
      replacement_authority_subtree: PolicyJsonValueV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.SECRET_REVOKE;
      scope: CapabilityScope;
      private_binding_id: string;
      expected_binding_digest: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.REGISTRY_TRUST_KEY;
      scope: CapabilityScope;
      change: RegistryTrustKeyInputV1;
    }
  | { type: typeof HOST_ACTION_KIND.AUTHORITY_REPAIR; repair_id: string; plan_digest: string };

export type BrowserHostActionRequestV1 = Exclude<
  HostActionRequestV1,
  { type: typeof HOST_ACTION_KIND.AUTHORITY_REPAIR }
>;

export { isHostActionKind };

/** @deprecated Import `HOST_ACTION_KIND_VALUES` and `isHostActionKind` from the core contract. */
export const HOST_ACTION_KINDS: readonly HostActionKind[] = HOST_ACTION_KIND_VALUES;

const _assertDiscriminants = true satisfies SameUnion<HostActionRequestV1["type"], HostActionKind>;
void _assertDiscriminants;

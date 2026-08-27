import type { ACTOR_KIND, CREDENTIAL_CLASS } from "../../actions/public-action-contract.js";
import type { ActionApprovalChallengeClass } from "../../actions/public-action-contract.js";
import type { PublicActor } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { AuthorityAutomationGrantProofV1 } from "../authority-mutation/types.js";
import type {
  CapabilityCliResultV1,
  FabricCliMutationCommandV1,
  FabricCliMutationRequestV1,
} from "../wire/cli.js";

export interface CapabilityCliMutationContextV1 {
  actor: PublicActor;
  stdin_is_tty: boolean;
  automation_grant_proof?: AuthorityAutomationGrantProofV1 | null;
}

export interface CapabilityCliMutationRequestExecutionV1 {
  schema_version: typeof CAPABILITY_CLI_SCHEMA_VERSION;
  command: Exclude<FabricCliMutationCommandV1, typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR>;
  request: FabricCliMutationRequestV1;
  context: CapabilityCliMutationContextV1;
  approve: boolean;
}

export type CapabilityCliAuthoritySecretSelectorV1 =
  | {
      kind: "candidate";
      candidate_id: string;
      candidate_digest: string;
    }
  | {
      kind: "binding";
      package_id: string;
      input_id: string;
    };

export interface CapabilityCliAuthoritySecretRevokeExecutionV1 {
  schema_version: typeof CAPABILITY_CLI_SCHEMA_VERSION;
  command: typeof CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE;
  scope: CapabilityScope;
  idempotency_key: string;
  secret: CapabilityCliAuthoritySecretSelectorV1;
  context: CapabilityCliMutationContextV1;
  approve: boolean;
}

export interface CapabilityCliAuthorityRepairExecutionV1 {
  schema_version: typeof CAPABILITY_CLI_SCHEMA_VERSION;
  command: typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR;
  scope: CapabilityScope;
  conversation_id: string | null;
  context: CapabilityCliMutationContextV1 & {
    actor: PublicActor & {
      kind: typeof ACTOR_KIND.HUMAN_CLI;
      credential_class: typeof CREDENTIAL_CLASS.RECOVERY;
    };
    stdin_is_tty: true;
  };
}

export interface AuthorityRepairCliCandidateOptionV1 {
  candidate_id: string;
  action_domain: "conversation" | "capability";
  authority_scope: CapabilityScope | "conversation";
  scope_id: string;
  control_state: "current-valid" | "recovery-checkpoint-only";
  strategy: string;
  created_at: string;
  expires_at: string;
}

export interface AuthorityRepairCliCriticalReviewPromptV1 {
  scope: CapabilityScope;
  conversation_id: string | null;
  candidate: AuthorityRepairCliCandidateOptionV1;
  plan_digest: string;
  repair_id: string;
  bootstrap_required: boolean;
}

export interface AuthorityRepairCliRecoveryReviewPromptV1 {
  scope: CapabilityScope;
  conversation_id: string | null;
  candidate: AuthorityRepairCliCandidateOptionV1;
  operation_id: string;
  observed_authority_digest: string | null;
}

export interface AuthorityRepairCliInteractionV1 {
  readonly authenticated_local_tty: true;
  selectCandidate(input: {
    scope: CapabilityScope;
    conversation_id: string | null;
    candidates: readonly AuthorityRepairCliCandidateOptionV1[];
  }): string | null;
  confirmCriticalReview(input: AuthorityRepairCliCriticalReviewPromptV1): boolean;
  confirmRecoveryReview(input: AuthorityRepairCliRecoveryReviewPromptV1): boolean;
}

export interface AuthorityApprovalCliInteractionV1 {
  readonly authenticated_local_tty: true;
  respondToChallenge(input: {
    scope: CapabilityScope;
    command: Exclude<
      CapabilityCliAuthorityMutationCommand,
      typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
    >;
    proposal_id: string;
    proposal_digest: string;
    challenge_id: string;
    challenge_class: ActionApprovalChallengeClass;
    display_phrase: string;
    expires_at: string;
  }): string | null;
}

export interface CapabilityCliAuthorityRepairRuntimeV1 {
  execute(
    input: CapabilityCliAuthorityRepairExecutionV1,
    interaction: AuthorityRepairCliInteractionV1,
  ): CapabilityCliResultV1;
}

export type CapabilityCliMutationInputV1 =
  | CapabilityCliMutationRequestExecutionV1
  | CapabilityCliAuthoritySecretRevokeExecutionV1
  | CapabilityCliAuthorityRepairExecutionV1;

export interface CapabilityCliMutationPortV1 {
  execute(input: CapabilityCliMutationInputV1): CapabilityCliResultV1;
}
import type {
  CAPABILITY_CLI_COMMAND,
  CAPABILITY_CLI_SCHEMA_VERSION,
  CapabilityCliAuthorityMutationCommand,
} from "../../actions/capability-cli-contract.js";

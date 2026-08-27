import type { ACTOR_KIND, CREDENTIAL_CLASS } from "../../actions/public-action-contract.js";
import type { PublicActor } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type {
  CapabilityCliResultV1,
  FabricCliMutationCommandV1,
  FabricCliMutationRequestV1,
} from "../wire/cli.js";

export interface CapabilityCliMutationContextV1 {
  actor: PublicActor;
  stdin_is_tty: boolean;
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
} from "../../actions/capability-cli-contract.js";

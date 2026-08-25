import type { PublicActor } from "../../actions/types.js";
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
  schema_version: "1.0";
  command: Exclude<FabricCliMutationCommandV1, "authority.repair">;
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
  schema_version: "1.0";
  command: "authority.secret.revoke";
  scope: "project" | "user";
  idempotency_key: string;
  secret: CapabilityCliAuthoritySecretSelectorV1;
  context: CapabilityCliMutationContextV1;
  approve: boolean;
}

export interface CapabilityCliAuthorityRepairExecutionV1 {
  schema_version: "1.0";
  command: "authority.repair";
  scope: "project" | "user";
  conversation_id: string | null;
  context: CapabilityCliMutationContextV1 & {
    actor: PublicActor & {
      kind: "human-cli";
      credential_class: "recovery";
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

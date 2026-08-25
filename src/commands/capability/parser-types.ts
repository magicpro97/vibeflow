import type { CapabilityPublicInputV1 } from "../../actions/request-types.js";
import type { FabricCliMutationCommandV1 } from "../../capabilities/wire/cli.js";

export type Scope = "project" | "user";
export type EngineName = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
export type PrivateReferenceV1 = Extract<CapabilityPublicInputV1["value"], object>;

export interface CapabilityParserIo {
  stdinIsTTY: boolean;
  stdinHasData: boolean;
}

export class CapabilityCliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CapabilityCliUsageError";
  }
}

export interface ParsedCliCommonOptionsV1 {
  scope?: Scope;
  idempotencyKey?: string;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  offline: boolean;
  allowNetworkRead: boolean;
}

export interface ParsedCapabilityQueryV1 extends ParsedCliCommonOptionsV1 {
  kind: "query";
  command: "capability.search" | "capability.list" | "capability.status";
  query?: string;
  packageId?: string;
  engines: EngineName[];
  refresh: boolean;
}

export interface ParsedCapabilityInspectionV1 extends ParsedCliCommonOptionsV1 {
  kind: "inspection";
  command: "capability.adopt.inspect";
  mode: "direct";
  legacySources: string[];
}

export interface ParsedCapabilityDirectMutationV1 extends ParsedCliCommonOptionsV1 {
  kind: "mutation";
  command: Exclude<FabricCliMutationCommandV1, `authority.${string}` | "authority.repair">;
  mode: "direct";
  packageId?: string;
  query?: string;
  generationId?: string;
  packagePinDigest?: string;
  fromGenerationId?: string;
  candidateId?: string;
  candidateDigest?: string;
  engines: EngineName[];
  publicInputs: Array<{
    input_id: string;
    value: Extract<CapabilityPublicInputV1["value"], string | number | boolean | null>;
  }>;
  privateInputs: Array<{ input_id: string; reference: PrivateReferenceV1 }>;
  legacySources: string[];
  cascade: boolean;
}

export interface ParsedCapabilityRequestFileMutationV1 extends ParsedCliCommonOptionsV1 {
  kind: "mutation";
  command: Exclude<
    FabricCliMutationCommandV1,
    `authority.${string}` | "authority.repair" | "capability.private-input.bind"
  >;
  mode: "request-file";
  requestFile: string;
}

export interface ParsedCapabilityPrivateInputBindV1 extends ParsedCliCommonOptionsV1 {
  kind: "private-input";
  command: "capability.private-input.bind";
  mode: "direct";
  packageId?: string;
  packagePinDigest?: string;
  inputIds: string[];
  valuesStdin: boolean;
}

export type ParsedCapabilityCliArgvV1 =
  | ParsedCapabilityQueryV1
  | ParsedCapabilityInspectionV1
  | ParsedCapabilityDirectMutationV1
  | ParsedCapabilityRequestFileMutationV1
  | ParsedCapabilityPrivateInputBindV1;

export interface ParsedAuthorityDirectMutationV1 extends ParsedCliCommonOptionsV1 {
  kind: "mutation";
  command: Extract<FabricCliMutationCommandV1, `authority.${string}`>;
  mode: "direct";
  grantFile?: string;
  grantId?: string;
  replacementFile?: string;
  trustFile?: string;
  packageId?: string;
  inputId?: string;
  candidateId?: string;
  candidateDigest?: string;
  conversationId?: string;
}

export interface ParsedAuthorityRequestFileMutationV1 extends ParsedCliCommonOptionsV1 {
  kind: "mutation";
  command: Exclude<Extract<FabricCliMutationCommandV1, `authority.${string}`>, "authority.repair">;
  mode: "request-file";
  requestFile: string;
}

export type ParsedAuthorityCliArgvV1 =
  | ParsedAuthorityDirectMutationV1
  | ParsedAuthorityRequestFileMutationV1;

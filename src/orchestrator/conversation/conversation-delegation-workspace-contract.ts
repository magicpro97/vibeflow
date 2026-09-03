import type { OwnedProcessPlatform } from "../../dispatch/owned-process-platform.js";
import type {
  ConversationDelegationGitRunnerV1,
  ConversationDelegationPathNormalizerV1,
} from "./conversation-delegation-workspace-git.js";
import type {
  ConversationDelegationTaskBindingV1,
  ConversationDelegationTaskCompletionV1,
} from "./conversation-delegation-workspace-task.js";
import type { ConversationDelegationWorkspaceVerifierV1 } from "./conversation-delegation-workspace-verification.js";

export const CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT = Object.freeze({
  VERIFYING_PERSISTED: "verifying-persisted",
  VERIFICATION_PROOF_PERSISTED: "verification-proof-persisted",
} as const);
export type ConversationDelegationWorkspaceFaultPointV1 =
  (typeof CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT)[keyof typeof CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT];

export const CONVERSATION_DELEGATION_VERIFY_ORACLE = Object.freeze({
  GIT_DIFF_CHECK_PARENT: "git diff --check HEAD^ HEAD",
  BUN_TEST: "bun test",
  TYPESCRIPT_NO_EMIT: "bunx tsc --noEmit",
  BIOME_CHECK_REPOSITORY: "bunx biome check .",
} as const);
export type ConversationDelegationVerifyOracleV1 =
  (typeof CONVERSATION_DELEGATION_VERIFY_ORACLE)[keyof typeof CONVERSATION_DELEGATION_VERIFY_ORACLE];
export const CONVERSATION_DELEGATION_VERIFY_ORACLES = Object.freeze(
  Object.values(CONVERSATION_DELEGATION_VERIFY_ORACLE),
) as readonly ConversationDelegationVerifyOracleV1[];
export const CONVERSATION_DELEGATION_TASK_DIAGNOSTIC = Object.freeze({
  VERIFY_ORACLE_UNSUPPORTED: "coordination_verify_oracle_unsupported",
  SCOPE_SELECTOR_INVALID: "coordination_scope_selector_invalid",
  FORBIDDEN_SELECTOR_INVALID: "coordination_forbidden_selector_invalid",
} as const);

export function conversationDelegationOracleInvocation(command: string): {
  executable: "git" | "bun" | "bunx";
  argv: readonly string[];
} | null {
  if (command === CONVERSATION_DELEGATION_VERIFY_ORACLE.GIT_DIFF_CHECK_PARENT)
    return { executable: "git", argv: ["diff", "--check", "HEAD^", "HEAD"] };
  if (command === CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST)
    return { executable: "bun", argv: ["test"] };
  if (command === CONVERSATION_DELEGATION_VERIFY_ORACLE.TYPESCRIPT_NO_EMIT)
    return { executable: "bunx", argv: ["tsc", "--noEmit"] };
  if (command === CONVERSATION_DELEGATION_VERIFY_ORACLE.BIOME_CHECK_REPOSITORY)
    return { executable: "bunx", argv: ["biome", "check", "."] };
  return null;
}

export interface ConversationDelegationWorkspaceIdentityV1 {
  repoRoot: string;
  workflowId: string;
  workspaceKey: string;
}
export interface ConversationDelegationWorkspaceLeaseInputV1
  extends ConversationDelegationWorkspaceIdentityV1 {
  task: ConversationDelegationTaskBindingV1;
}
export interface ConversationDelegationWorkspaceVerifyInputV1
  extends ConversationDelegationWorkspaceIdentityV1 {
  completion: ConversationDelegationTaskCompletionV1;
}
export interface ConversationDelegationWorkspaceAuthorityOptionsV1 {
  artifactRoot: string;
  temporaryRoot?: string;
  now?: () => string;
  runGit?: ConversationDelegationGitRunnerV1;
  verify?: ConversationDelegationWorkspaceVerifierV1;
  ownedProcessPlatform?: OwnedProcessPlatform;
  ownerPid?: number;
  authorityId?: string;
  createVerificationAttemptId?: () => string;
  platform?: NodeJS.Platform;
  normalizePath?: ConversationDelegationPathNormalizerV1;
  fault?: (point: ConversationDelegationWorkspaceFaultPointV1) => void;
}

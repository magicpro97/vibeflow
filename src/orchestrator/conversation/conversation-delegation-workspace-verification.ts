import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  digestV1,
  ensurePrivateDirectory,
  sha256Digest,
} from "../../durability/index.js";
import { sanitizedGitEnvironment } from "../../git-environment.js";
import { type PolicyVerifyReport, verifyGateManifestOk } from "../../verify/core.js";
import { writePrivateAtomic } from "../trace/path-safety.js";
import { conversationDelegationOracleInvocation } from "./conversation-delegation-workspace-contract.js";
import {
  CONVERSATION_DELEGATION_DIGEST,
  CONVERSATION_DELEGATION_WORKSPACE_ID,
  CONVERSATION_DELEGATION_WORKSPACE_LIMIT,
  type ConversationDelegationWorkspaceRecordV1,
} from "./conversation-delegation-workspace-records.js";

export const CONVERSATION_DELEGATION_ORACLE_EXECUTION_LIMIT = Object.freeze({
  TIMEOUT_MS: 10 * 60 * 1_000,
  MAX_BUFFER_BYTES: 8 * 1024 * 1024,
} as const);

export interface ConversationDelegationOracleExecutionV1 {
  command: string;
  executable: "git" | "bun" | "bunx";
  argv: string[];
  exit_code: 0;
  stdout_digest: string;
  stderr_digest: string;
}

export interface ConversationDelegationOracleProcessInputV1 {
  cwd: string;
  executable: ConversationDelegationOracleExecutionV1["executable"];
  argv: readonly string[];
  shell: false;
}
export interface ConversationDelegationOracleProcessResultV1 {
  exit_code: number;
  stdout: string;
  stderr: string;
}
export type ConversationDelegationOracleProcessRunnerV1 = (
  input: ConversationDelegationOracleProcessInputV1,
) => Promise<ConversationDelegationOracleProcessResultV1>;

export interface ConversationDelegationWorkspaceVerificationResultV1 {
  report: PolicyVerifyReport;
  oracle_results: ConversationDelegationOracleExecutionV1[];
}
export type ConversationDelegationWorkspaceVerifierV1 = (input: {
  cwd: string;
  expected_oracles: readonly string[];
}) => Promise<ConversationDelegationWorkspaceVerificationResultV1>;

export interface ConversationDelegationWorkspaceVerificationV1 {
  schema_version: "1.0";
  workspace_id: string;
  primary_ref: string;
  head: string;
  verification_attempt_id: string;
  task_id: string;
  task_contract_digest: string;
  task_scope: string[];
  task_forbidden: string[];
  task_base_head: string;
  changed_paths: string[];
  expected_oracles: string[];
  oracle_results: ConversationDelegationOracleExecutionV1[];
  passed: boolean;
  report: PolicyVerifyReport;
  verified_at: string;
  proof_digest: string;
}

const fail = (message: string): never => {
  throw new Error(message);
};
const productionOracleProcess: ConversationDelegationOracleProcessRunnerV1 = (input) =>
  new Promise((resolve) => {
    execFile(
      input.executable,
      [...input.argv],
      {
        cwd: input.cwd,
        encoding: "utf8",
        env: sanitizedGitEnvironment(),
        maxBuffer: CONVERSATION_DELEGATION_ORACLE_EXECUTION_LIMIT.MAX_BUFFER_BYTES,
        shell: input.shell,
        timeout: CONVERSATION_DELEGATION_ORACLE_EXECUTION_LIMIT.TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        resolve({ exit_code: exitCode, stdout, stderr });
      },
    );
  });

export async function runConversationDelegationVerificationOracles(
  cwd: string,
  expectedOracles: readonly string[],
  run: ConversationDelegationOracleProcessRunnerV1 = productionOracleProcess,
): Promise<ConversationDelegationOracleExecutionV1[]> {
  if (
    expectedOracles.length === 0 ||
    expectedOracles.length > CONVERSATION_DELEGATION_WORKSPACE_LIMIT.LIST_ITEMS ||
    new Set(expectedOracles).size !== expectedOracles.length
  )
    fail("invalid coordination verification oracle authority");
  const results: ConversationDelegationOracleExecutionV1[] = [];
  for (const command of expectedOracles) {
    const invocation =
      conversationDelegationOracleInvocation(command) ??
      fail("unsupported coordination verification oracle");
    const completed = await run({
      cwd,
      executable: invocation.executable,
      argv: invocation.argv,
      shell: false,
    });
    if (completed.exit_code !== 0) fail("coordination verification oracle failed");
    results.push({
      command,
      executable: invocation.executable,
      argv: [...invocation.argv],
      exit_code: 0,
      stdout_digest: sha256Digest(Buffer.from(completed.stdout, "utf8")),
      stderr_digest: sha256Digest(Buffer.from(completed.stderr, "utf8")),
    });
  }
  return results;
}

export function assertConversationDelegationOracleResults(
  expected: readonly string[],
  observed: readonly ConversationDelegationOracleExecutionV1[],
): void {
  if (expected.length === 0 || observed.length !== expected.length)
    fail("coordination verification oracle evidence mismatch");
  expected.forEach((command, index) => {
    const result = observed[index];
    const invocation = conversationDelegationOracleInvocation(command);
    if (
      !result ||
      !invocation ||
      result.command !== command ||
      result.executable !== invocation.executable ||
      result.exit_code !== 0 ||
      result.argv.length !== invocation.argv.length ||
      !result.argv.every((value, position) => value === invocation.argv[position]) ||
      !CONVERSATION_DELEGATION_DIGEST.test(result.stdout_digest) ||
      !CONVERSATION_DELEGATION_DIGEST.test(result.stderr_digest)
    )
      fail("coordination verification oracle evidence mismatch");
  });
}

export class ConversationDelegationWorkspaceVerificationStoreV1 {
  private readonly root: string;

  constructor(
    artifactRoot: string,
    private readonly now: () => string,
  ) {
    this.root = ensurePrivateDirectory(
      join(artifactRoot, "coordination-workspaces", "v1", "verify"),
    );
  }

  write(
    record: ConversationDelegationWorkspaceRecordV1,
    verification: ConversationDelegationWorkspaceVerificationResultV1,
  ): ConversationDelegationWorkspaceVerificationV1 {
    if (!CONVERSATION_DELEGATION_WORKSPACE_ID.test(record.workspace_id))
      fail("invalid workspace verification identity");
    const attemptId =
      record.verification_attempt_id ?? fail("invalid workspace verification identity");
    const taskId = record.task_id ?? fail("invalid workspace verification identity");
    const contractDigest =
      record.task_contract_digest ?? fail("invalid workspace verification identity");
    const taskBaseHead = record.task_base_head ?? fail("invalid workspace verification identity");
    assertConversationDelegationOracleResults(
      record.verification_expected_oracles,
      verification.oracle_results,
    );
    const unsigned = {
      schema_version: "1.0" as const,
      workspace_id: record.workspace_id,
      primary_ref: record.primary_ref,
      head: record.head,
      verification_attempt_id: attemptId,
      task_id: taskId,
      task_contract_digest: contractDigest,
      task_scope: [...record.task_scope],
      task_forbidden: [...record.task_forbidden],
      task_base_head: taskBaseHead,
      changed_paths: [...record.verification_changed_paths],
      expected_oracles: [...record.verification_expected_oracles],
      oracle_results: structuredClone(verification.oracle_results),
      passed: verifyGateManifestOk(verification.report),
      report: structuredClone(verification.report),
      verified_at: this.now(),
    };
    const proof = Object.freeze({
      ...unsigned,
      proof_digest: digestV1("VF-CONVERSATION-COORDINATION-WORKSPACE-VERIFY\0v1\0", unsigned),
    });
    writePrivateAtomic(
      this.root,
      join(this.root, `${record.workspace_id}-${record.head}-${attemptId}.json`),
      canonicalJsonBytes(proof),
      CONVERSATION_DELEGATION_WORKSPACE_LIMIT.VERIFICATION_RECORD_BYTES,
      fail,
    );
    return proof;
  }
}

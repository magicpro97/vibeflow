import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseIsolationLease } from "../../src/dispatch/isolation.js";
import {
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_STRATEGY,
} from "../../src/dispatch/owned-process-contract.js";
import type {
  OwnedProcessPlatform,
  OwnedProcessPresence,
} from "../../src/dispatch/owned-process-platform.js";
import { sha256Digest } from "../../src/durability/index.js";
import { sanitizedGitEnvironment } from "../../src/git-environment.js";
import { CONVERSATION_COORDINATION_SETTLEMENT } from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import {
  CONVERSATION_DELEGATION_VERIFY_ORACLE,
  conversationDelegationOracleInvocation,
} from "../../src/orchestrator/conversation/conversation-delegation-workspace-contract.js";
import { canonicalizeConversationDelegationPath } from "../../src/orchestrator/conversation/conversation-delegation-workspace-git.js";
import { CONVERSATION_DELEGATION_WORKSPACE_STATE } from "../../src/orchestrator/conversation/conversation-delegation-workspace-records.js";
import {
  type ConversationDelegationWorkspaceVerificationResultV1,
  runConversationDelegationVerificationOracles,
} from "../../src/orchestrator/conversation/conversation-delegation-workspace-verification.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT,
  ConversationDelegationWorkspaceAuthorityV1,
} from "../../src/orchestrator/conversation/conversation-delegation-workspace.js";
import { type PolicyVerifyReport, VERIFY_GATE_ORDER } from "../../src/verify/core.js";

const roots: string[] = [];
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const AUTHORITY_A = "a".repeat(64);
const AUTHORITY_B = "b".repeat(64);
const ATTEMPT_A = "c".repeat(64);
const ATTEMPT_B = "d".repeat(64);
const IDENTITY_A = "linux:01234567-89ab-cdef-0123-456789abcdef:101";
const IDENTITY_B = "linux:01234567-89ab-cdef-0123-456789abcdef:202";
const DEFAULT_ORACLE = CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST;

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: sanitizedGitEnvironment(),
  }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vf-coordination-workspace-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "vf-test@example.invalid"]);
  git(repo, ["config", "user.name", "VibeFlow Test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "--quiet", "-m", "test: seed"]);
  return {
    root,
    repo,
    artifactRoot: join(root, "artifacts"),
    temporaryRoot: join(root, "workspaces"),
    identity: { repoRoot: repo, workflowId: "workflow-1", workspaceKey: "coordination-primary" },
  };
}

const task = (
  taskId = "task-1",
  digest = DIGEST_A,
  scope: readonly string[] = ["implementation.txt"],
  verifyOracles: readonly string[] = [DEFAULT_ORACLE],
  forbidden: readonly string[] = [],
) => ({
  task_id: taskId,
  contract_digest: digest,
  scope,
  forbidden,
  verify_oracles: verifyOracles,
});
const leaseInput = <T extends Awaited<ReturnType<typeof fixture>>>(value: T, binding = task()) => ({
  ...value.identity,
  task: binding,
});
const completionInput = <T extends Awaited<ReturnType<typeof fixture>>>(
  value: T,
  taskId = "task-1",
  changedPaths = ["implementation.txt"],
  commands: readonly string[] = [DEFAULT_ORACLE],
) => ({
  ...value.identity,
  completion: { task_id: taskId, changed_paths: changedPaths, commands },
});

const passingReport = (): PolicyVerifyReport =>
  Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [] },
    ]),
  ) as unknown as PolicyVerifyReport;

const passingVerification = (
  expectedOracles: readonly string[] = [DEFAULT_ORACLE],
): ConversationDelegationWorkspaceVerificationResultV1 => ({
  report: passingReport(),
  oracle_results: expectedOracles.map((command) => {
    const invocation = conversationDelegationOracleInvocation(command);
    if (!invocation) throw new Error("test oracle must be allowlisted");
    return {
      command,
      executable: invocation.executable,
      argv: [...invocation.argv],
      exit_code: 0,
      stdout_digest: sha256Digest(Buffer.alloc(0)),
      stderr_digest: sha256Digest(Buffer.alloc(0)),
    };
  }),
});

class ProcessFixture {
  readonly identities = new Map<number, string | "unknown">();

  platform(): OwnedProcessPlatform {
    const probe = (pid: number): OwnedProcessPresence => {
      const identity = this.identities.get(pid);
      if (identity === "unknown") return { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
      if (!identity) return { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT };
      return {
        kind: OWNED_PROCESS_PRESENCE_KIND.PRESENT,
        observation: { pid, identity, pgid: pid, sid: null },
      };
    };
    return {
      strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
      platform: "linux",
      probe,
      observe: (pid) => {
        const observed = probe(pid);
        return observed.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ? observed.observation : null;
      },
      terminateExactTree: () => {},
      proveQuiescent: () => true,
    };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("task workspace is durable, host-verified, detached-reviewable, and promoted by exact SHA", async () => {
  const value = await fixture();
  const merged: string[][] = [];
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    runGit: (cwd, args) => {
      if (args[0] === "merge") merged.push([...args]);
      return git(cwd, args);
    },
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const first = authority.lease(leaseInput(value));
  await writeFile(join(first.cwd, "implementation.txt"), "delegated result\n");
  git(first.cwd, ["add", "implementation.txt"]);
  git(first.cwd, ["commit", "--quiet", "-m", "feat: delegated result"]);
  const executorHead = git(first.cwd, ["rev-parse", "HEAD"]);
  const durablePath = first.cwd;
  const nested = authority.lease(leaseInput(value));
  await releaseIsolationLease(first);
  expect(authority.observe(value.identity).quiescent).toBe(false);
  await releaseIsolationLease(nested);

  const second = authority.lease(leaseInput(value));
  expect(second.cwd).toBe(durablePath);
  await releaseIsolationLease(second);
  authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.NEEDS_INPUT);

  const verified = await authority.verify(completionInput(value));
  expect(verified.verified_head).toBe(executorHead);
  const proofNames = await readdir(
    join(value.artifactRoot, "coordination-workspaces", "v1", "verify"),
  );
  const proof = JSON.parse(
    await readFile(
      join(value.artifactRoot, "coordination-workspaces", "v1", "verify", proofNames[0] as string),
      "utf8",
    ),
  );
  expect(proof).toMatchObject({
    head: executorHead,
    primary_ref: git(value.repo, ["symbolic-ref", "HEAD"]),
    task_id: "task-1",
    task_contract_digest: DIGEST_A,
    task_scope: ["implementation.txt"],
    task_forbidden: [],
    task_base_head: git(value.repo, ["rev-parse", "HEAD"]),
    changed_paths: ["implementation.txt"],
    expected_oracles: [DEFAULT_ORACLE],
    oracle_results: [{ command: DEFAULT_ORACLE, executable: "bun", argv: ["test"] }],
    passed: true,
  });
  const review = authority.reviewLease(value.identity);
  expect(review.cwd).not.toBe(durablePath);
  expect(git(review.cwd, ["rev-parse", "HEAD"])).toBe(executorHead);
  expect(() => git(review.cwd, ["symbolic-ref", "HEAD"])).toThrow();
  expect(review.evidence_ref).toContain(`coordination-review:${executorHead}:`);
  await releaseIsolationLease(review);
  expect(existsSync(review.cwd)).toBe(false);

  const settled = authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED);
  expect(settled).toMatchObject({ head: executorHead, dirty: false, quiescent: true });
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(executorHead);
  expect(merged).toEqual([["merge", "--ff-only", executorHead]]);
  expect(existsSync(durablePath)).toBe(false);
});

test("durable owner blocks another authority, reclaims exact dead owner, and fails on uncertainty", async () => {
  const value = await fixture();
  const processes = new ProcessFixture();
  processes.identities.set(101, IDENTITY_A);
  processes.identities.set(202, IDENTITY_B);
  const common = { ...value, ownedProcessPlatform: processes.platform() };
  const firstAuthority = new ConversationDelegationWorkspaceAuthorityV1({
    ...common,
    ownerPid: 101,
    authorityId: AUTHORITY_A,
  });
  const first = firstAuthority.lease(leaseInput(value));
  const sameProcessAuthority = new ConversationDelegationWorkspaceAuthorityV1({
    ...common,
    ownerPid: 101,
    authorityId: AUTHORITY_B,
  });
  expect(() => sameProcessAuthority.lease(leaseInput(value))).toThrow("another live authority");
  const secondAuthority = new ConversationDelegationWorkspaceAuthorityV1({
    ...common,
    ownerPid: 202,
    authorityId: AUTHORITY_B,
  });
  expect(() => secondAuthority.lease(leaseInput(value))).toThrow("another live authority");

  processes.identities.set(101, "unknown");
  expect(() => secondAuthority.lease(leaseInput(value))).toThrow("owner is uncertain");
  processes.identities.delete(101);
  const reclaimed = secondAuthority.lease(leaseInput(value));
  expect(reclaimed.cwd).toBe(first.cwd);
  await releaseIsolationLease(reclaimed);
});

test("task checkpoints reject undeclared and out-of-scope diffs and require prior verification", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "one\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: task one"]);
  await releaseIsolationLease(lease);

  expect(() =>
    authority.lease(leaseInput(value, task("task-2", DIGEST_B, ["second.txt"]))),
  ).toThrow("verified or untouched prior checkpoint");
  await expect(authority.verify(completionInput(value, "task-1", ["wrong.txt"]))).rejects.toThrow(
    "exact Git diff",
  );
  await authority.verify(completionInput(value));

  const second = authority.lease(leaseInput(value, task("task-2", DIGEST_B, ["allowed/"])));
  await mkdir(join(second.cwd, "allowed"));
  await writeFile(join(second.cwd, "outside.txt"), "outside\n");
  git(second.cwd, ["add", "outside.txt"]);
  git(second.cwd, ["commit", "--quiet", "-m", "feat: task two outside"]);
  await releaseIsolationLease(second);
  await expect(authority.verify(completionInput(value, "task-2", ["outside.txt"]))).rejects.toThrow(
    "outside scope",
  );
});

test("an untouched blocked checkpoint can rebind while dirty or diverged checkpoints fail closed", async () => {
  const clean = await fixture();
  const cleanAuthority = new ConversationDelegationWorkspaceAuthorityV1(clean);
  const first = cleanAuthority.lease(leaseInput(clean));
  await releaseIsolationLease(first);
  const rebound = cleanAuthority.lease(leaseInput(clean, task("task-2", DIGEST_B, ["second.txt"])));
  await writeFile(join(rebound.cwd, "dirty.txt"), "preserve\n");
  await releaseIsolationLease(rebound);
  expect(() =>
    cleanAuthority.lease(leaseInput(clean, task("task-3", DIGEST_A, ["third.txt"]))),
  ).toThrow("verified or untouched prior checkpoint");
  expect(existsSync(join(rebound.cwd, "dirty.txt"))).toBe(true);

  const diverged = await fixture();
  const divergedAuthority = new ConversationDelegationWorkspaceAuthorityV1(diverged);
  const divergedLease = divergedAuthority.lease(leaseInput(diverged));
  await writeFile(join(divergedLease.cwd, "implementation.txt"), "committed\n");
  git(divergedLease.cwd, ["add", "implementation.txt"]);
  git(divergedLease.cwd, ["commit", "--quiet", "-m", "feat: blocked partial work"]);
  const divergedHead = git(divergedLease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(divergedLease);
  expect(() =>
    divergedAuthority.lease(leaseInput(diverged, task("task-2", DIGEST_B, ["second.txt"]))),
  ).toThrow("verified or untouched prior checkpoint");
  expect(git(divergedLease.cwd, ["rev-parse", "HEAD"])).toBe(divergedHead);
});

test("durable forbidden selectors reject an exact committed diff before host verification", async () => {
  const value = await fixture();
  let verifierCalls = 0;
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => {
      verifierCalls += 1;
      return passingVerification(expectedOracles);
    },
  });
  const lease = authority.lease(
    leaseInput(value, task("task-1", DIGEST_A, ["src/"], [DEFAULT_ORACLE], ["src/security/"])),
  );
  await mkdir(join(lease.cwd, "src", "security"), { recursive: true });
  await writeFile(
    join(lease.cwd, "src", "security", "authority.ts"),
    "export const bypass = true;\n",
  );
  git(lease.cwd, ["add", "src/security/authority.ts"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: forbidden change"]);
  await releaseIsolationLease(lease);

  await expect(
    authority.verify(completionInput(value, "task-1", ["src/security/authority.ts"])),
  ).rejects.toThrow("changed forbidden paths");
  expect(verifierCalls).toBe(0);
  expect(authority.observe(value.identity).verified_head).toBeNull();
});

test.each([
  {
    label: "forbidden",
    scope: ["allowed/", "forbidden/"],
    forbidden: ["forbidden/"],
    message: "changed forbidden paths",
  },
  {
    label: "out-of-scope",
    scope: ["allowed/"],
    forbidden: [],
    message: "outside scope",
  },
])(
  "rename exposes its $label source path before verification",
  async ({ scope, forbidden, message }) => {
    const value = await fixture();
    await mkdir(join(value.repo, "forbidden"));
    await writeFile(join(value.repo, "forbidden", "secret.ts"), "export const secret = true;\n");
    git(value.repo, ["add", "forbidden/secret.ts"]);
    git(value.repo, ["commit", "--quiet", "-m", "test: seed rename source"]);
    const authority = new ConversationDelegationWorkspaceAuthorityV1({
      ...value,
      verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
    });
    const lease = authority.lease(
      leaseInput(value, task("task-1", DIGEST_A, scope, [DEFAULT_ORACLE], forbidden)),
    );
    await mkdir(join(lease.cwd, "allowed"));
    git(lease.cwd, ["mv", "forbidden/secret.ts", "allowed/secret.ts"]);
    git(lease.cwd, ["commit", "--quiet", "-m", "feat: rename across authority boundary"]);
    await releaseIsolationLease(lease);

    await expect(
      authority.verify(
        completionInput(value, "task-1", ["allowed/secret.ts", "forbidden/secret.ts"]),
      ),
    ).rejects.toThrow(message);
  },
);

test("task-bound verification oracles reject substitutions, reordering, and unsupported commands", async () => {
  const value = await fixture();
  let verifierCalls = 0;
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => {
      verifierCalls += 1;
      return passingVerification(expectedOracles);
    },
  });
  expect(() =>
    authority.lease(
      leaseInput(value, task("unsupported", DIGEST_A, ["implementation.txt"], ["npm test"])),
    ),
  ).toThrow("invalid coordination verification oracles");

  const expected = [
    CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST,
    CONVERSATION_DELEGATION_VERIFY_ORACLE.GIT_DIFF_CHECK_PARENT,
  ];
  const lease = authority.lease(
    leaseInput(value, task("task-1", DIGEST_A, ["implementation.txt"], expected)),
  );
  await writeFile(join(lease.cwd, "implementation.txt"), "result\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: delegated"]);
  await releaseIsolationLease(lease);

  await expect(
    authority.verify(
      completionInput(value, "task-1", ["implementation.txt"], [...expected].reverse()),
    ),
  ).rejects.toThrow("bound verification oracles");
  expect(verifierCalls).toBe(0);
  await authority.verify(completionInput(value, "task-1", ["implementation.txt"], expected));
  expect(verifierCalls).toBe(1);
});

test("verification oracle runner uses exact allowlisted argv without a shell and fails closed", async () => {
  const calls: unknown[] = [];
  const command = CONVERSATION_DELEGATION_VERIFY_ORACLE.GIT_DIFF_CHECK_PARENT;
  const results = await runConversationDelegationVerificationOracles(
    "/unused/injected-runner",
    [command],
    async (input) => {
      calls.push(input);
      return { exit_code: 0, stdout: "", stderr: "" };
    },
  );
  expect(calls).toEqual([
    {
      cwd: "/unused/injected-runner",
      executable: "git",
      argv: ["diff", "--check", "HEAD^", "HEAD"],
      shell: false,
    },
  ]);
  expect(results).toEqual(passingVerification([command]).oracle_results);
  await expect(
    runConversationDelegationVerificationOracles("/unused", ["git status; rm -rf ."], async () => ({
      exit_code: 0,
      stdout: "",
      stderr: "",
    })),
  ).rejects.toThrow("unsupported coordination verification oracle");
  await expect(
    runConversationDelegationVerificationOracles("/unused", [command], async () => ({
      exit_code: 1,
      stdout: "",
      stderr: "failure",
    })),
  ).rejects.toThrow("coordination verification oracle failed");
});

test("verification proof rejects oracle evidence not matching the durable task authority", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async () =>
      passingVerification([CONVERSATION_DELEGATION_VERIFY_ORACLE.GIT_DIFF_CHECK_PARENT]),
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "result\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: delegated"]);
  await releaseIsolationLease(lease);

  await expect(authority.verify(completionInput(value))).rejects.toThrow(
    "verification oracle evidence mismatch",
  );
  expect(
    await readdir(join(value.artifactRoot, "coordination-workspaces", "v1", "verify")),
  ).toEqual([]);
  expect(authority.observe(value.identity).verified_head).toBeNull();
  expect(() => authority.lease(leaseInput(value))).toThrow("authority is unavailable");
});

test.each([
  CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT.VERIFYING_PERSISTED,
  CONVERSATION_DELEGATION_WORKSPACE_FAULT_POINT.VERIFICATION_PROOF_PERSISTED,
])("dead verifier restart invalidates partial proof at %s and safely retries", async (point) => {
  const value = await fixture();
  const processes = new ProcessFixture();
  processes.identities.set(101, IDENTITY_A);
  const crashing = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    ownedProcessPlatform: processes.platform(),
    ownerPid: 101,
    authorityId: AUTHORITY_A,
    createVerificationAttemptId: () => ATTEMPT_A,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
    fault: (observed) => {
      if (observed === point) throw new Error(`crash:${point}`);
    },
  });
  const lease = crashing.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "result\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: delegated"]);
  await releaseIsolationLease(lease);
  await expect(crashing.verify(completionInput(value))).rejects.toThrow(`crash:${point}`);

  processes.identities.delete(101);
  processes.identities.set(202, IDENTITY_B);
  const recovered = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    ownedProcessPlatform: processes.platform(),
    ownerPid: 202,
    authorityId: AUTHORITY_B,
    createVerificationAttemptId: () => ATTEMPT_B,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  expect(recovered.observe(value.identity).verified_head).toBeNull();
  expect((await recovered.verify(completionInput(value))).verified_head).toBe(
    git(lease.cwd, ["rev-parse", "HEAD"]),
  );
});

test("a live verifier checkpoint blocks restart reconciliation", async () => {
  const value = await fixture();
  const processes = new ProcessFixture();
  processes.identities.set(101, IDENTITY_A);
  processes.identities.set(202, IDENTITY_B);
  let allowVerify: (() => void) | undefined;
  const verifying = new Promise<void>((resolve) => {
    allowVerify = resolve;
  });
  const first = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    ownedProcessPlatform: processes.platform(),
    ownerPid: 101,
    authorityId: AUTHORITY_A,
    verify: async ({ expected_oracles: expectedOracles }) => {
      await verifying;
      return passingVerification(expectedOracles);
    },
  });
  const lease = first.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "result\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: delegated"]);
  await releaseIsolationLease(lease);
  const pending = first.verify(completionInput(value));
  await Bun.sleep(10);

  const second = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    ownedProcessPlatform: processes.platform(),
    ownerPid: 202,
    authorityId: AUTHORITY_B,
  });
  expect(() => second.observe(value.identity)).toThrow("live authority");
  allowVerify?.();
  await pending;
});

test("workspace mutation during host verification is preserved in recovery without proof", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ cwd, expected_oracles: expectedOracles }) => {
      await writeFile(join(cwd, "verifier-mutation.txt"), "preserve for diagnosis\n");
      return passingVerification(expectedOracles);
    },
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "result\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: delegated"]);
  await releaseIsolationLease(lease);

  await expect(authority.verify(completionInput(value))).rejects.toThrow(
    "changed during verification",
  );
  expect(existsSync(join(lease.cwd, "verifier-mutation.txt"))).toBe(true);
  expect(() => authority.lease(leaseInput(value))).toThrow("authority is unavailable");
});

test("pending worktree crash recovers and primary divergence preserves both workspaces", async () => {
  const value = await fixture();
  let crashAfterAdd = true;
  const crashing = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    runGit: (cwd, args) => {
      const output = git(cwd, args);
      if (args[0] === "worktree" && args[1] === "add" && crashAfterAdd) {
        crashAfterAdd = false;
        throw new Error("injected crash");
      }
      return output;
    },
  });
  expect(() => crashing.lease(leaseInput(value))).toThrow("injected crash");
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "executor\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: executor"]);
  const executorHead = git(lease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(lease);
  await authority.verify(completionInput(value));

  await writeFile(join(value.repo, "primary.txt"), "primary\n");
  git(value.repo, ["add", "primary.txt"]);
  git(value.repo, ["commit", "--quiet", "-m", "feat: concurrent primary"]);
  const primaryHead = git(value.repo, ["rev-parse", "HEAD"]);
  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("primary workspace head changed");
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(primaryHead);
  expect(git(lease.cwd, ["rev-parse", "HEAD"])).toBe(executorHead);
});

test("promotion preserves the executor when the primary becomes dirty after fast-forward", async () => {
  const value = await fixture();
  let injectedPrimaryWrite = false;
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    runGit: (cwd, args) => {
      const output = git(cwd, args);
      if (args[0] === "merge" && args[1] === "--ff-only") {
        writeFileSync(join(value.repo, "concurrent-untracked.txt"), "preserve for recovery\n");
        injectedPrimaryWrite = true;
      }
      return output;
    },
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "executor\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: executor"]);
  const executorHead = git(lease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(lease);
  await authority.verify(completionInput(value));

  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("primary workspace changed during promotion");
  expect(injectedPrimaryWrite).toBe(true);
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(executorHead);
  expect(git(value.repo, ["status", "--porcelain=v1"])).toContain("?? concurrent-untracked.txt");
  expect(existsSync(lease.cwd)).toBe(true);

  const recordRoot = join(value.artifactRoot, "coordination-workspaces", "v1", "records");
  const recordNames = (await readdir(recordRoot)).filter((name) => name.endsWith(".json"));
  expect(recordNames).toHaveLength(1);
  const record = JSON.parse(await readFile(join(recordRoot, recordNames[0] as string), "utf8")) as {
    state: string;
  };
  expect(record.state).toBe(CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY);
});

test("branch race is detected before primary mutation and Windows paths canonicalize case/separators", async () => {
  expect(canonicalizeConversationDelegationPath("C:/Repo/WorkTree", "win32")).toBe(
    canonicalizeConversationDelegationPath("c:\\repo\\worktree\\", "win32"),
  );
  const value = await fixture();
  let race = false;
  let executorHead = "";
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    platform: "win32",
    normalizePath: (path, platform) => {
      expect(platform).toBe("win32");
      return path.replaceAll("\\", "/").toLowerCase().replace(/\/$/u, "");
    },
    runGit: (cwd, args) => {
      if (race && args[0] === "rev-parse" && String(args[1]).startsWith("refs/heads/vf/")) {
        race = false;
        git(value.repo, ["update-ref", args[1] as string, git(value.repo, ["rev-parse", "HEAD"])]);
      }
      return git(cwd, args);
    },
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "executor\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: executor"]);
  executorHead = git(lease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(lease);
  await authority.verify(completionInput(value));
  const primaryHead = git(value.repo, ["rev-parse", "HEAD"]);
  race = true;
  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("branch raced");
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(primaryHead);
  expect(existsSync(lease.cwd)).toBe(true);
  expect(executorHead).not.toBe(primaryHead);
});

test("promotion rejects a different symbolic branch at the same SHA without mutation", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const primaryBase = git(value.repo, ["rev-parse", "HEAD"]);
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "executor\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: executor"]);
  const executorHead = git(lease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(lease);
  await authority.verify(completionInput(value));

  git(value.repo, ["branch", "same-sha-primary", primaryBase]);
  git(value.repo, ["switch", "--quiet", "same-sha-primary"]);
  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("primary workspace symbolic branch changed");
  expect(git(value.repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/same-sha-primary");
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(primaryBase);
  expect(git(lease.cwd, ["rev-parse", "HEAD"])).toBe(executorHead);
});

test("promotion rejects detached primary HEAD at the bound SHA without mutation", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1({
    ...value,
    verify: async ({ expected_oracles: expectedOracles }) => passingVerification(expectedOracles),
  });
  const primaryBase = git(value.repo, ["rev-parse", "HEAD"]);
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "implementation.txt"), "executor\n");
  git(lease.cwd, ["add", "implementation.txt"]);
  git(lease.cwd, ["commit", "--quiet", "-m", "feat: executor"]);
  const executorHead = git(lease.cwd, ["rev-parse", "HEAD"]);
  await releaseIsolationLease(lease);
  await authority.verify(completionInput(value));

  git(value.repo, ["checkout", "--quiet", "--detach", primaryBase]);
  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("primary workspace must remain on its bound symbolic branch");
  expect(() => git(value.repo, ["symbolic-ref", "HEAD"])).toThrow();
  expect(git(value.repo, ["rev-parse", "HEAD"])).toBe(primaryBase);
  expect(git(lease.cwd, ["rev-parse", "HEAD"])).toBe(executorHead);
});

test("dirty executor work fails closed and remains recoverable", async () => {
  const value = await fixture();
  const authority = new ConversationDelegationWorkspaceAuthorityV1(value);
  const lease = authority.lease(leaseInput(value));
  await writeFile(join(lease.cwd, "uncommitted.txt"), "preserve me\n");
  await releaseIsolationLease(lease);
  expect(() =>
    authority.settle(value.identity, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
  ).toThrow("not clean and quiescent");
  expect(existsSync(join(lease.cwd, "uncommitted.txt"))).toBe(true);
  expect(() => authority.lease(leaseInput(value))).toThrow("authority is unavailable");
});

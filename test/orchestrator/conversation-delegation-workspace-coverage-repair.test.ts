import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_DELEGATION_VERIFY_ORACLE } from "../../src/orchestrator/conversation/conversation-delegation-workspace-contract.js";
import { ConversationDelegationWorkspaceGitV1 } from "../../src/orchestrator/conversation/conversation-delegation-workspace-git.js";
import { ConversationDelegationWorkspaceLifecycleV1 } from "../../src/orchestrator/conversation/conversation-delegation-workspace-lifecycle.js";
import { ConversationDelegationWorkspaceOwnershipV1 } from "../../src/orchestrator/conversation/conversation-delegation-workspace-ownership.js";
import {
  CONVERSATION_DELEGATION_WORKSPACE_STATE,
  type ConversationDelegationWorkspaceRecordV1,
  assertConversationDelegationWorkspaceRecord,
} from "../../src/orchestrator/conversation/conversation-delegation-workspace-records.js";
import { ConversationDelegationWorkspaceVerifyRuntimeV1 } from "../../src/orchestrator/conversation/conversation-delegation-workspace-verify-runtime.js";

const roots: string[] = [];
const BASE_HEAD = "a".repeat(40);
const TASK_HEAD = "b".repeat(40);
const AUTHORITY_ID = "c".repeat(64);
const ATTEMPT_ID = "d".repeat(64);
const WORKSPACE_ID = `vf-coordinate-workspace-${"e".repeat(64)}`;
const BRANCH_REF = `refs/heads/vf/coordinate/${"f".repeat(24)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runtimeRecord(): ConversationDelegationWorkspaceRecordV1 {
  return {
    schema_version: "1.0",
    workspace_id: WORKSPACE_ID,
    workflow_id: "workflow-coverage",
    workspace_key: "workspace-coverage",
    workspace_key_digest: `sha256:${"1".repeat(64)}`,
    repo_root_digest: `sha256:${"2".repeat(64)}`,
    base_head: BASE_HEAD,
    primary_ref: "refs/heads/main",
    head: TASK_HEAD,
    branch_ref: BRANCH_REF,
    state: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
    dirty: false,
    lease_owner: null,
    lease_count: 0,
    review_owner: null,
    review_count: 0,
    review_head: null,
    task_id: "task-coverage",
    task_contract_digest: `sha256:${"3".repeat(64)}`,
    task_scope: ["implementation.txt"],
    task_forbidden: [],
    task_verify_oracles: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
    task_base_head: BASE_HEAD,
    verified_head: null,
    verification_evidence_refs: [],
    verification_owner: null,
    verification_attempt_id: null,
    verification_changed_paths: [],
    verification_expected_oracles: [],
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    record_digest: `sha256:${"4".repeat(64)}`,
  };
}

describe("delegated workspace coverage repair", () => {
  test("a missing pending branch is recreated and an unknown workspace projects as absent", () => {
    const root = temporaryRoot("vf-workspace-git-coverage-");
    const calls: string[][] = [];
    const git = new ConversationDelegationWorkspaceGitV1({
      temporaryRoot: root,
      runGit: (_cwd, args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse") throw new Error("unknown revision");
        return "";
      },
    });
    git.recoverPending(runtimeRecord(), "/repo");
    expect(calls).toEqual([
      ["rev-parse", BRANCH_REF],
      [
        "worktree",
        "add",
        "--quiet",
        "-b",
        BRANCH_REF.slice("refs/heads/".length),
        git.path(WORKSPACE_ID),
        BASE_HEAD,
      ],
    ]);

    const lifecycle = new ConversationDelegationWorkspaceLifecycleV1(
      {} as never,
      {} as never,
      {} as never,
      () => "2026-08-28T00:00:00.000Z",
    );
    expect(lifecycle.absent("workspace-missing")).toEqual({
      workspace_key: "workspace-missing",
      quiescent: true,
      dirty: false,
      verified_head: null,
      branch_ref: null,
      head: null,
      evidence_refs: [],
    });
  });

  test("invalid process and record authorities fail before durable use", () => {
    expect(
      () =>
        new ConversationDelegationWorkspaceOwnershipV1({
          platform: {} as never,
          pid: 0,
          authorityId: AUTHORITY_ID,
        }),
    ).toThrow("invalid coordination workspace process authority");
    expect(() => assertConversationDelegationWorkspaceRecord(null)).toThrow(
      "invalid workspace record",
    );
  });

  test.each([
    {
      label: "unchanged",
      inspectFailure: false,
      replaceAttempt: false,
      expected: CONVERSATION_DELEGATION_WORKSPACE_STATE.ACTIVE,
    },
    {
      label: "unobservable",
      inspectFailure: true,
      replaceAttempt: false,
      expected: CONVERSATION_DELEGATION_WORKSPACE_STATE.NEEDS_RECOVERY,
    },
    {
      label: "superseded",
      inspectFailure: false,
      replaceAttempt: true,
      expected: CONVERSATION_DELEGATION_WORKSPACE_STATE.VERIFYING,
    },
  ])(
    "a throwing verifier restores $label durable authority",
    async ({ inspectFailure, replaceAttempt, expected }) => {
      let current = runtimeRecord();
      let inspectCalls = 0;
      const records = {
        withLock: <T>(run: () => T): T => run(),
        read: () => current,
        write: (next: ConversationDelegationWorkspaceRecordV1) => {
          current = structuredClone(next);
          return current;
        },
      };
      const git = {
        inspect: () => {
          inspectCalls += 1;
          if (inspectFailure && inspectCalls > 1) throw new Error("workspace disappeared");
          return { head: TASK_HEAD, dirty: false };
        },
        changedPaths: () => ["implementation.txt"],
        path: () => "/workspace/coverage",
      };
      const lifecycle = {
        loadForUse: () => current,
        reconcileDurableOwners: (record: ConversationDelegationWorkspaceRecordV1) => record,
      };
      const ownership = {
        current: () => ({
          pid: 42,
          process_start_identity: "linux:01234567-89ab-cdef-0123-456789abcdef:42",
          authority_id: AUTHORITY_ID,
        }),
        attemptId: () => ATTEMPT_ID,
      };
      const runtime = new ConversationDelegationWorkspaceVerifyRuntimeV1(
        records as never,
        git as never,
        ownership as never,
        lifecycle as never,
        {} as never,
        async () => {
          if (replaceAttempt) current = { ...current, verification_attempt_id: "9".repeat(64) };
          throw new Error("verifier crashed");
        },
        () => "2026-08-28T00:00:01.000Z",
        () => {},
      );
      await expect(
        runtime.verify({
          repoRoot: "/repo/coverage",
          workflowId: "workflow-coverage",
          workspaceKey: "workspace-coverage",
          completion: {
            task_id: "task-coverage",
            changed_paths: ["implementation.txt"],
            commands: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
          },
        }),
      ).rejects.toThrow("verifier crashed");
      expect(current.state).toBe(expected);
      if (replaceAttempt) {
        expect(current.verification_attempt_id).toBe("9".repeat(64));
        expect(current.verification_owner).not.toBeNull();
      } else {
        expect(current).toMatchObject({
          verified_head: null,
          verification_owner: null,
          verification_attempt_id: null,
          verification_changed_paths: [],
          verification_expected_oracles: [],
        });
        expect(current.dirty).toBe(inspectFailure);
      }
    },
  );
});

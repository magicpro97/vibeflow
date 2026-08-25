import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializeAgentBindingOptions } from "../../agents/binding.js";
import { createIsolationLease, releaseIsolationLease } from "../../dispatch/isolation.js";
import {
  type EngineSessionAdapter,
  type IsolationLeaseProjection,
  createSpawnOptionsProjection,
} from "../../dispatch/session-types.js";

export interface ConversationIsolationAuthority {
  acquire(repoRoot: string): IsolationLeaseProjection;
}

type GitRunner = (repoRoot: string, args: readonly string[], timeout: number) => void;
interface ConversationIsolationAuthorityDeps {
  runGit?: GitRunner;
  createLease?: typeof createIsolationLease;
  removeTree?: (path: string) => void;
  id?: () => string;
}

const runGit: GitRunner = (repoRoot, args, timeout) => {
  execFileSync("git", ["-C", repoRoot, ...args], { timeout, stdio: "ignore" });
};

function cleanupWorktree(
  git: GitRunner,
  removeTree: (path: string) => void,
  repoRoot: string,
  cwd: string,
  parent: string,
): void {
  let failed = false;
  try {
    git(repoRoot, ["worktree", "remove", "--force", cwd], 30_000);
  } catch {
    failed = true;
  } finally {
    try {
      removeTree(parent);
    } catch {
      failed = true;
    }
    try {
      git(repoRoot, ["worktree", "prune", "--expire", "now"], 5000);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("conversation isolation cleanup failed");
}

export function createConversationIsolationAuthority(
  deps: ConversationIsolationAuthorityDeps = {},
): ConversationIsolationAuthority {
  const git = deps.runGit ?? runGit;
  const createLease = deps.createLease ?? createIsolationLease;
  const removeTree = deps.removeTree ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const id = deps.id ?? randomUUID;
  return Object.freeze({
    acquire(repoRoot: string) {
      const parent = mkdtempSync(join(tmpdir(), "vf-conversation-isolation-"));
      const cwd = join(parent, "worktree");
      try {
        git(repoRoot, ["worktree", "add", "--quiet", "--detach", cwd, "HEAD"], 60_000);
        return createLease({
          kind: "worktree",
          root: cwd,
          cwd,
          repoRoot,
          evidence_ref: `conversation-isolation-${id()}`,
          release: () => cleanupWorktree(git, removeTree, repoRoot, cwd, parent),
        });
      } catch {
        try {
          cleanupWorktree(git, removeTree, repoRoot, cwd, parent);
        } catch {
          // The public failure remains authority-unavailable, never a private local path.
        }
        throw new Error("conversation isolation authority is unavailable");
      }
    },
  });
}

export const defaultConversationIsolationAuthority = createConversationIsolationAuthority();

export async function bindWithIsolation<T>(
  authority: ConversationIsolationAuthority | undefined,
  repoRoot: string,
  phase: number,
  taskText: string,
  bind: (options: MaterializeAgentBindingOptions) => T,
): Promise<T> {
  if (phase === 1 || !authority) return bind({ repoRoot, phase, taskText });
  const isolation = authority.acquire(repoRoot);
  try {
    return bind({ repoRoot, phase, taskText, isolation });
  } finally {
    await releaseIsolationLease(isolation);
  }
}

/** Refresh the single-use binding lease for every process attempt. */
export function withAttemptIsolation(
  delegate: EngineSessionAdapter,
  authority: ConversationIsolationAuthority,
  repoRoot: string,
): EngineSessionAdapter {
  return Object.freeze({
    ...(delegate.startAuthority ? { startAuthority: delegate.startAuthority } : {}),
    start(request: Parameters<EngineSessionAdapter["start"]>[0]) {
      if (!request.spawn.isolation) return delegate.start(request);
      const isolation = authority.acquire(repoRoot);
      try {
        const handle = delegate.start({
          ...request,
          spawn: createSpawnOptionsProjection({ ...request.spawn, isolation }),
        });
        return Object.freeze({
          attemptId: handle.attemptId,
          completion: handle.completion.finally(() => releaseIsolationLease(isolation)),
          terminate: (reason?: string) => handle.terminate(reason),
          readResumeBinding: () => handle.readResumeBinding(),
          readEvidenceBinding: () => handle.readEvidenceBinding(),
        });
      } catch (error) {
        void releaseIsolationLease(isolation).catch(() => undefined);
        throw error;
      }
    },
    reconcileHistory: (request: Parameters<EngineSessionAdapter["reconcileHistory"]>[0]) =>
      delegate.reconcileHistory(request),
  });
}

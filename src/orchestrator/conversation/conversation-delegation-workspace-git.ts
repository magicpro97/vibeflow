import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { ensurePrivateDirectory } from "../../durability/index.js";
import { RUNTIME_PLATFORM } from "../../durability/process-identity-contract.js";
import { sanitizedGitEnvironment } from "../../git-environment.js";
import {
  CONVERSATION_DELEGATION_GIT_HEAD,
  CONVERSATION_DELEGATION_WORKSPACE_ID,
  CONVERSATION_DELEGATION_WORKSPACE_STATE,
  type ConversationDelegationWorkspaceRecordV1,
} from "./conversation-delegation-workspace-records.js";
import { isCanonicalDelegationPath } from "./conversation-delegation-workspace-task.js";

export type ConversationDelegationGitRunnerV1 = (cwd: string, args: readonly string[]) => string;
export type ConversationDelegationPathNormalizerV1 = (
  path: string,
  platform: NodeJS.Platform,
) => string;

const fail = (message: string): never => {
  throw new Error(message);
};
const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const productionGit: ConversationDelegationGitRunnerV1 = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: sanitizedGitEnvironment(),
  }).trim();

export function canonicalizeConversationDelegationPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === RUNTIME_PLATFORM.WINDOWS) {
    const normalized = win32.normalize(path.replaceAll("/", "\\")).toLocaleLowerCase("en-US");
    const root = win32.parse(normalized).root;
    return normalized === root ? normalized : normalized.replace(/\\+$/u, "");
  }
  return resolve(path);
}

/** Owns the process and filesystem boundary for delegated and detached review worktrees. */
export class ConversationDelegationWorkspaceGitV1 {
  private readonly temporaryRoot: string;
  private readonly runGit: ConversationDelegationGitRunnerV1;
  private readonly platform: NodeJS.Platform;
  private readonly normalizePath: ConversationDelegationPathNormalizerV1;

  constructor(options: {
    temporaryRoot?: string;
    runGit?: ConversationDelegationGitRunnerV1;
    platform?: NodeJS.Platform;
    normalizePath?: ConversationDelegationPathNormalizerV1;
  }) {
    this.temporaryRoot = ensurePrivateDirectory(
      resolve(options.temporaryRoot ?? join(tmpdir(), "vf-coordinate-workspaces")),
    );
    this.runGit = options.runGit ?? productionGit;
    this.platform = options.platform ?? process.platform;
    this.normalizePath = options.normalizePath ?? canonicalizeConversationDelegationPath;
  }

  path(workspaceId: string): string {
    this.assertWorkspaceId(workspaceId);
    return join(this.temporaryRoot, workspaceId);
  }

  reviewPath(workspaceId: string): string {
    this.assertWorkspaceId(workspaceId);
    return join(this.temporaryRoot, `${workspaceId}-review`);
  }

  primaryBase(repoRoot: string): { head: string; primaryRef: string } {
    const primaryRef = this.symbolicHead(
      repoRoot,
      "primary workspace must be on a symbolic branch",
    );
    const head = this.head(repoRoot, "coordination workspace base is unavailable");
    if (this.runGit(repoRoot, ["rev-parse", primaryRef]) !== head)
      fail("primary workspace branch and HEAD differ");
    return { head, primaryRef };
  }

  create(record: ConversationDelegationWorkspaceRecordV1, repoRoot: string): void {
    this.runGit(repoRoot, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      record.branch_ref.slice("refs/heads/".length),
      this.path(record.workspace_id),
      record.base_head,
    ]);
  }

  recoverPending(record: ConversationDelegationWorkspaceRecordV1, repoRoot: string): void {
    const path = this.path(record.workspace_id);
    if (fs.existsSync(path)) return;
    const branchHead = this.optionalRev(repoRoot, record.branch_ref);
    if (branchHead !== null && branchHead !== record.base_head)
      fail("coordination workspace pending branch changed");
    this.runGit(
      repoRoot,
      branchHead === null
        ? [
            "worktree",
            "add",
            "--quiet",
            "-b",
            record.branch_ref.slice("refs/heads/".length),
            path,
            record.base_head,
          ]
        : ["worktree", "add", "--quiet", path, record.branch_ref],
    );
  }

  inspect(
    record: ConversationDelegationWorkspaceRecordV1,
    repoRoot: string,
  ): { head: string; dirty: boolean } {
    if (record.state === CONVERSATION_DELEGATION_WORKSPACE_STATE.SETTLED)
      return { head: record.head, dirty: false };
    const path = this.path(record.workspace_id);
    this.assertCanonicalRegisteredPath(path, repoRoot);
    if (this.runGit(path, ["symbolic-ref", "HEAD"]) !== record.branch_ref)
      fail("coordination workspace branch changed");
    return {
      head: this.head(path, "coordination workspace head is invalid"),
      dirty: this.runGit(path, ["status", "--porcelain=v1"]).length > 0,
    };
  }

  changedPaths(record: ConversationDelegationWorkspaceRecordV1, head: string): string[] {
    if (!record.task_base_head || !CONVERSATION_DELEGATION_GIT_HEAD.test(head))
      return fail("coordination task checkpoint is unavailable");
    this.runGit(this.path(record.workspace_id), [
      "merge-base",
      "--is-ancestor",
      record.task_base_head,
      head,
    ]);
    const raw = this.runGit(this.path(record.workspace_id), [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      record.task_base_head,
      head,
      "--",
    ]);
    if (!raw) return [];
    if (!raw.endsWith("\0")) fail("coordination task diff is not canonical");
    const paths = raw.slice(0, -1).split("\0");
    if (paths.some((path) => !isCanonicalDelegationPath(path)))
      fail("coordination task diff contains an invalid path");
    if (new Set(paths).size !== paths.length)
      fail("coordination task diff contains duplicate paths");
    return paths.sort(compareCanonicalText);
  }

  createReview(record: ConversationDelegationWorkspaceRecordV1, repoRoot: string): string {
    const verified = record.verified_head;
    if (!verified || verified !== record.head)
      throw new Error("coordination review lacks verified authority");
    const path = this.reviewPath(record.workspace_id);
    if (fs.existsSync(path)) {
      this.inspectReview(record.workspace_id, repoRoot, verified);
      return path;
    }
    this.runGit(repoRoot, ["worktree", "add", "--quiet", "--detach", path, verified]);
    this.inspectReview(record.workspace_id, repoRoot, verified);
    return path;
  }

  inspectReview(workspaceId: string, repoRoot: string, verifiedHead: string): void {
    const path = this.reviewPath(workspaceId);
    this.assertCanonicalRegisteredPath(path, repoRoot);
    if (this.optionalSymbolicHead(path) !== null)
      fail("coordination review worktree is not detached");
    if (
      this.head(path, "coordination review head is invalid") !== verifiedHead ||
      this.runGit(path, ["status", "--porcelain=v1"]).length > 0
    )
      fail("coordination review snapshot changed");
  }

  removeReview(workspaceId: string, repoRoot: string): void {
    const path = this.reviewPath(workspaceId);
    if (fs.existsSync(path)) this.runGit(repoRoot, ["worktree", "remove", "--force", path]);
    this.runGit(repoRoot, ["worktree", "prune", "--expire", "now"]);
  }

  promoteAndRemove(record: ConversationDelegationWorkspaceRecordV1, repoRoot: string): void {
    const verifiedHead = record.verified_head;
    if (!verifiedHead || verifiedHead !== record.head)
      throw new Error("coordination workspace lacks verified promotion authority");
    const verified = verifiedHead;
    const path = this.path(record.workspace_id);
    if (fs.existsSync(path)) {
      const live = this.inspect(record, repoRoot);
      if (live.dirty || live.head !== verified)
        fail("coordination workspace changed before promotion");
    }
    if (this.runGit(repoRoot, ["status", "--porcelain=v1"]).length > 0)
      fail("primary workspace is not clean");
    const primaryRef = this.symbolicHead(
      repoRoot,
      "primary workspace must remain on its bound symbolic branch",
    );
    if (primaryRef !== record.primary_ref) fail("primary workspace symbolic branch changed");
    const primaryHead = this.head(repoRoot, "primary workspace head is invalid");
    const primaryRefHead = this.runGit(repoRoot, ["rev-parse", record.primary_ref]);
    if (primaryRefHead !== primaryHead) fail("primary workspace branch and HEAD differ");
    if (primaryHead !== verified && primaryHead !== record.base_head)
      fail("primary workspace head changed");
    if (this.runGit(repoRoot, ["rev-parse", record.branch_ref]) !== verified)
      fail("coordination workspace branch raced before promotion");
    this.runGit(repoRoot, ["cat-file", "-e", `${verified}^{commit}`]);
    if (primaryHead !== verified) {
      this.runGit(repoRoot, ["merge", "--ff-only", verified]);
      if (
        this.symbolicHead(
          repoRoot,
          "primary workspace must remain on its bound symbolic branch",
        ) !== record.primary_ref ||
        this.head(repoRoot, "primary workspace head is invalid") !== verified ||
        this.runGit(repoRoot, ["rev-parse", record.primary_ref]) !== verified
      )
        fail("coordination workspace promotion did not reach verified head");
    }
    if (this.runGit(repoRoot, ["status", "--porcelain=v1"]).length > 0)
      fail("primary workspace changed during promotion");
    if (fs.existsSync(path)) this.runGit(repoRoot, ["worktree", "remove", path]);
    this.runGit(repoRoot, ["worktree", "prune", "--expire", "now"]);
  }

  private assertCanonicalRegisteredPath(path: string, repoRoot: string): void {
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch {
      throw new Error("coordination workspace requires recovery");
    }
    const normalize = (value: string) => this.normalizePath(value, this.platform);
    if (normalize(canonical) !== normalize(path)) fail("coordination workspace path changed");
    const registered = this.runGit(repoRoot, ["worktree", "list", "--porcelain"])
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    if (!registered.some((candidate) => normalize(candidate) === normalize(canonical)))
      fail("coordination workspace registration changed");
  }

  private head(cwd: string, message: string): string {
    const head = this.runGit(cwd, ["rev-parse", "HEAD"]);
    return CONVERSATION_DELEGATION_GIT_HEAD.test(head) ? head : fail(message);
  }

  private optionalRev(cwd: string, revision: string): string | null {
    try {
      return this.runGit(cwd, ["rev-parse", revision]);
    } catch {
      return null;
    }
  }

  private optionalSymbolicHead(cwd: string): string | null {
    try {
      return this.runGit(cwd, ["symbolic-ref", "HEAD"]);
    } catch {
      return null;
    }
  }

  private symbolicHead(cwd: string, message: string): string {
    try {
      const reference = this.runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
      return reference.startsWith("refs/heads/") ? reference : fail(message);
    } catch {
      throw new Error(message);
    }
  }

  private assertWorkspaceId(workspaceId: string): void {
    if (!CONVERSATION_DELEGATION_WORKSPACE_ID.test(workspaceId)) fail("invalid workspace identity");
  }
}

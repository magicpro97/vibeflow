import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutorDeps,
  type ReleaseSnapshot,
  type WorktreeOperation,
  approveProposal,
} from "./registry-release-executor.js";
import { sanitizeForOutput } from "./registry-release.js";

export interface GitReleaseRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitReleaseRun = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => GitReleaseRunResult;

type GitReleaseSpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface RegistryReleaseGitDeps {
  run?: GitReleaseRun;
  spawnSync?: GitReleaseSpawnSync;
  mkdtempSync?: (prefix: string) => string;
  tmpdir?: () => string;
  readFileSync?: (path: string) => string;
  writeFileSync?: (path: string, value: string) => void;
  rmSync?: (path: string, options: { recursive: true; force: true }) => void;
}

type ApprovalOutput = (text: string, level?: "info" | "error") => void;

export function approveStoredRelease(
  snapshot: ReleaseSnapshot,
  path: string,
  factory: () => ExecutorDeps,
  write: (path: string, content: string) => void,
  output: ApprovalOutput,
): number {
  try {
    const result = approveProposal(snapshot, { yes: true }, factory());
    write(path, JSON.stringify(result.snapshot, null, 2));
    output(JSON.stringify(result, null, 2));
    return result.snapshot.state === "partial-failure" ? 1 : 0;
  } catch (error) {
    output(error instanceof Error ? error.message : "Release approval failed.", "error");
    return 1;
  }
}

interface LockEntry extends Record<string, unknown> {
  name: string;
  url: string;
  ref: string;
  commitOID: string;
}

interface RegistryLock {
  schemaVersion: 1;
  registries: LockEntry[];
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LOCK = join(".vibeflow", "SKILL_REGISTRY.lock.json");
const ENTRY_KEYS = new Set(["name", "url", "ref", "commitOID", "installed"]);

function defaultRun(childSpawnSync: GitReleaseSpawnSync = spawnSync): GitReleaseRun {
  return (command, args, options = {}) => {
    const result = childSpawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pullRequestNumber(url: string, repository: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(url);
  return match && `${match[1]}/${match[2]}` === repository ? (match[3] ?? null) : null;
}

function strictLock(text: string): RegistryLock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isObject(raw) ||
    Object.keys(raw).length !== 2 ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.registries)
  )
    return null;
  const names = new Set<string>();
  for (const entry of raw.registries) {
    if (!isObject(entry)) return null;
    const keys = Object.keys(entry);
    if (
      ![4, 5].includes(keys.length) ||
      !keys.every((key) => ENTRY_KEYS.has(key)) ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.url !== "string" ||
      typeof entry.ref !== "string" ||
      typeof entry.commitOID !== "string" ||
      !OID.test(entry.commitOID) ||
      (entry.installed !== undefined && !Array.isArray(entry.installed)) ||
      names.has(entry.name)
    )
      return null;
    names.add(entry.name);
  }
  return raw as unknown as RegistryLock;
}

function cwd(operation: WorktreeOperation): string {
  return join(operation.worktree.id, "repo");
}

export function createRegistryReleaseGitAdapter(deps: RegistryReleaseGitDeps = {}): ExecutorDeps {
  const run = deps.run ?? defaultRun(deps.spawnSync);
  const makeTemp = deps.mkdtempSync ?? mkdtempSync;
  const tempRoot = deps.tmpdir ?? tmpdir;
  const read = deps.readFileSync ?? ((path) => readFileSync(path, "utf8"));
  const write = deps.writeFileSync ?? ((path, value) => writeFileSync(path, value));
  const remove = deps.rmSync ?? rmSync;
  const verifyEvidence = new Map<string, string>();

  const execute = (command: string, args: string[], commandCwd?: string): string => {
    const result = run(command, args, commandCwd ? { cwd: commandCwd } : {});
    if (result.status !== 0) throw new Error(`${command} ${args[0] ?? "command"} failed.`);
    return result.stdout.trim();
  };

  const readLock = (path: string): RegistryLock | null => {
    try {
      return strictLock(read(path));
    } catch {
      return null;
    }
  };

  return {
    activeIdentity: () => {
      const identity = execute("gh", ["api", "user", "--jq", ".login"]);
      if (!identity) throw new Error("GitHub active user is empty.");
      return identity;
    },
    authorizeTarget: ({ identity, target }) => {
      let metadata: unknown;
      try {
        metadata = JSON.parse(execute("gh", ["api", `repos/${target.repository}`]));
      } catch {
        throw new Error("GitHub repository metadata is invalid.");
      }
      const repository = isObject(metadata) ? metadata.full_name : undefined;
      const baseBranch = isObject(metadata) ? metadata.default_branch : undefined;
      return {
        identity,
        repository: typeof repository === "string" ? repository : "",
        baseBranch: typeof baseBranch === "string" ? baseBranch : "",
        authorized: repository === target.repository && baseBranch === target.baseBranch,
      };
    },
    existingPullRequest: ({ plan, target }) =>
      execute("gh", [
        "pr",
        "list",
        "--repo",
        target.repository,
        "--state",
        "open",
        "--base",
        target.baseBranch,
        "--head",
        plan.branch,
        "--json",
        "url",
        "--jq",
        '.[0].url // ""',
      ]) || null,
    createWorktree: ({ plan, target }) => {
      const root = makeTemp(join(tempRoot(), "vf-registry-release-"));
      const targetCwd = join(root, "repo");
      try {
        execute(
          "git",
          [
            "clone",
            "--branch",
            target.baseBranch,
            "--single-branch",
            "--depth",
            "1",
            `https://github.com/${target.repository}.git`,
            targetCwd,
          ],
          root,
        );
        execute("git", ["switch", "--create", plan.branch], targetCwd);
        return { id: root };
      } catch (error) {
        remove(root, { recursive: true, force: true });
        throw error;
      }
    },
    readTargetRegistryOid: (operation) => {
      const lock = readLock(join(cwd(operation), LOCK));
      return lock?.registries.find(({ name }) => name === operation.registry)?.commitOID ?? null;
    },
    writeTargetRegistryOid: (operation) => {
      const path = join(cwd(operation), LOCK);
      const lock = readLock(path);
      const entry = lock?.registries.find(({ name }) => name === operation.registry);
      if (!lock || !entry || entry.commitOID !== operation.expectedOldOid)
        throw new Error("Target registry lock changed before update.");
      entry.commitOID = operation.newOid;
      write(path, `${JSON.stringify(lock, null, 2)}\n`);
    },
    assertLockOnlyDiff: (operation) => {
      const changed = execute("git", ["diff", "--name-only"], cwd(operation))
        .split(/\r?\n/)
        .filter(Boolean);
      if (changed.length !== 1 || changed[0] !== ".vibeflow/SKILL_REGISTRY.lock.json")
        throw new Error("Target diff contains files outside the registry lock.");
    },
    verify: (operation) => {
      const result = run("vf", ["verify"], { cwd: cwd(operation) });
      const evidence = sanitizeForOutput(
        [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
      ).slice(0, 4_000);
      verifyEvidence.set(operation.worktree.id, evidence || `verify exited ${result.status}`);
      return { ok: result.status === 0, evidence };
    },
    commit: (operation) => {
      const targetCwd = cwd(operation);
      execute("git", ["add", "--", ".vibeflow/SKILL_REGISTRY.lock.json"], targetCwd);
      execute(
        "git",
        ["commit", "-m", `chore: update ${operation.plan.skill} to ${operation.plan.version}`],
        targetCwd,
      );
      return execute("git", ["rev-parse", "HEAD"], targetCwd);
    },
    push: (operation) => {
      execute("git", ["push", "--set-upstream", "origin", operation.plan.branch], cwd(operation));
    },
    createPullRequest: (operation) => {
      const { releaseIdentity: release, plan } = operation;
      const title = `chore: update ${plan.skill} to ${plan.version}`;
      const body = [
        `Proposal: ${operation.proposalId}`,
        `Registry: ${release.registry}`,
        `From OID: ${release.fromOid}`,
        `To OID: ${release.toOid}`,
        `Version: ${release.version}`,
        `Changelog: ${operation.changelog || "(none)"}`,
        `Verify: ${verifyEvidence.get(operation.worktree.id) ?? "missing"}`,
      ].join("\n");
      const url = execute(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          operation.target.repository,
          "--base",
          operation.target.baseBranch,
          "--head",
          plan.branch,
          "--title",
          title,
          "--body",
          body,
        ],
        cwd(operation),
      );
      const number = pullRequestNumber(url, operation.target.repository);
      if (!number) throw new Error("GitHub pull request URL is invalid.");
      let pullRequest: unknown;
      try {
        pullRequest = JSON.parse(
          execute(
            "gh",
            ["pr", "view", number, "--repo", operation.target.repository, "--json", "state,url"],
            cwd(operation),
          ),
        );
      } catch {
        throw new Error("GitHub pull request verification failed.");
      }
      if (!isObject(pullRequest) || pullRequest.state !== "OPEN" || pullRequest.url !== url)
        throw new Error("GitHub pull request verification mismatch.");
      return { url };
    },
    cleanupWorktree: (operation) => {
      verifyEvidence.delete(operation.worktree.id);
      remove(operation.worktree.id, { recursive: true, force: true });
    },
  };
}

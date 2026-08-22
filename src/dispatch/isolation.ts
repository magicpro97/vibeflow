import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { IsolationLeaseProjection } from "./session-types.js";

export interface ContainerRuntimeInspector {
  inspect(containerId: string): {
    id: string;
    running: boolean;
    mounts: readonly { source: string; destination: string }[];
  };
}

export interface DockerRuntimeInspectorOptions {
  /** Trusted test seam. Receives the exact argument array used by production Docker inspect. */
  run?: (argv: readonly string[]) => unknown;
}

export interface IsolationLeaseInput {
  kind: IsolationLeaseProjection["kind"];
  root: string;
  cwd: string;
  evidence_ref: string;
  release?: () => void | Promise<void>;
  /** Required for worktree leases: canonical primary VibeFlow repository root. */
  repoRoot?: string;
  /** Required for container leases. */
  containerId?: string;
  /** Required branded runtime inspection authority for container leases. */
  runtimeInspector?: ContainerRuntimeInspector;
  /** Rejected legacy field retained so old callers fail at runtime, not compilation. */
  runtimeAuthority?: () => boolean;
}

export interface ValidatedIsolationLease extends IsolationLeaseProjection {
  root: string;
  repoRoot: string;
  containerId?: string;
}

interface IsolationLeaseRecord {
  projection: IsolationLeaseProjection;
  root: string;
  state: "available" | "claimed" | "released";
  release?: () => void | Promise<void>;
  releasePromise?: Promise<void>;
  repoRoot?: string;
  gitCommonDir?: string;
  containerId?: string;
  runtimeInspector?: ContainerRuntimeInspector;
}

const leases = new WeakMap<object, IsolationLeaseRecord>();
const inspectors = new WeakSet<object>();

function canonicalDirectory(path: string, label: string): string {
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory`);
  return canonical;
}

function assertInside(root: string, cwd: string): void {
  const rel = relative(root, cwd);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`isolation cwd is outside isolation root: ${cwd}`);
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitCommonDir(cwd: string): string {
  const raw = git(cwd, ["rev-parse", "--git-common-dir"]);
  return canonicalDirectory(resolve(cwd, raw), "git common directory");
}

function assertGitWorktree(repoRoot: string, cwd: string, expectedCommonDir?: string): string {
  try {
    const primary = canonicalDirectory(repoRoot, "canonical VibeFlow repository");
    if (
      canonicalDirectory(git(primary, ["rev-parse", "--show-toplevel"]), "git root") !== primary
    ) {
      throw new Error("primary root mismatch");
    }
    const top = canonicalDirectory(git(cwd, ["rev-parse", "--show-toplevel"]), "worktree root");
    if (top !== cwd || top === primary) throw new Error("not a distinct linked worktree");
    const common = gitCommonDir(primary);
    if (gitCommonDir(cwd) !== common || (expectedCommonDir && common !== expectedCommonDir)) {
      throw new Error("common directory mismatch");
    }
    const registered = git(primary, ["worktree", "list", "--porcelain"])
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    if (!registered.some((path) => canonicalDirectory(path, "registered worktree") === cwd)) {
      throw new Error("worktree is not registered");
    }
    return common;
  } catch {
    throw new Error(`canonical VibeFlow repository worktree authority is unavailable for: ${cwd}`);
  }
}

function containerPath(value: string, label: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new Error(`${label} must be an absolute container path`);
  }
  return posix.normalize(value);
}

function containerInside(root: string, child: string): boolean {
  const rel = posix.relative(root, child);
  return rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
}

function assertContainerInside(root: string, cwd: string): void {
  if (!containerInside(root, cwd)) throw new Error("container cwd is outside isolation root");
}

function inspectContainer(record: IsolationLeaseRecord): void {
  const { runtimeInspector, containerId, root, projection } = record;
  if (!runtimeInspector || !inspectors.has(runtimeInspector) || !containerId) {
    throw new Error("trusted container runtime authority is unavailable");
  }
  const inspected = runtimeInspector.inspect(containerId);
  if (!inspected.running || inspected.id !== containerId) {
    throw new Error("container runtime authority is not live");
  }
  if (!record.repoRoot) throw new Error("container associated canonical repository is unavailable");
  const associated = inspected.mounts.some(({ source, destination }) => {
    try {
      const canonicalSource = canonicalDirectory(source, "container mount source");
      const hostRelative = relative(canonicalSource, record.repoRoot as string);
      if (
        hostRelative === ".." ||
        hostRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(hostRelative)
      ) {
        return false;
      }
      const containerRelative = posix.relative(destination, root);
      return hostRelative.split("\\").join("/") === containerRelative;
    } catch {
      return false;
    }
  });
  if (!associated) {
    throw new Error("container mount lacks an associated canonical repository");
  }
  assertContainerInside(root, projection.cwd);
}

/** Build branded Docker inspection authority. Production uses an argument-array invocation. */
export function createDockerRuntimeInspector(
  options: DockerRuntimeInspectorOptions = {},
): ContainerRuntimeInspector {
  const run =
    options.run ??
    ((argv: readonly string[]) =>
      execFileSync(argv[0] as string, argv.slice(1), {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
  const inspector: ContainerRuntimeInspector = Object.freeze({
    inspect(containerId: string) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
        throw new Error("invalid container identity");
      }
      const raw = run([
        "docker",
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .}}",
        containerId,
      ]);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const value = parsed as {
        Id?: unknown;
        State?: { Running?: unknown };
        Mounts?: { Source?: unknown; Destination?: unknown }[];
      };
      return {
        id: typeof value.Id === "string" ? value.Id : "",
        running: value.State?.Running === true,
        mounts: Array.isArray(value.Mounts)
          ? value.Mounts.flatMap((mount) =>
              typeof mount.Source === "string" && typeof mount.Destination === "string"
                ? [
                    {
                      source: mount.Source,
                      destination: containerPath(mount.Destination, "container mount"),
                    },
                  ]
                : [],
            )
          : [],
      };
    },
  });
  inspectors.add(inspector);
  return inspector;
}

/** Register a canonical, live worktree/container boundary and return its exact authority view. */
export function createIsolationLease(input: IsolationLeaseInput): IsolationLeaseProjection {
  if (!input.evidence_ref.trim()) throw new Error("isolation evidence_ref is required");
  if (input.runtimeAuthority) throw new Error("trusted container runtime authority is required");
  let root: string;
  let cwd: string;
  let common: string | undefined;
  if (input.kind === "worktree") {
    root = canonicalDirectory(input.root, "isolation root");
    cwd = canonicalDirectory(input.cwd, "isolation cwd");
    assertInside(root, cwd);
    if (!input.repoRoot) throw new Error("canonical VibeFlow repository root is required");
    common = assertGitWorktree(input.repoRoot, cwd);
  } else {
    root = containerPath(input.root, "container isolation root");
    cwd = containerPath(input.cwd, "container isolation cwd");
    assertContainerInside(root, cwd);
    if (!input.repoRoot) throw new Error("container associated canonical repository is required");
    if (!input.containerId || !input.runtimeInspector || !inspectors.has(input.runtimeInspector)) {
      throw new Error("trusted container runtime authority is unavailable");
    }
  }
  const projection: IsolationLeaseProjection = Object.freeze({
    kind: input.kind,
    cwd,
    evidence_ref: input.evidence_ref,
  });
  const record: IsolationLeaseRecord = {
    projection,
    root,
    state: "available",
    release: input.release,
    ...(input.repoRoot
      ? { repoRoot: canonicalDirectory(input.repoRoot, "canonical VibeFlow repository") }
      : {}),
    ...(common ? { gitCommonDir: common } : {}),
    ...(input.containerId ? { containerId: input.containerId } : {}),
    ...(input.runtimeInspector ? { runtimeInspector: input.runtimeInspector } : {}),
  };
  if (input.kind === "container") inspectContainer(record);
  leases.set(projection, record);
  return projection;
}

function validateRecord(projection: IsolationLeaseProjection): IsolationLeaseRecord {
  const record = leases.get(projection);
  if (!record || record.state !== "available" || record.projection !== projection) {
    throw new Error("isolation lease is absent, claimed, or released");
  }
  if (projection.kind === "worktree") {
    const root = canonicalDirectory(record.root, "isolation root");
    const cwd = canonicalDirectory(projection.cwd, "isolation cwd");
    assertInside(root, cwd);
    if (cwd !== projection.cwd || !record.repoRoot) throw new Error("worktree lease changed");
    assertGitWorktree(record.repoRoot, cwd, record.gitCommonDir);
  } else inspectContainer(record);
  return record;
}

export function validateIsolationLease(
  projection: IsolationLeaseProjection,
): ValidatedIsolationLease {
  const record = validateRecord(projection);
  return {
    ...projection,
    root: record.root,
    repoRoot: record.repoRoot as string,
    ...(record.containerId ? { containerId: record.containerId } : {}),
  };
}

/** Atomically consume a lease for one process attempt. */
export function claimIsolationLease(projection: IsolationLeaseProjection): ValidatedIsolationLease {
  const record = validateRecord(projection);
  record.state = "claimed";
  return {
    ...projection,
    root: record.root,
    repoRoot: record.repoRoot as string,
    ...(record.containerId ? { containerId: record.containerId } : {}),
  };
}

/** Materialize the process boundary without exposing container identity on the public lease. */
export function materializeIsolationInvocation(
  lease: ValidatedIsolationLease | undefined,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { argv: string[]; cwd?: string } {
  if (!lease) return { argv: [...argv] };
  if (lease.kind === "worktree") return { argv: [...argv], cwd: lease.cwd };
  const passEnv = Object.keys(env)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort()
    .flatMap((name) => ["--env", name]);
  return {
    argv: [
      "docker",
      "exec",
      "-i",
      "-w",
      lease.cwd,
      ...passEnv,
      lease.containerId as string,
      ...argv,
    ],
  };
}

export function isIsolationLeaseLive(projection: IsolationLeaseProjection): boolean {
  try {
    validateRecord(projection);
    return true;
  } catch {
    return false;
  }
}

/** Release once. Concurrent and repeated callers share the same completion promise. */
export function releaseIsolationLease(projection: IsolationLeaseProjection): Promise<void> {
  const record = leases.get(projection);
  if (!record) return Promise.resolve();
  if (record.releasePromise) return record.releasePromise;
  record.state = "released";
  try {
    record.releasePromise = Promise.resolve(record.release?.());
  } catch (error) {
    record.releasePromise = Promise.reject(error);
  }
  return record.releasePromise;
}

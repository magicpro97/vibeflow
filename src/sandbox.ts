import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface SandboxRequest {
  image: string;
  dependencyVolume: string;
}

export interface DockerSandbox extends SandboxRequest {
  target: string;
  containerName: string;
  uid: number;
  gid: number;
}

export interface DisposableTarget {
  path: string;
  cleanup(): void;
}

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface SandboxRuntime {
  hasDocker(): boolean;
  run(args: string[], cwd: string): CommandResult;
  uid(): number | undefined;
  gid(): number | undefined;
}

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const IMAGE_DIGEST = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type SandboxFlagsResult =
  | { ok: true; request?: SandboxRequest }
  | { ok: false; message: string; exitCode: 2 };

export type PreparedSandbox =
  | { ok: true; spec: DockerSandbox; cleanup(): void }
  | { ok: false; message: string };

export function validateImageDigest(value: string): boolean {
  return IMAGE_DIGEST.test(value);
}

export function validateVolumeName(value: string): boolean {
  return VOLUME_NAME.test(value);
}

export function parseSandboxFlags(flags: Record<string, string | boolean>): SandboxFlagsResult {
  const equalsForm = Object.keys(flags).find((key) => key.startsWith("sandbox="));
  if (equalsForm)
    return { ok: false, exitCode: 2, message: "use --sandbox docker, not --sandbox=docker" };
  if (flags.sandbox === undefined) {
    if (flags["sandbox-image"] !== undefined || flags["sandbox-volume"] !== undefined)
      return {
        ok: false,
        exitCode: 2,
        message: "--sandbox-image/--sandbox-volume require --sandbox docker",
      };
    return { ok: true };
  }
  if (flags.sandbox !== "docker")
    return { ok: false, exitCode: 2, message: "sandbox must be `docker`: use --sandbox docker" };
  if (flags["sandbox-network"] !== undefined)
    return { ok: false, exitCode: 2, message: "--sandbox-network is not supported" };
  const image = flags["sandbox-image"];
  const dependencyVolume = flags["sandbox-volume"];
  if (typeof image !== "string" || !validateImageDigest(image))
    return { ok: false, exitCode: 2, message: "--sandbox-image must be a digest-pinned image" };
  if (typeof dependencyVolume !== "string" || !validateVolumeName(dependencyVolume))
    return { ok: false, exitCode: 2, message: "--sandbox-volume must be a Docker volume name" };
  return { ok: true, request: { image, dependencyVolume } };
}

export function toContainerDir(base: string, dir: string): string | undefined {
  const rel = relative(resolve(base), resolve(dir));
  if (rel.startsWith("..") || rel.includes("\0") || resolve(dir) !== resolve(base, rel))
    return undefined;
  return rel ? `/w/${rel.split("\\").join("/")}` : "/w";
}

export function lockfileDigest(base: string): string | undefined {
  const files = LOCKFILES.filter((name) => existsSync(join(base, name)));
  if (files.length !== 1) return undefined;
  return createHash("sha256")
    .update(readFileSync(join(base, files[0] as string)))
    .digest("hex");
}

export function createDisposableTarget(base: string): DisposableTarget {
  const parent = join(base, ".vibeflow");
  mkdirSync(parent, { recursive: true });
  const path = mkdtempSync(join(parent, "sandbox-"));
  try {
    const listed = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: base, encoding: "buffer", timeout: 10000 },
    );
    if (listed.status !== 0) throw new Error("git ls-files failed");
    const files = (listed.stdout ?? Buffer.alloc(0)).toString().split("\0").filter(Boolean);
    for (const file of files) {
      const parts = file.split(/[\\/]/);
      const hasControl = [...file].some((character) => character.charCodeAt(0) < 32);
      if (file.startsWith("/") || parts.includes("..") || hasControl)
        throw new Error("unsafe git path");
      if (parts[0] === ".vibeflow") continue;
      const source = join(base, file);
      if (!existsSync(source)) continue;
      const destination = join(path, file);
      mkdirSync(dirname(destination), { recursive: true });
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
      else if (stat.isFile()) copyFileSync(source, destination);
      else throw new Error("unsupported tracked entry");
    }
    const lcov = join(base, "coverage", "lcov.info");
    if (existsSync(lcov)) {
      const destination = join(path, "coverage", "lcov.info");
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(lcov, destination);
    }
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function defaultSandboxRuntime(): SandboxRuntime {
  return {
    hasDocker: () => Boolean(Bun.which("docker")),
    run: (args, cwd) => {
      const result = spawnSync("docker", args, { cwd, encoding: "utf8", timeout: 10000 });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error ? { error: result.error } : {}),
      };
    },
    uid: () => process.getuid?.(),
    gid: () => process.getgid?.(),
  };
}

export function prepareDockerSandbox(
  request: SandboxRequest,
  base: string,
  runtime: SandboxRuntime = defaultSandboxRuntime(),
): PreparedSandbox {
  if (!validateImageDigest(request.image) || !validateVolumeName(request.dependencyVolume))
    return { ok: false, message: "sandbox image or volume is invalid" };
  if (!runtime.hasDocker())
    return { ok: false, message: "--sandbox requested but docker is not on PATH" };
  if (runtime.run(["info", "--format", "{{.ServerVersion}}"], base).status !== 0)
    return { ok: false, message: "--sandbox requested but Docker daemon is unavailable" };
  if (runtime.run(["image", "inspect", request.image], base).status !== 0)
    return { ok: false, message: "sandbox image is unavailable locally; vf never pulls images" };
  const digest = lockfileDigest(base);
  if (!digest) return { ok: false, message: "sandbox requires exactly one supported lockfile" };
  const volume = runtime.run(
    [
      "volume",
      "inspect",
      "--format",
      '{{ index .Labels "vibeflow.lock-sha256" }}',
      request.dependencyVolume,
    ],
    base,
  );
  if (volume.status !== 0 || volume.stdout.trim() !== digest)
    return { ok: false, message: "sandbox volume is missing or does not match the lockfile" };
  const uid = runtime.uid();
  const gid = runtime.gid();
  if (
    uid === undefined ||
    gid === undefined ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0
  )
    return { ok: false, message: "sandbox could not determine a non-root host uid/gid" };
  try {
    const target = createDisposableTarget(base);
    return {
      ok: true,
      spec: {
        ...request,
        target: target.path,
        containerName: `vf-verify-${process.pid}-${Date.now()}`,
        uid,
        gid,
      },
      cleanup: target.cleanup,
    };
  } catch {
    return { ok: false, message: "sandbox could not create disposable source copy" };
  }
}

export function buildDockerGateCommand(
  command: string,
  args: readonly string[],
  spec: DockerSandbox,
  base: string,
  dir: string,
): { cmd: "docker"; args: string[] } {
  const workdir = toContainerDir(base, dir);
  if (!workdir) throw new Error("sandbox gate directory is outside disposable target");
  return {
    cmd: "docker",
    args: [
      "run",
      "--rm",
      "--name",
      spec.containerName,
      "--network",
      "none",
      "--user",
      `${spec.uid}:${spec.gid}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--cpus",
      "2",
      "-v",
      `${spec.target}:/w`,
      "-v",
      `${spec.dependencyVolume}:/w/node_modules:ro`,
      "-w",
      workdir,
      spec.image,
      command,
      ...args,
    ],
  };
}

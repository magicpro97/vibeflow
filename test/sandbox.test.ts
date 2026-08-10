import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDockerGateCommand,
  createDisposableTarget,
  defaultSandboxRuntime,
  lockfileDigest,
  parseSandboxFlags,
  prepareDockerSandbox,
  toContainerDir,
  validateImageDigest,
  validateVolumeName,
} from "../src/sandbox.js";

const image = "example/vf@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("sandbox flags (#554)", () => {
  test("leaves sandbox off unless requested", () => {
    expect(parseSandboxFlags({})).toEqual({ ok: true, request: undefined });
  });

  test("accepts only docker with digest image and named volume", () => {
    expect(
      parseSandboxFlags({ sandbox: "docker", "sandbox-image": image, "sandbox-volume": "vf-deps" }),
    ).toEqual({ ok: true, request: { image, dependencyVolume: "vf-deps" } });
  });

  test("rejects invalid sandbox flags", () => {
    const invalid: Array<Record<string, string | boolean>> = [
      { sandbox: true },
      { sandbox: "podman" },
      { sandbox: "docker" },
      {
        sandbox: "docker",
        "sandbox-image": image,
        "sandbox-volume": "vf-deps",
        "sandbox-network": true,
      },
      { "sandbox=docker": true },
      { "sandbox-image": image },
      { sandbox: "docker", "sandbox-image": "example/vf:latest", "sandbox-volume": "vf-deps" },
      { sandbox: "docker", "sandbox-image": image, "sandbox-volume": "bad:/w" },
    ];
    for (const flags of invalid) expect(parseSandboxFlags(flags).ok).toBe(false);
  });
});

describe("sandbox values (#554)", () => {
  test("validates image digest and volume name", () => {
    expect(validateImageDigest(image)).toBe(true);
    expect(validateImageDigest("example/vf:latest")).toBe(false);
    expect(validateVolumeName("vf-deps_1.0")).toBe(true);
    expect(validateVolumeName("-bad")).toBe(false);
  });

  test("maps only child cwd into container", () => {
    expect(toContainerDir("/repo", "/repo")).toBe("/w");
    expect(toContainerDir("/repo", "/repo/web")).toBe("/w/web");
    expect(toContainerDir("/repo", "/other")).toBeUndefined();
  });

  test("builds hardened offline docker argv", () => {
    expect(
      buildDockerGateCommand(
        "bun",
        ["run", "test"],
        {
          image,
          target: "/tmp/vf-copy",
          containerName: "vf-test",
          dependencyVolume: "vf-deps",
          uid: 501,
          gid: 20,
        },
        "/tmp/vf-copy",
        "/tmp/vf-copy/web",
      ),
    ).toEqual({
      cmd: "docker",
      args: [
        "run",
        "--rm",
        "--name",
        "vf-test",
        "--network",
        "none",
        "--user",
        "501:20",
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
        "/tmp/vf-copy:/w",
        "-v",
        "vf-deps:/w/node_modules:ro",
        "-w",
        "/w/web",
        image,
        "bun",
        "run",
        "test",
      ],
    });
  });
});

describe("sandbox preflight (#554)", () => {
  test("requires docker, local image, matching labeled volume, and host identity", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-sandbox-test-"));
    writeFileSync(join(base, "bun.lock"), "lock");
    writeFileSync(join(base, "package.json"), "{}");
    writeFileSync(join(base, ".gitignore"), ".env\n");
    writeFileSync(join(base, ".env"), "SECRET=do-not-copy\n");
    mkdirSync(join(base, "coverage"));
    writeFileSync(join(base, "coverage", "lcov.info"), "TN:\n");
    symlinkSync("package.json", join(base, "package-link.json"));
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["add", "bun.lock", "package.json", "package-link.json", ".gitignore"], {
      cwd: base,
    });
    const digest = lockfileDigest(base) as string;
    const calls: string[][] = [];
    const runtime = {
      hasDocker: () => true,
      run: (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: args[0] === "volume" ? `${digest}\n` : "", stderr: "" };
      },
      uid: () => 501,
      gid: () => 20,
    };
    try {
      const result = prepareDockerSandbox({ image, dependencyVolume: "vf-deps" }, base, runtime);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.target).not.toBe(base);
        expect(existsSync(join(result.spec.target, "package.json"))).toBe(true);
        expect(existsSync(join(result.spec.target, ".git"))).toBe(false);
        expect(existsSync(join(result.spec.target, ".env"))).toBe(false);
        expect(readlinkSync(join(result.spec.target, "package-link.json"))).toBe("package.json");
        expect(existsSync(join(result.spec.target, "coverage", "lcov.info"))).toBe(true);
        expect(calls).toEqual([
          ["info", "--format", "{{.ServerVersion}}"],
          ["image", "inspect", image],
          [
            "volume",
            "inspect",
            "--format",
            '{{ index .Labels "vibeflow.lock-sha256" }}',
            "vf-deps",
          ],
        ]);
        result.cleanup();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("fails closed before source copy when docker or volume preflight fails", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-sandbox-test-"));
    writeFileSync(join(base, "bun.lock"), "lock");
    try {
      expect(
        prepareDockerSandbox({ image, dependencyVolume: "vf-deps" }, base, {
          hasDocker: () => false,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
          uid: () => 501,
          gid: () => 20,
        }),
      ).toMatchObject({ ok: false, message: expect.stringContaining("docker") });
      expect(
        prepareDockerSandbox({ image, dependencyVolume: "vf-deps" }, base, {
          hasDocker: () => true,
          run: (args) => ({ status: args[0] === "volume" ? 1 : 0, stdout: "", stderr: "" }),
          uid: () => 501,
          gid: () => 20,
        }),
      ).toMatchObject({ ok: false, message: expect.stringContaining("volume") });
      expect(prepareDockerSandbox({ image: "bad", dependencyVolume: "vf-deps" }, base).ok).toBe(
        false,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("default runtime is bounded and disposable copy rejects non-file git entries", () => {
    const runtime = defaultSandboxRuntime();
    expect(typeof runtime.hasDocker()).toBe("boolean");
    expect(runtime.run(["--version"], process.cwd()).status).not.toBeUndefined();
    expect(runtime.uid()).toBe(process.getuid?.());
    expect(runtime.gid()).toBe(process.getgid?.());

    const base = mkdtempSync(join(tmpdir(), "vf-sandbox-gitlink-"));
    mkdirSync(join(base, "vendor"));
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor`],
      { cwd: base },
    );
    try {
      expect(() => createDisposableTarget(base)).toThrow("unsupported tracked entry");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("failed copy and outside gate directory fail closed", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-sandbox-invalid-"));
    writeFileSync(join(base, "bun.lock"), "lock");
    const runtime = {
      hasDocker: () => true,
      run: (args: string[]) => ({
        status: 0,
        stdout: args[0] === "volume" ? `${lockfileDigest(base)}\n` : "",
        stderr: "",
      }),
      uid: () => 501,
      gid: () => 20,
    };
    try {
      expect(
        prepareDockerSandbox({ image, dependencyVolume: "vf-deps" }, base, runtime),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining("disposable"),
      });
      expect(() =>
        buildDockerGateCommand(
          "bun",
          [],
          {
            image,
            target: base,
            containerName: "vf-test",
            dependencyVolume: "vf-deps",
            uid: 501,
            gid: 20,
          },
          base,
          tmpdir(),
        ),
      ).toThrow("outside disposable target");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

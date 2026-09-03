import { afterEach, describe, expect, test } from "bun:test";
import { AssertionError } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../src/capabilities/index.js";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import { capability } from "../src/commands/capability.js";
import { VERSION } from "../src/core.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../src/core/capability-contract.js";
import { resolvedRolePackage, retainRuntimePackageCache } from "./capabilities/runtime-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-capability-command-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  const userVibeflowRoot = join(homeRoot, ".vibeflow");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  const now = () => "2026-08-25T12:00:00.000Z";
  activateProjectCapabilityAuthorityForVfInit(projectRoot, { now });
  const runtime = productionCapabilityRuntimeV1({
    projectRoot,
    userHomeRoot: homeRoot,
    userVibeflowRoot,
    now,
    vfVersion: VERSION,
  });
  const service = runtime.service("project");
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(service.options.storage, pkg);
  return { projectRoot, homeRoot, userVibeflowRoot, runtime, pkg };
}

function installArgv(fx: ReturnType<typeof fixture>, json = false): string[] {
  return [
    "install",
    fx.pkg.pin.id,
    "--scope",
    "project",
    "--package-pin-digest",
    fx.pkg.pin.pin_digest,
    "--for",
    "codex",
    "--yes",
    ...(json ? ["--json"] : []),
  ];
}

async function run(
  argv: string[],
  fx: ReturnType<typeof fixture>,
  extra: Partial<Parameters<typeof capability>[1]> = {},
) {
  const lines: string[] = [];
  const code = await capability(argv, {
    base: fx.projectRoot,
    userHomeRoot: fx.homeRoot,
    userVibeflowRoot: fx.userVibeflowRoot,
    stdinIsTTY: true,
    stdinHasData: false,
    writer: (line) => {
      if (line) lines.push(line);
    },
    runtimeFactory: () => fx.runtime,
    ...extra,
  });
  return { code, lines };
}

describe("vf capability command", () => {
  test("status emits exact JSON for a cached-but-absent package", async () => {
    const fx = fixture();
    const { code, lines } = await run(
      ["status", fx.pkg.pin.id, "--scope", "project", "--json"],
      fx,
    );
    expect(code).toBe(0);
    const result = JSON.parse(lines[0] as string);
    expect(result.kind).toBe("query");
    expect(result.command).toBe("capability.status");
    expect(result.items[0]?.package_id).toBe(fx.pkg.pin.id);
    expect(result.items[0]?.status).toBe("absent");
  });

  test("documented private-input bind shape executes and never echoes the secret", async () => {
    const fx = fixture();
    const { code, lines } = await run(
      [
        "private-input",
        "bind",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--input",
        "api_key",
        "--values-stdin",
        "--idempotency-key",
        "private-input-1",
        "--json",
      ],
      fx,
      {
        stdin: () => JSON.stringify({ api_key: "super-secret-token" }),
        stdinIsTTY: false,
        stdinHasData: true,
      },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("super-secret-token");
    const result = JSON.parse(lines[0] as string);
    expect(result.kind).toBe("private-input-binding");
    expect(result.binding.input_ids).toEqual(["api_key"]);
  });

  test("install dry-run emits a real Fabric plan", async () => {
    const fx = fixture();
    const { code, lines } = await run(
      [
        "install",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--package-pin-digest",
        fx.pkg.pin.pin_digest,
        "--for",
        "codex",
        "--dry-run",
        "--json",
      ],
      fx,
    );
    expect(code).toBe(0);
    const result = JSON.parse(lines[0] as string);
    expect(result.kind).toBe("plan");
    expect(["planned", "no-op", "action-required"]).toContain(result.status);
    expect(result.command).toBe("capability.install");
    expect(typeof result.plan_digest).toBe("string");
  });

  test("tagged runtime failures are sanitized and emitted exactly once", async () => {
    const fx = fixture();
    for (const json of [true, false]) {
      const lines: Array<{ message: string; level: string | undefined }> = [];
      const code = await capability(installArgv(fx, json), {
        base: fx.projectRoot,
        userHomeRoot: fx.homeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        stdinIsTTY: true,
        stdinHasData: false,
        runtimeFactory: () => fx.runtime,
        mutationPort: {
          execute() {
            throw new CapabilityRuntimeError(
              "backend returned undefined at C:\\private\\capability.json\n    at execute",
              CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
            );
          },
        },
        writer: (message, level) => lines.push({ message, level }),
      });
      expect(code).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toContain("Capability service is unavailable.");
      expect(lines[0]?.message).not.toMatch(/undefined|private|at execute/iu);
      if (json) {
        expect(lines[0]?.level).toBeUndefined();
        expect(JSON.parse(lines[0]?.message ?? "")).toMatchObject({
          kind: "usage-error",
          command: "capability.install",
          error: { code: "service_unavailable" },
        });
      } else {
        expect(lines[0]?.level).toBe("error");
      }
    }
  });

  test("all unclassified and programmer faults bypass capability rendering", async () => {
    const fx = fixture();
    class CustomInvariantError extends Error {}
    const nonErrorFault = { invariant: "non-error" };
    const faults: unknown[] = [
      new AssertionError({ message: "assertion invariant fault" }),
      new TypeError("type invariant fault"),
      new Error("unclassified operational-looking fault"),
      new CustomInvariantError("custom invariant fault"),
      new CapabilityRuntimeError("unknown runtime code", "unclassified" as never),
      nonErrorFault,
    ];
    for (const fault of faults) {
      const lines: string[] = [];
      let observed: unknown;
      try {
        await capability(installArgv(fx, true), {
          base: fx.projectRoot,
          userHomeRoot: fx.homeRoot,
          userVibeflowRoot: fx.userVibeflowRoot,
          stdinIsTTY: true,
          stdinHasData: false,
          runtimeFactory: () => fx.runtime,
          mutationPort: {
            execute() {
              throw fault;
            },
          },
          writer: (message) => lines.push(message),
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(fault);
      expect(lines).toEqual([]);
    }
  });
});

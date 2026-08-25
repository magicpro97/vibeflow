import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../src/capabilities/index.js";
import { capability } from "../src/commands/capability.js";
import { VERSION } from "../src/core.js";
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

  test("private-input bind accepts stdin JSON and never echoes the secret", async () => {
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
        "bind-api-key",
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
});

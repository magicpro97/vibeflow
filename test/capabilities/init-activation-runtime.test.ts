import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionCapabilityRuntimeV1 } from "../../src/capabilities/index.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/index.js";
import { init } from "../../src/commands/init.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ready = () => [
  { engine: "claude" as const, level: "ready" as const, detail: "ok", checkedAt: "now" },
];

async function runInit(projectRoot: string, userVibeflowRoot: string): Promise<number> {
  const prior = process.cwd();
  process.chdir(projectRoot);
  try {
    return await init(
      {
        engine: "claude",
        "no-coord": true,
        "no-ai": true,
        "no-hooks": true,
        "no-memory": true,
        "no-tools": true,
      },
      { preflight: ready, hookSetup: null, detectTool: () => true, userVibeflowRoot },
    );
  } finally {
    process.chdir(prior);
  }
}

describe("vf init capability authority activation", () => {
  test("activates the project authority and immediately serves a zero-write query", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-authority-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });

    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    expect(existsSync(join(userVibeflowRoot, "recovery", "BOOTSTRAP_IDENTITY.json"))).toBeTrue();
    const paths = projectCapabilityPaths(projectRoot);
    expect(existsSync(paths.identity)).toBeTrue();
    const runtime = productionCapabilityRuntimeV1({
      projectRoot,
      userHomeRoot,
      userVibeflowRoot,
    });
    expect(
      runtime.query({ view: "status", scope: "project", package_id: "acme.none" }).items[0]?.status,
    ).toBe("absent");
  });

  test("fails closed when init encounters dependent state without an identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-partial-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    mkdirSync(paths.privateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(paths.privateRoot, "operations", "v1"), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.privateRoot, "operations", "v1", "orphan"), "partial", {
      mode: 0o600,
    });

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow(/quarantined/i);
    expect(existsSync(paths.identity)).toBeFalse();
    const runtime = productionCapabilityRuntimeV1({
      projectRoot,
      userHomeRoot,
      userVibeflowRoot,
    });
    expect(() => runtime.service("project")).toThrow(/not activated/i);
  });
});

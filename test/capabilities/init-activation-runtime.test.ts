import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityEpochHeadDigest } from "../../src/capabilities/authority/index.js";
import { productionCapabilityRuntimeV1 } from "../../src/capabilities/index.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/index.js";
import { init } from "../../src/commands/init.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";

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

  test("fails closed when a capability lock exists without an identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-lock-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    writeFileSync(paths.currentLock, "stale capability lock", { mode: 0o600 });

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow(/quarantined/i);
    expect(existsSync(paths.identity)).toBeFalse();
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

  test("recovers orphaned legacy activation artifacts when the identity is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-legacy-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);

    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    expect(existsSync(paths.identity)).toBeTrue();
    expect(existsSync(join(paths.privateRoot, "..", "legacy-activation"))).toBeTrue();
    const runtime = productionCapabilityRuntimeV1({
      projectRoot,
      userHomeRoot,
      userVibeflowRoot,
    });
    expect(
      runtime.query({ view: "status", scope: "project", package_id: "acme.none" }).items[0]?.status,
    ).toBe("absent");
  });

  test("recovers activation artifacts when only a receipt and checkpoint remain", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-no-head-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userVibeflowRoot = join(root, "home", ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);
    rmSync(join(paths.privateRoot, "authority", "v1", "epoch-head.json"));

    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    expect(existsSync(paths.identity)).toBeTrue();
    expect(existsSync(join(paths.privateRoot, "..", "legacy-activation"))).toBeTrue();
  });

  test("fails closed when the orphaned head is beyond epoch zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-epoch-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);
    const headPath = join(paths.privateRoot, "authority", "v1", "epoch-head.json");
    const head = JSON.parse(readFileSync(headPath, "utf8")) as Record<string, unknown>;
    head.authority_epoch = 1;
    head.event_head_digest = digestV1("VF-TEST-EPOCH\0v1\0", {});
    head.updated_by_operation_id = "test-operation";
    head.updated_at = "2030-01-01T00:00:00.000Z";
    head.content_digest = "";
    head.content_digest = authorityEpochHeadDigest(
      head as unknown as Parameters<typeof authorityEpochHeadDigest>[0],
    );
    writeFileSync(headPath, canonicalJsonBytes(head), { mode: 0o600 });

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow(/quarantined/i);
    expect(existsSync(paths.identity)).toBeFalse();
  });

  test("fails closed when a legacy checkpoint is not canonical", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-corrupt-checkpoint-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);
    const checkpointRoot = join(paths.privateRoot, "recovery", "v1", "checkpoints");
    const checkpointPath = join(checkpointRoot, readdirSync(checkpointRoot)[0] as string);
    writeFileSync(checkpointPath, "{not canonical", { mode: 0o600 });

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow(/quarantined/i);
    expect(existsSync(paths.identity)).toBeFalse();
  });

  test("fails closed when only a later-epoch checkpoint remains without a current head", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-checkpoint-epoch-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);
    rmSync(join(paths.privateRoot, "authority", "v1", "epoch-head.json"));
    const checkpointRoot = join(paths.privateRoot, "recovery", "v1", "checkpoints");
    const checkpointPath = join(checkpointRoot, readdirSync(checkpointRoot)[0] as string);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, unknown>;
    checkpoint.authority_epoch = 1;
    checkpoint.event_head_digest = digestV1("VF-TEST-CHECKPOINT\0v1\0", {});
    checkpoint.updated_by_operation_id = "test-operation";
    checkpoint.updated_at = "2030-01-01T00:00:00.000Z";
    checkpoint.content_digest = "";
    checkpoint.content_digest = authorityEpochHeadDigest(
      checkpoint as unknown as Parameters<typeof authorityEpochHeadDigest>[0],
    );
    const laterName = `${String(checkpoint.content_digest).replace(/^sha256:/, "")}.json`;
    writeFileSync(join(checkpointRoot, laterName), canonicalJsonBytes(checkpoint), { mode: 0o600 });

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow(/quarantined/i);
    expect(existsSync(paths.identity)).toBeFalse();
  });

  test("refuses a pre-existing legacy archive symlink", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "vf-init-capability-symlink-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const paths = projectCapabilityPaths(projectRoot);
    expect(await runInit(projectRoot, userVibeflowRoot)).toBe(0);
    rmSync(paths.identity);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(paths.privateRoot, "..", "legacy-activation"));

    await expect(runInit(projectRoot, userVibeflowRoot)).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});

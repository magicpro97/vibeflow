import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DurableArtifactRegistry,
  opaqueRegistryKeyPath,
} from "../../src/orchestrator/trace/artifacts.js";
import {
  projectPublicStoredTrace,
  projectPublicTrace,
} from "../../src/orchestrator/trace/project.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const correlation = (conversation_id: string) => ({
  workflow_id: "workflow",
  conversation_id,
  revision_id: "revision",
  run_id: "run",
  turn_id: "turn",
  operation_id: "operation",
  attempt_id: "attempt",
});

const deriveOpaque = (
  key: Uint8Array,
  kind: "artifact" | "session",
  conversationId: string,
  value: string,
) =>
  `${kind}_${createHmac("sha256", key)
    .update("v7-public-opaque\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(conversationId, "utf8")), "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("base64url")}`;

// These two concurrency tests require real process boundaries to exercise the
// filesystem lock. Keep the subprocess seam local and bounded instead of using
// Bun.spawn directly, which the repository anti-pattern gate forbids in tests.
const runRuntimeScript = (script: string, timeoutMs = 5_000) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const appendBounded = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, 64 * 1_024);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });

test("opaque artifact and session identities are domain-separated and conversation-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-domains-"));
  try {
    const registry = new DurableArtifactRegistry({ dir: join(root, "registry") });
    const internalRef = "artifacts/private/plan.json";
    const first = registry.register("conversation-a", internalRef);
    const stable = registry.register("conversation-a", internalRef);
    const otherConversation = registry.register("conversation-b", internalRef);
    expect(first).toBe(stable);
    expect(first).not.toBe(otherConversation);
    expect(registry.resolve("conversation-a", first)).toEqual({ internalRef });
    expect(registry.resolve("conversation-b", first)).toBeNull();
    expect(registry.resolve("conversation-a", "artifact_unknown")).toBeNull();

    const session = registry.sessionRef("conversation-a", "native-session");
    expect(session).not.toBe(first);
    expect(session).not.toBe(registry.sessionRef("conversation-b", "native-session"));
    expect(registry.resolve("conversation-a", session)).toBeNull();
    const last = String(first).at(-1);
    const tampered = `${String(first).slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(registry.resolve("conversation-a", tampered)).toBeNull();
    expect(String(first)).not.toContain(internalRef);
    expect(String(session)).not.toContain("native-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opaque assignment framing cannot collide across control-bearing domains", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-framing-"));
  try {
    const registry = new DurableArtifactRegistry({ dir: join(root, "registry") });
    const first = registry.register("a\0b", "c");
    const second = registry.register("a", "b\0c");
    expect(second).not.toBe(first);
    expect(registry.resolve("a\0b", first)).toEqual({ internalRef: "c" });
    expect(registry.resolve("a", first)).toBeNull();
    expect(registry.resolve("a", second)).toEqual({ internalRef: "b\0c" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reverse resolution rebuilds from durable trace records after a clean restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-restart-"));
  const registryDir = join(root, "registry");
  const traceDir = join(root, "trace");
  try {
    const registry = new DurableArtifactRegistry({ dir: registryDir });
    const store = new TraceStore({ dir: traceDir, artifactRegistry: registry });
    const createdRef = "artifacts/plan-v1.json";
    const updatedRef = "artifacts/plan-v2.json";
    const previousRef = createdRef;
    await store.append(correlation("conversation-a"), {
      idempotency_key: "created",
      event: {
        type: "artifact_created",
        payload: { artifact_id: "plan", artifact_type: "plan", ref: createdRef },
      },
    });
    const updated = await store.append(
      { ...correlation("conversation-a"), attempt_id: "attempt-2" },
      {
        idempotency_key: "updated",
        event: {
          type: "artifact_updated",
          payload: {
            artifact_id: "plan",
            artifact_type: "plan",
            ref: updatedRef,
            previous_ref: previousRef,
          },
        },
      },
      "native-session-secret",
    );
    const createdOpaque = registry.register("conversation-a", createdRef);
    const updatedOpaque = registry.register("conversation-a", updatedRef);
    const publicBefore = projectPublicStoredTrace(
      { stored_event: updated, native_session_id: "native-session-secret" },
      { conversationId: "conversation-a", artifactRegistry: registry },
    );

    const restarted = new DurableArtifactRegistry({ dir: registryDir });
    expect(restarted.resolve("conversation-a", createdOpaque)).toBeNull();
    const reopened = new TraceStore({ dir: traceDir, artifactRegistry: restarted });
    const records = await reopened.readConversation("conversation-a");
    expect(records).toHaveLength(2);
    expect(restarted.resolve("conversation-a", createdOpaque)).toEqual({
      internalRef: createdRef,
    });
    expect(restarted.resolve("conversation-a", updatedOpaque)).toEqual({
      internalRef: updatedRef,
    });
    const secondRecord = records[1];
    if (!secondRecord) throw new Error("missing updated trace record");
    const publicAfter = projectPublicStoredTrace(secondRecord, {
      conversationId: "conversation-a",
      artifactRegistry: restarted,
    });
    expect(publicAfter).toEqual(publicBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository key creation is cross-process safe and mode 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-process-"));
  const registryDir = join(root, "registry");
  try {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src/orchestrator/trace/artifacts.ts"),
    ).href;
    const script = `import { DurableArtifactRegistry } from ${JSON.stringify(moduleUrl)};
const registry = new DurableArtifactRegistry({ dir: ${JSON.stringify(registryDir)} });
console.log(registry.register("conversation", "artifact/ref"));`;
    const results = await Promise.all(Array.from({ length: 6 }, () => runRuntimeScript(script)));
    expect(results.map(({ code }) => code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(new Set(results.map(({ stdout }) => stdout)).size).toBe(1);
    expect(results.map(({ stderr }) => stderr)).toEqual(["", "", "", "", "", ""]);
    const key = opaqueRegistryKeyPath(registryDir);
    const stat = lstatSync(key);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotation preserves old artifact resolution after durable rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-rotation-"));
  const registryDir = join(root, "registry");
  const traceDir = join(root, "trace");
  try {
    const registry = new DurableArtifactRegistry({ dir: registryDir });
    const store = new TraceStore({ dir: traceDir, artifactRegistry: registry });
    const internalRef = "artifacts/rotated-plan.json";
    await store.append(correlation("conversation-a"), {
      idempotency_key: "artifact-before-rotation",
      event: {
        type: "artifact_created",
        payload: { artifact_id: "plan", artifact_type: "plan", ref: internalRef },
      },
    });
    const oldId = registry.register("conversation-a", internalRef);
    const oldSession = registry.sessionRef("conversation-a", "native-session");
    expect(registry.rotate()).toBeUndefined();
    const activeKey = readFileSync(opaqueRegistryKeyPath(registryDir));
    const currentId = registry.register("conversation-a", internalRef);
    const newRef = "artifacts/created-after-rotation.json";
    const newNative = "native-created-after-rotation";
    const newId = registry.register("conversation-a", newRef);
    const newSession = registry.sessionRef("conversation-a", newNative);
    expect(currentId).toBe(oldId);
    expect(registry.sessionRef("conversation-a", "native-session")).toBe(oldSession);
    expect(String(newId)).toBe(deriveOpaque(activeKey, "artifact", "conversation-a", newRef));
    expect(String(newSession)).toBe(
      deriveOpaque(activeKey, "session", "conversation-a", newNative),
    );
    expect(String(newId)).not.toBe(
      deriveOpaque(activeKey, "artifact", "conversation-a", internalRef),
    );
    expect(registry.resolve("conversation-a", oldId)).toEqual({ internalRef });
    expect(registry.resolve("conversation-a", currentId)).toEqual({ internalRef });
    for (const path of [
      opaqueRegistryKeyPath(registryDir),
      join(registryDir, ".opaque-hmac-key-history.json"),
    ]) {
      const stat = lstatSync(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.nlink).toBe(1);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    const restarted = new DurableArtifactRegistry({ dir: registryDir });
    const reopened = new TraceStore({ dir: traceDir, artifactRegistry: restarted });
    await reopened.readConversation("conversation-a");
    expect(restarted.resolve("conversation-a", oldId)).toEqual({ internalRef });
    expect(restarted.resolve("conversation-a", currentId)).toEqual({ internalRef });
    expect(restarted.sessionRef("conversation-a", "native-session")).toBe(oldSession);
    expect(restarted.register("conversation-a", newRef)).toBe(newId);
    expect(restarted.sessionRef("conversation-a", newNative)).toBe(newSession);
    for (const name of readdirSync(registryDir).filter((entry) => !entry.endsWith(".lock"))) {
      const path = join(registryDir, name);
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      expect(stat.mode & 0o777).toBe(0o600);
      const bytes = readFileSync(path);
      for (const raw of [internalRef, newRef, "native-session", newNative])
        expect(bytes.includes(Buffer.from(raw))).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent cross-process rotations retain every issued artifact ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-rotation-process-"));
  const registryDir = join(root, "registry");
  try {
    const initial = new DurableArtifactRegistry({ dir: registryDir });
    const oldId = initial.register("conversation", "artifact/ref");
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src/orchestrator/trace/artifacts.ts"),
    ).href;
    const script = `import { DurableArtifactRegistry } from ${JSON.stringify(moduleUrl)};
const registry = new DurableArtifactRegistry({ dir: ${JSON.stringify(registryDir)} });
registry.rotate();
console.log(registry.register("conversation", "artifact/ref"));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => runRuntimeScript(script)));
    expect(results.map(({ code }) => code)).toEqual([0, 0, 0, 0]);
    expect(results.map(({ stderr }) => stderr)).toEqual(["", "", "", ""]);
    expect(new Set(results.map(({ stdout }) => stdout)).size).toBe(1);
    expect(results[0]?.stdout).toBe(oldId);
    expect(existsSync(join(registryDir, ".opaque-key.lock"))).toBe(false);

    const restarted = new DurableArtifactRegistry({ dir: registryDir });
    restarted.rebuild([
      {
        stored_event: {
          ...correlation("conversation"),
          event_id: "00000000-0000-4000-8000-000000000001",
          seq: 1,
          ts: "2026-08-22T00:00:00.000Z",
          idempotency_key: "artifact",
          event: {
            type: "artifact_created",
            payload: { artifact_id: "plan", artifact_type: "plan", ref: "artifact/ref" },
          },
        },
        native_session_id: null,
      },
    ]);
    for (const id of [oldId, ...results.map(({ stdout }) => stdout)])
      expect(restarted.resolve("conversation", id)).toEqual({ internalRef: "artifact/ref" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository key fails closed for symlinks and unsafe modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-key-safety-"));
  const registryDir = join(root, "registry");
  try {
    new DurableArtifactRegistry({ dir: registryDir });
    const key = opaqueRegistryKeyPath(registryDir);
    chmodSync(key, 0o644);
    expect(() => new DurableArtifactRegistry({ dir: registryDir })).toThrow("unsafe opaque key");

    rmSync(key);
    const external = join(root, "external-key");
    writeFileSync(external, Buffer.alloc(32, 7), { mode: 0o600 });
    symlinkSync(external, key);
    expect(() => new DurableArtifactRegistry({ dir: registryDir })).toThrow("unsafe opaque key");

    const historyDir = join(root, "history-registry");
    const rotating = new DurableArtifactRegistry({ dir: historyDir });
    rotating.rotate();
    const history = join(historyDir, ".opaque-hmac-key-history.json");
    rmSync(history);
    symlinkSync(external, history);
    expect(() => new DurableArtifactRegistry({ dir: historyDir })).toThrow(
      "unsafe opaque key history",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live registries refresh rotated keys and resolve historical aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-live-rotation-"));
  const registryDir = join(root, "registry");
  try {
    const stale = new DurableArtifactRegistry({ dir: registryDir });
    const rotating = new DurableArtifactRegistry({ dir: registryDir });
    const conversationId = "conversation";
    const internalRef = "artifact/ref";
    stale.register(conversationId, internalRef);
    rotating.rotate();
    const activeKey = readFileSync(opaqueRegistryKeyPath(registryDir));
    const legacyAlias = `artifact_${createHmac("sha256", activeKey)
      .update("v7-public-opaque\0", "utf8")
      .update("artifact", "utf8")
      .update("\0", "utf8")
      .update(String(Buffer.byteLength(conversationId, "utf8")), "utf8")
      .update("\0", "utf8")
      .update(conversationId, "utf8")
      .update("\0", "utf8")
      .update(internalRef, "utf8")
      .digest("base64url")}`;
    expect(stale.resolve(conversationId, legacyAlias)).toEqual({ internalRef });
    expect(stale.register(conversationId, internalRef)).toBe(
      rotating.register(conversationId, internalRef),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects a user-owned symlink in any supplied path component", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-component-symlink-"));
  try {
    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(actual, alias);
    expect(() => new DurableArtifactRegistry({ dir: join(alias, "registry") })).toThrow(
      "symlink path component",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects every non-trusted symlink component regardless of observed owner", async () => {
  if (typeof process.geteuid !== "function") return;
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-other-owner-symlink-"));
  const getuid = spyOn(process, "geteuid").mockReturnValue(process.geteuid() + 1);
  try {
    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(actual, alias);
    expect(() => new DurableArtifactRegistry({ dir: join(alias, "registry") })).toThrow(
      "symlink path component",
    );
  } finally {
    getuid.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("rotation history and registry cardinality stay globally bounded without losing issued IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-bounds-"));
  const registryDir = join(root, "registry");
  try {
    const registry = new DurableArtifactRegistry({
      dir: registryDir,
      limits: {
        maxConversations: 2,
        maxReferencesPerConversation: 2,
        maxTotalReferences: 3,
        maxRetiredKeys: 2,
        maxAssignments: 8,
      },
    });
    const issued = registry.register("conversation-a", "artifact/a");
    registry.register("conversation-a", "artifact/b");
    registry.register("conversation-b", "artifact/c");
    expect(() => registry.register("conversation-c", "artifact/d")).toThrow(
      "conversation limit reached",
    );
    expect(() => registry.register("conversation-b", "artifact/d")).toThrow(
      "total reference limit reached",
    );
    for (let index = 0; index < 6; index++) registry.rotate();
    expect(registry.register("conversation-a", "artifact/a")).toBe(issued);
    expect(registry.resolve("conversation-a", issued)).toEqual({ internalRef: "artifact/a" });
    const history = JSON.parse(
      readFileSync(join(registryDir, ".opaque-hmac-key-history.json"), "utf8"),
    );
    expect(history).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation-scoped rebuild clears an empty or truncated conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-empty-rebuild-"));
  try {
    const registry = new DurableArtifactRegistry({ dir: join(root, "registry") });
    const opaque = registry.register("conversation", "artifact/private");
    expect(registry.resolve("conversation", opaque)).toEqual({
      internalRef: "artifact/private",
    });
    registry.rebuildConversation("conversation", []);
    expect(registry.resolve("conversation", opaque)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial key creation recovers safe zero-byte residue and rejects truncated residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-key-residue-"));
  try {
    const recoverable = join(root, "recoverable");
    mkdirSync(recoverable, { mode: 0o700 });
    writeFileSync(opaqueRegistryKeyPath(recoverable), Buffer.alloc(0), { mode: 0o600 });
    expect(() => new DurableArtifactRegistry({ dir: recoverable })).not.toThrow();
    expect(lstatSync(opaqueRegistryKeyPath(recoverable)).size).toBe(32);

    const rejected = join(root, "rejected");
    mkdirSync(rejected, { mode: 0o700 });
    writeFileSync(opaqueRegistryKeyPath(rejected), Buffer.alloc(7), { mode: 0o600 });
    expect(() => new DurableArtifactRegistry({ dir: rejected })).toThrow("unsafe opaque key");

    const publicResidue = join(root, "public-residue");
    mkdirSync(publicResidue, { mode: 0o700 });
    writeFileSync(opaqueRegistryKeyPath(publicResidue), Buffer.alloc(0), { mode: 0o644 });
    expect(() => new DurableArtifactRegistry({ dir: publicResidue })).toThrow("unsafe opaque key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry and trace roots reject an unexpected effective owner", async () => {
  if (typeof process.geteuid !== "function") return;
  const root = await mkdtemp(join(tmpdir(), "trace-owner-safety-"));
  const registryDir = join(root, "registry");
  const traceDir = join(root, "trace");
  try {
    new DurableArtifactRegistry({ dir: registryDir });
    new TraceStore({ dir: traceDir });
    const getuid = spyOn(process, "geteuid").mockReturnValue(process.geteuid() + 1);
    try {
      expect(() => new DurableArtifactRegistry({ dir: registryDir })).toThrow("unsafe directory");
      expect(() => new TraceStore({ dir: traceDir })).toThrow("unsafe directory");
    } finally {
      getuid.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initial key write never leaves an unusable final key", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-key-atomic-"));
  const registryDir = join(root, "registry");
  const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
    throw new Error("simulated initial-key crash");
  });
  try {
    expect(() => new DurableArtifactRegistry({ dir: registryDir })).toThrow(
      "simulated initial-key crash",
    );
  } finally {
    writeSpy.mockRestore();
  }
  try {
    expect(() => new DurableArtifactRegistry({ dir: registryDir })).not.toThrow();
    expect(lstatSync(opaqueRegistryKeyPath(registryDir)).size).toBe(32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable multi-reference projection reserves atomically and commits only on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-artifact-projection-atomic-"));
  const event = {
    type: "artifact_updated",
    payload: {
      artifact_id: "plan",
      artifact_type: "plan",
      ref: "artifact/private-first",
      previous_ref: "artifact/private-second",
    },
  } as const;
  try {
    const failedDir = join(root, "failed");
    const failed = new DurableArtifactRegistry({
      dir: failedDir,
      limits: {
        maxConversations: 2,
        maxReferencesPerConversation: 10,
        maxTotalReferences: 10,
        maxRetiredKeys: 1,
        maxAssignments: 1,
      },
    });
    const firstId = deriveOpaque(
      readFileSync(opaqueRegistryKeyPath(failedDir)),
      "artifact",
      "conversation",
      event.payload.ref,
    );
    expect(() =>
      projectPublicTrace(event, {
        conversationId: "conversation",
        artifactRegistry: failed,
      }),
    ).toThrow("assignment limit reached");
    expect(readFileSync(join(failedDir, ".opaque-hmac-assignments.jsonl"), "utf8")).toBe("");
    expect(failed.resolve("conversation", firstId)).toBeNull();
    expect(() => failed.register("conversation", "artifact/still-has-capacity")).not.toThrow();

    const success = new DurableArtifactRegistry({
      dir: join(root, "success"),
      limits: {
        maxConversations: 2,
        maxReferencesPerConversation: 10,
        maxTotalReferences: 10,
        maxRetiredKeys: 1,
        maxAssignments: 2,
      },
    });
    const projected = projectPublicTrace(event, {
      conversationId: "conversation",
      artifactRegistry: success,
    });
    if (!projected.payload.ref || !projected.payload.previous_ref)
      throw new Error("missing projected references");
    expect(success.resolve("conversation", projected.payload.ref)).toEqual({
      internalRef: event.payload.ref,
    });
    expect(success.resolve("conversation", projected.payload.previous_ref)).toEqual({
      internalRef: event.payload.previous_ref,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

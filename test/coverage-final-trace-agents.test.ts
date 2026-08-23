import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  type AgentBinding,
  materializeWorkflowAgentBinding,
  previewAgentBinding,
} from "../src/agents/binding.js";
import {
  assertRoleDirectorySnapshot,
  assertStableRoleReadSnapshot,
  resolveRoleOverlay,
} from "../src/agents/role-overlay.js";
import type { RoleContext } from "../src/agents/role-templates.js";
import type { Skill } from "../src/core.js";
import {
  createDockerRuntimeInspector,
  createIsolationLease,
  releaseIsolationLease,
} from "../src/dispatch/isolation.js";
import type { ArtifactProjectionInput } from "../src/orchestrator/trace/artifacts.js";
import {
  type JournalCursor,
  appendCursor,
  auditJournal,
} from "../src/orchestrator/trace/journal-cursor.js";
import {
  openOpaqueKeyring,
  refreshOpaqueKeyring,
} from "../src/orchestrator/trace/opaque-keyring.js";
import {
  assertNoSymlinkPathComponents,
  ensurePrivateDirectory,
  syncPrivateDirectory,
} from "../src/orchestrator/trace/path-safety.js";
import {
  projectPublicStoredTrace,
  projectPublicTrace,
  projectReservedSessionRef,
} from "../src/orchestrator/trace/project.js";
import type {
  InternalTraceStoreRecord,
  OpaqueArtifactId,
  OpaqueSessionRef,
  TraceEvent,
} from "../src/orchestrator/trace/types.js";
import type { SkillDiscoveryRoots } from "../src/skills/discovery.js";
import {
  materializeDispatchSkills,
  materializeResolvedSkill,
} from "../src/skills/dispatch-resolution.js";

const temporaryRoots: string[] = [];
const originalSkillsHome = process.env.VF_SKILLS_HOME;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalSkillsHome === undefined) Reflect.deleteProperty(process.env, "VF_SKILLS_HOME");
  else process.env.VF_SKILLS_HOME = originalSkillsHome;
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function repo(prefix = "vf-final-agents-"): string {
  const root = temporary(prefix);
  mkdirSync(join(root, ".vibeflow", "roles"), { recursive: true });
  process.env.VF_SKILLS_HOME = join(root, "isolated-home");
  return root;
}

const workflowBinding = (overrides: Partial<AgentBinding> = {}): AgentBinding => ({
  roleRef: "dispatch-runner",
  engine: "claude",
  sessionMode: "fresh",
  additionalSkillRefs: [],
  ...overrides,
});

describe("final agent binding rejection coverage", () => {
  test("rejects blank, overlong, and control-bearing model overrides", () => {
    const root = repo();
    const options = { repoRoot: root, phase: 2, taskText: "workflow" };
    expect(() =>
      materializeWorkflowAgentBinding(workflowBinding({ modelOverride: " " }), options),
    ).toThrow("model override must be a non-empty identifier");
    expect(() =>
      materializeWorkflowAgentBinding(workflowBinding({ modelOverride: "x".repeat(201) }), options),
    ).toThrow("model override must be a non-empty identifier");
    expect(() =>
      materializeWorkflowAgentBinding(
        workflowBinding({ modelOverride: "model\u0007name" }),
        options,
      ),
    ).toThrow("model override contains a control character");
  });

  test("rejects invalid conversation and workflow phases", () => {
    const root = repo();
    expect(() =>
      previewAgentBinding(
        { roleRef: "direct", engine: "claude", sessionMode: "fresh" },
        { repoRoot: root, phase: 0, taskText: "preview" },
      ),
    ).toThrow("conversation phase must be a positive integer");
    expect(() =>
      materializeWorkflowAgentBinding(workflowBinding(), {
        repoRoot: root,
        phase: 0,
        taskText: "workflow",
      }),
    ).toThrow("workflow phase must be a positive integer");
  });

  test("rejects workflow isolation associated with a different repository", async () => {
    const root = repo();
    const associated = repo("vf-final-associated-");
    const containerId = "coverage-final-container";
    const inspector = createDockerRuntimeInspector({
      run: () => ({
        Id: containerId,
        State: { Running: true },
        Mounts: [{ Source: associated, Destination: "/workspace" }],
      }),
    });
    const isolation = createIsolationLease({
      kind: "container",
      root: "/workspace",
      cwd: "/workspace",
      repoRoot: associated,
      evidence_ref: "coverage-final-isolation",
      containerId,
      runtimeInspector: inspector,
    });
    try {
      expect(() =>
        materializeWorkflowAgentBinding(workflowBinding(), {
          repoRoot: root,
          phase: 2,
          taskText: "workflow",
          isolation,
        }),
      ).toThrow("isolation lacks the associated canonical repository");
    } finally {
      await releaseIsolationLease(isolation);
    }
  });
});

function writeRole(root: string, ref: string, fields: string[], body = "# Role\n\nPrompt."): void {
  writeFileSync(
    join(root, ".vibeflow", "roles", `${ref}.md`),
    ["---", `name: ${ref}`, ...fields, "---", "", body].join("\n"),
  );
}

describe("final role overlay rejection coverage", () => {
  const snapshot = (overrides: Record<string, unknown> = {}) =>
    ({
      dev: 1n,
      ino: 1n,
      nlink: 1n,
      size: 1n,
      mtimeNs: 1n,
      ctimeNs: 1n,
      isDirectory: () => true,
      isFile: () => true,
      isSymbolicLink: () => false,
      ...overrides,
    }) as never;

  test("rejects unsafe and changed role snapshots through pure validation seams", () => {
    expect(() =>
      assertRoleDirectorySnapshot(snapshot(), snapshot({ isSymbolicLink: () => true })),
    ).toThrow("unsafe role directory");
    const stable = snapshot();
    expect(() =>
      assertStableRoleReadSnapshot({
        fileBefore: stable,
        fileAfter: stable,
        finalFileEntry: snapshot({ ino: 2n }),
        directoryBefore: stable,
        directoryAfter: stable,
        finalDirectoryEntry: stable,
      }),
    ).toThrow("role path changed during read");
  });

  test("rejects every remaining malformed frontmatter surface", () => {
    const cases: Array<[string, string[], string]> = [
      [
        "unknown-field",
        ["description: Role", "tools: [read]", "model: sonnet", "extra: x"],
        "unknown field",
      ],
      ["invalid-tools", ["description: Role", "tools: []", "model: sonnet"], "invalid tools"],
      [
        "wrong-name",
        ["name: other", "description: Role", "tools: [read]", "model: sonnet"],
        "name must match",
      ],
      [
        "invalid-description",
        ["description: 7", "tools: [read]", "model: sonnet"],
        "invalid description",
      ],
      ["invalid-extends", ["extends: Bad Ref"], "invalid extends"],
    ];
    for (const [ref, fields, message] of cases) {
      const root = repo(`vf-final-role-${ref}-`);
      writeRole(root, ref, fields);
      expect(() => resolveRoleOverlay(ref, { repoRoot: root })).toThrow(message);
    }
  });

  test("wraps unexpected built-in rendering failures as malformed role errors", () => {
    const root = repo();
    const context = {
      get projectName(): string {
        throw new Error("context exploded");
      },
      hasWeb: true,
    } as RoleContext;
    expect(() => resolveRoleOverlay("direct", { repoRoot: root, context })).toThrow(
      'malformed repo role "direct": context exploded',
    );
  });
});

function skillRoots(root: string): SkillDiscoveryRoots {
  return { repo: [join(root, ".vibeflow", "skills")], shared: [], builtin: [] };
}

function writeSkill(
  root: string,
  name: string,
  fields: string[] = [],
  body = `# ${name}\n\nBody.`,
): Skill {
  const dir = join(root, ".vibeflow", "skills", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    ["---", `name: ${name}`, `description: ${name}`, ...fields, "---", "", body].join("\n"),
  );
  return { name, description: name, status: "verified", dir, path };
}

describe("final dispatch skill rejection coverage", () => {
  test("rejects non-entry and missing canonical discovery paths", () => {
    const root = repo();
    const roots = skillRoots(root);
    const nonEntryPath = join(roots.repo[0] as string, "SKILL.md");
    mkdirSync(roots.repo[0] as string, { recursive: true });
    writeFileSync(nonEntryPath, "---\nname: bad\ndescription: bad\n---\n\nBody");
    const nonEntry: Skill = {
      name: "bad",
      description: "bad",
      status: "verified",
      dir: roots.repo[0] as string,
      path: nonEntryPath,
    };
    expect(() => materializeResolvedSkill(nonEntry, [nonEntry], { repoRoot: root, roots })).toThrow(
      "skill path is not a canonical discovery entry",
    );
    expect(() =>
      materializeDispatchSkills(
        [{ name: "bad", description: "bad", status: "verified", dir: "", path: "" }],
        "",
        { repoRoot: root, roots },
      ),
    ).toThrow("invalid discovery path");
  });

  test("revalidates a discovery path at the snapshot boundary", () => {
    const root = repo();
    const roots = skillRoots(root);
    const canonical = writeSkill(root, "volatile");
    let reads = 0;
    const volatile = new Proxy(canonical, {
      get(target, property, receiver) {
        if (property === "path") return ++reads <= 3 ? target.path : "";
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => materializeDispatchSkills([volatile], "", { repoRoot: root, roots })).toThrow(
      "invalid discovery path",
    );
  });

  test("rejects additional refs with a version absent from the installed skill", () => {
    const root = repo();
    const roots = skillRoots(root);
    const installed = writeSkill(root, "installed");
    expect(() =>
      materializeDispatchSkills([installed], "", {
        repoRoot: root,
        roots,
        additionalSkillRefs: ["installed@9.9.9"],
      }),
    ).toThrow("requires version 9.9.9, installed none");
  });

  test("rejects an effective inherited body over the materialization cap", () => {
    const root = repo();
    const roots = skillRoots(root);
    const base = writeSkill(root, "large-base", [], `# Base\n\n${"a".repeat(600_000)}`);
    const top = writeSkill(
      root,
      "large-top",
      ["extends: [large-base]"],
      `# Top\n\n${"b".repeat(600_000)}`,
    );
    expect(() => materializeResolvedSkill(top, [base, top], { repoRoot: root, roots })).toThrow(
      "effective body exceeds 1 MiB",
    );
  });
});

const storedRecord = (): InternalTraceStoreRecord => ({
  stored_event: {
    workflow_id: "workflow",
    conversation_id: "conversation",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "attempt",
    event_id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    ts: "2026-08-22T00:00:00.000Z",
    idempotency_key: "idempotency",
    event: { type: "user_message", payload: { content: "safe", target_participants: "all" } },
  },
  native_session_id: "native-session",
});

describe("final public projection rollback coverage", () => {
  test("fails closed when the collected session reservation invariant is absent", () => {
    expect(() => projectReservedSessionRef("native-session", undefined)).toThrow(
      "session projection reservation required",
    );
  });

  test("revalidates a reference-array item mutated by registry authority", () => {
    const evidence: unknown[] = ["private/evidence"];
    const event = {
      type: "artifact_created",
      payload: {
        artifact_id: "plan",
        artifact_type: "plan",
        ref: "private/plan",
        evidence_refs: evidence,
      },
    } as unknown as TraceEvent;
    const registry = {
      register: () => "artifact_unused" as OpaqueArtifactId,
      resolve: () => null,
      prepareProjection: (inputs: readonly ArtifactProjectionInput[]) => {
        evidence[0] = 42;
        return {
          ids: inputs.map(
            (_, index) => `artifact_${String(index).padStart(43, "c")}` as OpaqueArtifactId,
          ),
          commit() {},
          rollback() {},
        };
      },
    };
    const output = projectPublicTrace(event, {
      conversationId: "conversation",
      artifactRegistry: registry,
    });
    expect((output.payload as unknown as { evidence_refs: unknown[] }).evidence_refs).toEqual([42]);
  });

  test("rolls back a trace reservation when commit fails", () => {
    let rollbacks = 0;
    const registry = {
      register: () => "artifact_unused" as OpaqueArtifactId,
      resolve: () => null,
      prepareProjection: (inputs: readonly ArtifactProjectionInput[]) => ({
        ids: inputs.map((input, index) =>
          input.kind === "artifact"
            ? (`artifact_${String(index).padStart(43, "a")}` as OpaqueArtifactId)
            : (`session_${String(index).padStart(43, "a")}` as OpaqueSessionRef),
        ),
        commit() {
          throw new Error("commit failed");
        },
        rollback() {
          rollbacks += 1;
        },
      }),
    };
    const event = {
      type: "artifact_created",
      payload: { artifact_id: "plan", artifact_type: "plan", ref: "private/plan" },
    } as const;
    expect(() =>
      projectPublicTrace(event, { conversationId: "conversation", artifactRegistry: registry }),
    ).toThrow("commit failed");
    expect(rollbacks).toBe(1);
  });

  test("rolls back a stored projection reservation when commit fails", () => {
    let rollbacks = 0;
    const registry = {
      register: () => "artifact_unused" as OpaqueArtifactId,
      resolve: () => null,
      prepareProjection: (inputs: readonly ArtifactProjectionInput[]) => ({
        ids: inputs.map((input, index) =>
          input.kind === "artifact"
            ? (`artifact_${String(index).padStart(43, "b")}` as OpaqueArtifactId)
            : (`session_${String(index).padStart(43, "b")}` as OpaqueSessionRef),
        ),
        commit() {
          throw new Error("stored commit failed");
        },
        rollback() {
          rollbacks += 1;
        },
      }),
    };
    expect(() =>
      projectPublicStoredTrace(storedRecord(), {
        conversationId: "conversation",
        artifactRegistry: registry,
      }),
    ).toThrow("stored commit failed");
    expect(rollbacks).toBe(1);
  });
});

describe("final opaque keyring recovery coverage", () => {
  test("truncates a partial assignment then rejects malformed framed JSON", () => {
    const root = temporary("vf-final-opaque-");
    let keyring = openOpaqueKeyring(root);
    const assignments = join(root, ".opaque-hmac-assignments.jsonl");
    writeFileSync(assignments, '{"lookup":"partial"', { mode: 0o600 });
    keyring = refreshOpaqueKeyring(keyring);
    expect(statSync(assignments).size).toBe(0);
    writeFileSync(assignments, "not-json\n", { mode: 0o600 });
    expect(() => refreshOpaqueKeyring(keyring)).toThrow("unsafe opaque assignments");
  });

  test("retries a busy opaque lock and fails closed for other lock errors", () => {
    const retryRoot = temporary("vf-final-lock-retry-");
    mkdirSync(retryRoot, { recursive: true, mode: 0o700 });
    chmodSync(retryRoot, 0o700);
    const original = lockfile.lockSync.bind(lockfile);
    let calls = 0;
    const retry = spyOn(lockfile, "lockSync").mockImplementation(((
      path: string,
      options: object,
    ) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "ELOCKED" });
      return original(path, options);
    }) as typeof lockfile.lockSync);
    try {
      expect(() => openOpaqueKeyring(retryRoot)).not.toThrow();
      expect(calls).toBe(2);
    } finally {
      retry.mockRestore();
    }

    const failedRoot = temporary("vf-final-lock-failed-");
    mkdirSync(failedRoot, { recursive: true, mode: 0o700 });
    chmodSync(failedRoot, 0o700);
    const failed = spyOn(lockfile, "lockSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      expect(() => openOpaqueKeyring(failedRoot)).toThrow("opaque key lock failed");
    } finally {
      failed.mockRestore();
    }
  });
});

describe("final journal cursor rejection coverage", () => {
  test("rejects an incomplete durable batch when recovery is disabled", () => {
    const root = temporary("vf-final-journal-");
    const path = join(root, "journal.jsonl");
    const record = {
      ...storedRecord(),
      native_session_id: null,
      batch_id: "00000000-0000-4000-8000-000000000001",
      batch_index: 0,
      batch_size: 2,
    } satisfies InternalTraceStoreRecord;
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    const fd = openSync(path, "r+");
    try {
      expect(() => auditJournal(fd, false, "conversation")).toThrow("incomplete batch");
    } finally {
      closeSync(fd);
    }
  });

  test("returns false when cursor refresh cannot stat its descriptor", () => {
    const record = storedRecord();
    const cursor = {
      records: [],
      eventIds: new Set(),
      idempotency: new Map(),
      dev: 0,
      ino: 0,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      tail: Buffer.alloc(0),
      lastByte: null,
    } satisfies JournalCursor;
    expect(appendCursor(-1, cursor, record, Buffer.from("record\n"))).toBe(false);
  });
});

const rejectUnsafe = (message: string): never => {
  throw new Error(message);
};

describe("final path safety rejection coverage", () => {
  test("canonicalizes an exact root-owned trusted OS alias target", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
      writable: true,
    });
    const lstat = spyOn(fs, "lstatSync").mockImplementation(
      (() =>
        ({
          isSymbolicLink: () => true,
          uid: 0,
        }) as unknown as fs.Stats) as unknown as typeof fs.lstatSync,
    );
    const realpath = spyOn(fs, "realpathSync").mockImplementation(
      (() => "/private/tmp") as unknown as typeof fs.realpathSync,
    );
    try {
      expect(assertNoSymlinkPathComponents("/tmp", rejectUnsafe)).toBe("/private/tmp");
    } finally {
      realpath.mockRestore();
      lstat.mockRestore();
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
        writable: true,
      });
    }
  });

  test("fails closed when inspection of a trusted OS alias itself fails", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
      writable: true,
    });
    const original = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    let tmpReads = 0;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      path: fs.PathLike,
      ...args: unknown[]
    ) => {
      if (resolve(String(path)) === "/tmp") {
        tmpReads += 1;
        if (tmpReads === 1) return { isSymbolicLink: () => true, uid: 0 } as unknown as fs.Stats;
        throw new Error("alias inspection failed");
      }
      return original(path, ...(args as [never]));
    }) as typeof fs.lstatSync);
    try {
      expect(() => assertNoSymlinkPathComponents("/tmp/final", rejectUnsafe)).toThrow(
        "symlink path component",
      );
    } finally {
      lstat.mockRestore();
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
        writable: true,
      });
    }
  });

  test("maps private-directory creation and opening failures to stable errors", () => {
    const root = temporary("vf-final-private-dir-");
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("mkdir failed");
    });
    try {
      expect(() => ensurePrivateDirectory(root, rejectUnsafe)).toThrow("unsafe directory");
    } finally {
      mkdir.mockRestore();
    }

    const open = spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("open failed");
    });
    try {
      expect(() => ensurePrivateDirectory(root, rejectUnsafe)).toThrow("unsafe directory");
    } finally {
      open.mockRestore();
    }
  });

  test("maps private-directory sync opening failures to a stable error", () => {
    const root = temporary("vf-final-private-sync-");
    chmodSync(root, 0o700);
    const open = spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("open failed");
    });
    try {
      expect(() => syncPrivateDirectory(root, rejectUnsafe)).toThrow("unsafe registry directory");
    } finally {
      open.mockRestore();
    }
  });
});

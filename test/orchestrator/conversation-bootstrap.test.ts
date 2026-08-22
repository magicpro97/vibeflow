import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  MaterializeAgentBindingOptions,
  MaterializedAgentBinding,
} from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { releaseIsolationLease } from "../../src/dispatch/isolation.js";
import {
  type EngineProcess,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import {
  bindWithIsolation,
  createConversationIsolationAuthority,
  defaultConversationIsolationAuthority,
  withAttemptIsolation,
} from "../../src/orchestrator/conversation/bootstrap-isolation.js";
import {
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../../src/orchestrator/conversation/bootstrap.js";
import { VERIFY_GATE_ORDER, type VerifyGateManifest } from "../../src/verify/core.js";

const passingVerify = (): VerifyGateManifest =>
  Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [`test:${name}`] },
    ]),
  ) as VerifyGateManifest;

function completedCodexProcess(): EngineProcess {
  const output = new TextEncoder().encode(
    `${JSON.stringify({
      type: "thread.started",
      thread_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19",
    })}\n`,
  );
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(output);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function projectBinding(options: MaterializeAgentBindingOptions): MaterializedAgentBinding {
  if (!options.isolation) throw new Error("test binder requires canonical isolation");
  const roleHash = "a".repeat(64);
  const skillHash = "b".repeat(64);
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [skillHash] };
  const traceMetadata = {
    role_resolved_hash: roleHash,
    skill_resolved_hashes: [skillHash],
  };
  const envPolicy = conversationEnvPolicy("codex");
  const resolved = {
    role: {
      spec: {
        name: "direct",
        description: "direct",
        body: "answer directly",
        tools: ["read" as const],
        model: "sonnet" as const,
        sandbox: "read-only" as const,
      },
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
    },
    skills: [{ ref: "repo-law", source: "repo" as const, version: null, resolved_hash: skillHash }],
    engine: "codex" as const,
    model: "gpt-5.4",
    sessionMode: "fresh" as const,
    tool_intents: ["read" as const],
    sandbox: "read-only" as const,
    env_policy: envPolicy,
    isolation: options.isolation,
    provenance,
    trace_metadata: traceMetadata,
  };
  return {
    resolved,
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: "answer directly",
      rendered_tools: [],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: options.isolation,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

const libraries = {
  plan: {
    create: async () => ({ content: "unused" }),
    update: async ({ revision }: { revision: { content: string } }) => ({
      content: revision.content,
    }),
  },
  review: {
    currentHead: async () => "a".repeat(40),
    review: async () => ({
      reviewed_head: "a".repeat(40),
      reviewer: "human:test",
      outcome: "approved" as const,
      evidence_refs: ["review.json"],
    }),
  },
  verify: { run: async () => passingVerify() },
  orchestrate: {
    dryRun: async () => ({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: true,
    }),
    execute: async () => ({ units: [], reviews: [] }),
  },
};

async function repoWithAlwaysOnSkill(root: string): Promise<string> {
  const repo = join(root, "repo");
  const skill = join(repo, ".agents", "skills", "repo-law");
  await mkdir(skill, { recursive: true });
  await writeFile(join(repo, "package.json"), '{"name":"bootstrap-isolation"}\n');
  await writeFile(
    join(skill, "SKILL.md"),
    [
      "---",
      "name: repo-law",
      "description: Always-on repository law",
      "status: verified",
      "type: repo",
      "---",
      "",
      "Keep conversation execution isolated.",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "VibeFlow Test"]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  return repo;
}

test("default Phase 3 preview isolates always-on repo skills without retaining a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-bootstrap-isolation-"));
  try {
    const repo = await repoWithAlwaysOnSkill(root);
    const worktreesBefore = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const bootstrap = createConversationBootstrap({
      repoRoot: repo,
      stateDir: join(root, "state"),
      phase: 3,
      readiness: () => [{ engine: "codex", ready: true, admitted: true }],
      libraries,
    });

    await expect(
      bootstrap.service.dryRun({
        topic: "hello",
        policy: "direct",
        participants: [{ role_ref: "direct", engine: "codex" }],
      }),
    ).resolves.toMatchObject({
      participants: [{ role_ref: "direct", engine: "codex" }],
      models_valid: true,
    });
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 3 start refreshes the consumed binding lease for the process and cleans both", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-bootstrap-start-isolation-"));
  try {
    const repo = await repoWithAlwaysOnSkill(root);
    const worktreesBefore = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const processCwds: Array<string | undefined> = [];
    let failSpawn = false;
    let nextId = 0;
    const bindingFactory = {
      materialize: (_binding, options) => projectBinding(options),
      preview: () => {
        throw new Error("start test must not preview");
      },
    } as ConversationBootstrapOptions["bindingFactory"];
    const bootstrap = createConversationBootstrap({
      repoRoot: repo,
      stateDir: join(root, "state"),
      phase: 3,
      readiness: () => [{ engine: "codex", ready: true, admitted: true }],
      bindingFactory,
      isolationAuthority: defaultConversationIsolationAuthority,
      session: {
        sourceEnv: { PATH: process.env.PATH ?? "/usr/bin" },
        spawn: (_argv, options) => {
          processCwds.push(options.cwd);
          if (failSpawn) throw new Error("injected process start failure");
          return completedCodexProcess();
        },
      },
      id: (kind) => `${kind}-${++nextId}`,
      schedule: (task) => task(),
      libraries,
    });

    await expect(
      bootstrap.service.create({
        topic: "hello",
        policy: "direct",
        participants: [{ role_ref: "direct", engine: "codex" }],
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    expect(processCwds).toHaveLength(1);
    expect(processCwds[0]).toContain("vf-conversation-isolation-");
    expect(processCwds[0]).not.toBe(repo);
    failSpawn = true;
    await expect(
      bootstrap.service.create({
        topic: "fail safely",
        policy: "direct",
        participants: [{ role_ref: "direct", engine: "codex" }],
      }),
    ).resolves.toMatchObject({ result: { status: "failed" } });
    expect(processCwds).toHaveLength(2);
    expect(processCwds[1]).not.toBe(processCwds[0]);
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolation cleanup removes the temp tree and prunes metadata even when git remove fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-bootstrap-cleanup-isolation-"));
  try {
    const repo = await repoWithAlwaysOnSkill(root);
    const worktreesBefore = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const authority = createConversationIsolationAuthority({
      runGit: (repoRoot, args, timeout) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          throw new Error("injected remove failure");
        }
        execFileSync("git", ["-C", repoRoot, ...args], { timeout, stdio: "ignore" });
      },
    });
    const lease = authority.acquire(repo);
    const parent = dirname(lease.cwd);

    await expect(releaseIsolationLease(lease)).rejects.toThrow(
      "conversation isolation cleanup failed",
    );
    expect(existsSync(parent)).toBe(false);
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);

    const failingTreeRemoval = createConversationIsolationAuthority({
      removeTree: (path) => {
        rmSync(path, { recursive: true, force: true });
        throw new Error("injected temp tree removal failure");
      },
    });
    const secondLease = failingTreeRemoval.acquire(repo);
    const secondParent = dirname(secondLease.cwd);
    await expect(releaseIsolationLease(secondLease)).rejects.toThrow(
      "conversation isolation cleanup failed",
    );
    expect(existsSync(secondParent)).toBe(false);
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);

    const failingPrune = createConversationIsolationAuthority({
      runGit: (repoRoot, args, timeout) => {
        if (args[0] === "worktree" && args[1] === "prune") {
          throw new Error("injected prune failure");
        }
        execFileSync("git", ["-C", repoRoot, ...args], { timeout, stdio: "ignore" });
      },
    });
    const thirdLease = failingPrune.acquire(repo);
    const thirdParent = dirname(thirdLease.cwd);
    await expect(releaseIsolationLease(thirdLease)).rejects.toThrow(
      "conversation isolation cleanup failed",
    );
    expect(existsSync(thirdParent)).toBe(false);
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolation acquisition failures clean partial authority and stay path-opaque", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-bootstrap-acquire-isolation-"));
  try {
    const repo = await repoWithAlwaysOnSkill(root);
    const worktreesBefore = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const partial = createConversationIsolationAuthority({
      createLease: () => {
        throw new Error(`private lease failure: ${root}`);
      },
    });
    expect(() => partial.acquire(repo)).toThrow("conversation isolation authority is unavailable");
    expect(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe(worktreesBefore);

    const absent = createConversationIsolationAuthority({
      removeTree: (path) => {
        rmSync(path, { recursive: true, force: true });
        throw new Error("injected temp cleanup failure");
      },
    });
    expect(() => absent.acquire(join(root, "not-a-repository"))).toThrow(
      "conversation isolation authority is unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 1 binding and history preview do not mint process isolation", async () => {
  let acquired = 0;
  const options = await bindWithIsolation(
    {
      acquire: () => {
        acquired += 1;
        throw new Error("Phase 1 minted isolation");
      },
    },
    process.cwd(),
    1,
    "preview",
    (bindingOptions) => bindingOptions,
  );
  expect(acquired).toBe(0);
  expect(options.isolation).toBeUndefined();

  const expected = {
    status: "unavailable" as const,
    imported_turn_count: 0,
    imported_tool_count: 0,
    completeness_reason: "test history unavailable",
  };
  const adapter = withAttemptIsolation(
    {
      start: () => {
        throw new Error("history preview started a process");
      },
      reconcileHistory: async () => expected,
    },
    defaultConversationIsolationAuthority,
    process.cwd(),
  );
  await expect(
    adapter.reconcileHistory({ engine: "copilot", nativeSessionId: "history-test" }),
  ).resolves.toEqual(expected);
});

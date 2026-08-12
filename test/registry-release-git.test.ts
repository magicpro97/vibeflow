import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type ReleaseSnapshot,
  type WorktreeOperation,
  approveProposal,
} from "../src/skills/registry-release-executor.js";
import {
  type GitReleaseRun,
  approveStoredRelease,
  createRegistryReleaseGitAdapter,
} from "../src/skills/registry-release-git.js";
import { buildReleasePlans } from "../src/skills/registry-release.js";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const COMMIT = "c".repeat(40);
const BRANCH = "chore/update-skill-demo-skill-1.2.3";
const ROOT = "/tmp/vf-registry-release-1";
const CWD = join(ROOT, "repo");
const LOCK = join(CWD, ".vibeflow", "SKILL_REGISTRY.lock.json");

function snapshot(): ReleaseSnapshot {
  const identity = { registry: "reg-a", fromOid: FROM, toOid: TO, version: "1.2.3" };
  const target = { repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] };
  const plans = buildReleasePlans([target], identity, "demo-skill").map((plan) => ({
    ...plan,
    status: "pending" as const,
  }));
  return {
    schemaVersion: 1,
    id: plans[0]?.proposalId ?? "",
    identity,
    changelog: "Ready for consumers",
    state: "pending",
    plans,
  };
}

function harness(
  options: {
    verifyStatus?: number;
    activeUser?: string;
    repository?: string;
    branch?: string;
    cloneStatus?: number;
    createStatus?: number;
    createStdout?: string;
    viewStatus?: number;
    viewStdout?: string;
    metadataStdout?: string;
    lockReadThrows?: boolean;
  } = {},
) {
  const {
    verifyStatus = 0,
    activeUser = "release-bot\n",
    repository = "owner/repo",
    branch = "main",
    cloneStatus = 0,
    createStatus = 0,
    createStdout = "https://github.com/owner/repo/pull/7\n",
    viewStatus = 0,
    viewStdout = '{"state":"OPEN","url":"https://github.com/owner/repo/pull/7"}',
    metadataStdout,
    lockReadThrows = false,
  } = options;
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const files = new Map([
    [
      LOCK,
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "reg-a",
            url: "https://github.com/acme/skills.git",
            ref: "main",
            commitOID: FROM,
          },
          {
            name: "reg-b",
            url: "https://github.com/acme/other.git",
            ref: "stable",
            commitOID: "d".repeat(40),
          },
        ],
      }),
    ],
  ]);
  const removed: string[] = [];
  const run = ((command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    if (command === "gh" && args[0] === "api" && args[1] === "user")
      return { status: 0, stdout: activeUser, stderr: "" };
    if (command === "gh" && args[0] === "api" && args[1] === "repos/owner/repo")
      return {
        status: 0,
        stdout: metadataStdout ?? JSON.stringify({ full_name: repository, default_branch: branch }),
        stderr: "",
      };
    if (command === "gh" && args[0] === "pr" && args[1] === "list")
      return { status: 0, stdout: "\n", stderr: "" };
    if (command === "git" && args[0] === "diff")
      return { status: 0, stdout: ".vibeflow/SKILL_REGISTRY.lock.json\n", stderr: "" };
    if (command === "git" && args[0] === "clone")
      return { status: cloneStatus, stdout: "", stderr: "clone failed" };
    if (command === "vf")
      return {
        status: verifyStatus,
        stdout: verifyStatus ? "failed" : "confidence: 1.0",
        stderr: "",
      };
    if (command === "git" && args[0] === "rev-parse")
      return { status: 0, stdout: `${COMMIT}\n`, stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "create")
      return { status: createStatus, stdout: createStdout, stderr: "create failed" };
    if (command === "gh" && args[0] === "pr" && args[1] === "view")
      return { status: viewStatus, stdout: viewStdout, stderr: "view failed" };
    return { status: 0, stdout: "", stderr: "" };
  }) satisfies GitReleaseRun;
  const adapter = createRegistryReleaseGitAdapter({
    run,
    mkdtempSync: () => ROOT,
    tmpdir: () => "/tmp",
    readFileSync: (path) => {
      if (lockReadThrows) throw new Error("denied");
      return (
        files.get(path) ??
        (() => {
          throw new Error("ENOENT");
        })()
      );
    },
    writeFileSync: (path, value) => files.set(path, value),
    rmSync: (path) => removed.push(path),
  });
  return { adapter, calls, files, removed };
}

describe("registry release git adapter", () => {
  test("maps an injected spawnSync result without launching a child", () => {
    const calls: Array<{ command: string; args: readonly string[]; options: object }> = [];
    const adapter = createRegistryReleaseGitAdapter({
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          pid: 1,
          output: [null, "verify stdout\n", "verify stderr\n"],
          stdout: "verify stdout\n",
          stderr: "verify stderr\n",
          status: 7,
          signal: null,
        };
      },
    });
    const release = snapshot();
    const plan = release.plans[0];
    if (!plan) throw new Error("missing plan");
    const operation = {
      proposalId: release.id,
      releaseIdentity: release.identity,
      changelog: release.changelog,
      plan,
      target: plan.target,
      worktree: { id: ROOT },
    } satisfies WorktreeOperation;

    expect(adapter.verify(operation)).toEqual({
      ok: false,
      evidence: "verify stdoutverify stderr",
    });
    expect(calls).toEqual([
      {
        command: "vf",
        args: ["verify"],
        options: { cwd: CWD, encoding: "utf8", stdio: "pipe" },
      },
    ]);
  });

  test("runs the hermetic approval in exact order and updates only the matching lock entry", () => {
    const h = harness();
    const proposal = snapshot();
    const result = approveProposal(proposal, { yes: true }, h.adapter);

    expect(h.calls.map(({ command, args, cwd }) => [command, args, cwd])).toEqual([
      ["gh", ["api", "user", "--jq", ".login"], undefined],
      ["gh", ["api", "repos/owner/repo"], undefined],
      [
        "gh",
        [
          "pr",
          "list",
          "--repo",
          "owner/repo",
          "--state",
          "open",
          "--base",
          "main",
          "--head",
          BRANCH,
          "--json",
          "url",
          "--jq",
          '.[0].url // ""',
        ],
        undefined,
      ],
      [
        "git",
        [
          "clone",
          "--branch",
          "main",
          "--single-branch",
          "--depth",
          "1",
          "https://github.com/owner/repo.git",
          CWD,
        ],
        ROOT,
      ],
      ["git", ["switch", "--create", BRANCH], CWD],
      ["git", ["diff", "--name-only"], CWD],
      ["vf", ["verify"], CWD],
      ["git", ["add", "--", ".vibeflow/SKILL_REGISTRY.lock.json"], CWD],
      ["git", ["commit", "-m", "chore: update demo-skill to 1.2.3"], CWD],
      ["git", ["rev-parse", "HEAD"], CWD],
      ["git", ["push", "--set-upstream", "origin", BRANCH], CWD],
      [
        "gh",
        expect.arrayContaining([
          "pr",
          "create",
          "--repo",
          "owner/repo",
          "--base",
          "main",
          "--head",
          BRANCH,
        ]),
        CWD,
      ],
      ["gh", ["pr", "view", "7", "--repo", "owner/repo", "--json", "state,url"], CWD],
    ]);
    expect(result.snapshot.plans[0]?.status).toBe("pr-opened");
    expect(h.removed).toEqual([ROOT]);
    const stored = JSON.parse(h.files.get(LOCK) ?? "{}") as {
      registries: Array<{ name: string; commitOID: string }>;
    };
    expect(stored.registries).toEqual([
      expect.objectContaining({ name: "reg-a", commitOID: TO }),
      expect.objectContaining({ name: "reg-b", commitOID: "d".repeat(40) }),
    ]);
    const prBody =
      h.calls.find(({ args }) => args[0] === "pr" && args[1] === "create")?.args.at(-1) ?? "";
    for (const value of [
      proposal.id,
      "reg-a",
      FROM,
      TO,
      "1.2.3",
      "Ready for consumers",
      "confidence: 1.0",
    ])
      expect(prBody).toContain(value);
  });

  test("rejects create output that is not a strict PR URL for the exact target", () => {
    for (const createStdout of [
      "not a pull request",
      "https://github.com/owner/repo/issues/7",
      "https://github.com/owner/other/pull/7",
      "https://github.com/owner/repo/pull/0",
      "https://github.com/owner/repo/pull/7/",
    ]) {
      const h = harness({ createStdout });
      const result = approveProposal(snapshot(), { yes: true }, h.adapter);
      expect(result.snapshot.plans[0]?.status).toBe("failed");
      expect(h.calls.some(({ args }) => args[0] === "pr" && args[1] === "view")).toBe(false);
      expect(h.removed).toEqual([ROOT]);
    }
  });

  test("does not query after gh pr create fails", () => {
    const h = harness({ createStatus: 1 });
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("failed");
    expect(h.calls.at(-1)?.args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(h.removed).toEqual([ROOT]);
  });

  test("fails closed and cleans up when the PR requery cannot confirm the canonical open PR", () => {
    for (const options of [
      { viewStatus: 1 },
      { viewStdout: "not json" },
      { viewStdout: "[]" },
      { viewStdout: '{"state":"OPEN","url":"https://github.com/owner/other/pull/7"}' },
      { viewStdout: '{"state":"OPEN","url":"https://github.com/owner/repo/pull/8"}' },
      { viewStdout: '{"state":"CLOSED","url":"https://github.com/owner/repo/pull/7"}' },
    ]) {
      const h = harness(options);
      const result = approveProposal(snapshot(), { yes: true }, h.adapter);
      expect(result.snapshot.plans[0]?.status).toBe("failed");
      expect(h.calls.filter(({ args }) => args[0] === "pr" && args[1] === "view")).toHaveLength(1);
      expect(h.removed).toEqual([ROOT]);
    }
  });

  test("does not commit, push, or open a PR when target verification fails, and cleans up", () => {
    const h = harness({ verifyStatus: 1 });
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("failed");
    expect(
      h.calls.some(
        ({ args }) => args[0] === "commit" || args[0] === "push" || args[0] === "create",
      ),
    ).toBe(false);
    expect(h.removed).toEqual([ROOT]);
  });

  test("fails closed for an empty active user and canonical repository metadata mismatch", () => {
    for (const kind of ["identity", "repository", "branch"] as const) {
      const h = harness({
        activeUser: kind === "identity" ? "\n" : "release-bot\n",
        repository: kind === "repository" ? "owner/other" : "owner/repo",
        branch: kind === "branch" ? "stable" : "main",
      });
      const result = approveProposal(snapshot(), { yes: true }, h.adapter);
      expect(result.snapshot.plans[0]?.status).toBe("failed");
      expect(h.calls.some(({ command }) => command === "git")).toBe(false);
    }
  });

  test("fails closed for malformed repository metadata", () => {
    const h = harness({ metadataStdout: "{" });
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("failed");
    expect(h.calls.some(({ command }) => command === "git")).toBe(false);
  });

  test("rejects a non-strict target lock before writing it", () => {
    const h = harness();
    const raw = JSON.parse(h.files.get(LOCK) ?? "{}") as Record<string, unknown>;
    h.files.set(LOCK, JSON.stringify({ ...raw, extra: true }));
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("drifted");
    expect(h.calls.some(({ args }) => args[0] === "diff")).toBe(false);
    expect(h.removed).toEqual([ROOT]);
  });

  test("rejects malformed target lock JSON", () => {
    const h = harness();
    h.files.set(LOCK, "{");
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("drifted");
    expect(h.removed).toEqual([ROOT]);
  });

  test("rejects a target lock when the injected read throws", () => {
    const h = harness({ lockReadThrows: true });
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("drifted");
    expect(h.removed).toEqual([ROOT]);
  });

  test("removes the isolated temp directory when clone setup fails", () => {
    const h = harness({ cloneStatus: 1 });
    const result = approveProposal(snapshot(), { yes: true }, h.adapter);
    expect(result.snapshot.plans[0]?.status).toBe("failed");
    expect(h.removed).toEqual([ROOT]);
  });
});

describe("approveStoredRelease", () => {
  test("reports Error and non-Error failures", () => {
    for (const [failure, message] of [
      [new Error("identity unavailable"), "identity unavailable"],
      ["denied", "Release approval failed."],
    ] as const) {
      const output: Array<{ text: string; level?: "info" | "error" }> = [];
      expect(
        approveStoredRelease(
          snapshot(),
          "/proposal.json",
          () => {
            throw failure;
          },
          () => {
            throw new Error("unexpected write");
          },
          (text, level) => output.push({ text, level }),
        ),
      ).toBe(1);
      expect(output).toEqual([{ text: message, level: "error" }]);
    }
  });
});

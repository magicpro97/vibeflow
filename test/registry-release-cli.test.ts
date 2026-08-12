import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { handleRegistrySubcommand } from "../src/skills/registry-cli.js";
import {
  type RegistryReleaseCliDeps,
  handleRegistryReleaseCommand,
} from "../src/skills/registry-release-cli.js";
import type { ExecutorDeps } from "../src/skills/registry-release-executor.js";

const REPO = "/repo";
const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const PROPOSE = ["release-propose", "reg-a", "--from", FROM, "--to", TO, "--version", "1.2.3"];

function fanout(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    targets: [{ repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] }],
    ...over,
  });
}

function lock(commitOID = TO): string {
  return JSON.stringify({
    schemaVersion: 1,
    registries: [{ name: "reg-a", url: "https://example.com/skills.git", ref: "main", commitOID }],
  });
}

function harness(initial: Record<string, string> = {}) {
  const files = new Map<string, string>([
    [join(REPO, ".vibeflow", "REGISTRY_FANOUT.json"), fanout()],
    [join(REPO, ".vibeflow", "SKILL_REGISTRY.lock.json"), lock()],
    ...Object.entries(initial),
  ]);
  const writes: Array<{ path: string; content: string }> = [];
  const output: Array<{ text: string; level: "info" | "error" }> = [];
  const deps: RegistryReleaseCliDeps = {
    existsSync: (path) => files.has(path) || [...files].some(([p]) => p.startsWith(`${path}/`)),
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    readdirSync: (path) =>
      [...files]
        .map(([p]) => p)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .map((p) => p.slice(path.length + 1)),
    writeFileSafe: (path, content) => {
      writes.push({ path, content });
      files.set(path, content);
    },
    output: (text, level = "info") => output.push({ text, level }),
  };
  return { deps, files, output, writes };
}

function lastJson(h: ReturnType<typeof harness>): unknown {
  const text = h.output.at(-1)?.text;
  if (!text) throw new Error("missing JSON output");
  return JSON.parse(text);
}

function approvalDeps(oid: string | null = TO): ExecutorDeps {
  return {
    activeIdentity: () => "release-bot",
    authorizeTarget: ({ identity, target }) => ({
      identity,
      repository: target.repository,
      baseBranch: target.baseBranch,
      authorized: true,
    }),
    existingPullRequest: () => null,
    createWorktree: () => ({ id: "/tmp/fake" }),
    readTargetRegistryOid: () => oid,
    writeTargetRegistryOid: () => {},
    assertLockOnlyDiff: () => {},
    verify: () => ({ ok: true, evidence: "confidence: 1.0" }),
    commit: () => "c".repeat(40),
    push: () => {},
    createPullRequest: () => ({ url: "https://github.com/owner/repo/pull/1" }),
    cleanupWorktree: () => {},
  };
}

describe("registry release command parsing", () => {
  test("routes release-propose and accepts value/equals options", () => {
    const h = harness();
    const code = handleRegistrySubcommand(
      REPO,
      [
        "release-propose",
        "reg-a",
        `--from=${FROM}`,
        `--to=${TO}`,
        "--version=1.2.3",
        "--changelog=Ready",
      ],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.path).toMatch(
      /^\/repo\/.vibeflow\/registry-release-proposals\/[0-9a-f]{64}\.json$/,
    );
    expect(JSON.parse(h.writes[0]?.content ?? "")).toMatchObject({
      schemaVersion: 1,
      state: "pending",
      changelog: "Ready",
      identity: { registry: "reg-a", fromOid: FROM, toOid: TO, version: "1.2.3" },
    });
  });

  test("rejects missing, duplicate, unknown, and extra arguments with exit 2", () => {
    for (const args of [
      ["release-propose", "reg-a", "--from", FROM, "--to", TO],
      [...PROPOSE, "--to", TO],
      [...PROPOSE, "--bogus"],
      [...PROPOSE, "extra"],
      ["release", "list", "extra"],
      ["release", "show"],
      ["release", "reject", "not-an-id"],
      ["release", "unknown"],
    ]) {
      expect(handleRegistryReleaseCommand(REPO, args, harness().deps)).toBe(2);
    }
  });

  test("prints release usage for an unknown top-level command", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, ["unknown"], h.deps)).toBe(2);
    expect(h.output).toEqual([
      {
        text: "Usage: vf skills registry release <list|show <proposal-id>|reject <proposal-id>|approve <proposal-id> --yes>",
        level: "error",
      },
    ]);
  });
});

describe("release-propose", () => {
  test("dry run prints the snapshot and never writes", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, [...PROPOSE, "--dry-run"], h.deps)).toBe(0);
    expect(h.writes).toEqual([]);
    expect(lastJson(h)).toMatchObject({ state: "pending", identity: { registry: "reg-a" } });
  });

  test("sanitizes changelog before persistence and stored output", () => {
    const cases: Array<[string, string]> = [
      ["Ready\u0000\u0007\n\t", "Ready"],
      [
        "https://user:secret@example.com/releases?token=abc#details",
        "https://example.com/releases",
      ],
      ["See /Users/alice/private/release-notes.md", "See [redacted]"],
    ];
    for (const [unsafe, safe] of cases) {
      const h = harness();
      expect(
        handleRegistryReleaseCommand(REPO, [...PROPOSE, "--changelog", unsafe ?? ""], h.deps),
      ).toBe(0);
      const stored = JSON.parse(h.writes[0]?.content ?? "{}") as {
        id: string;
        changelog: string;
      };
      expect(stored.changelog).toBe(safe);

      // Stored changelog is already sanitized, so show/list round-trip it clean.
      expect(handleRegistryReleaseCommand(REPO, ["release", "show", stored.id], h.deps)).toBe(0);
      expect(lastJson(h)).toMatchObject({ changelog: safe });
      expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(0);
      expect(lastJson(h)).toEqual([expect.objectContaining({ changelog: safe })]);
    }
  });

  test("keeps default and explicit empty changelogs and rejects over-limit input", () => {
    for (const args of [PROPOSE, [...PROPOSE, "--changelog="]]) {
      const h = harness();
      expect(handleRegistryReleaseCommand(REPO, args, h.deps)).toBe(0);
      expect(lastJson(h)).toMatchObject({ changelog: "" });
    }
    expect(
      handleRegistryReleaseCommand(
        REPO,
        [...PROPOSE, "--changelog", "x".repeat(10_001)],
        harness().deps,
      ),
    ).toBe(2);
  });

  test("stores every generated target plan with pending status", () => {
    const targets = [
      { repository: "a/repo", baseBranch: "main", registries: ["reg-a"] },
      { repository: "b/repo", baseBranch: "stable", registries: ["reg-a"] },
    ];
    for (const dryRun of [false, true]) {
      const h = harness({
        [join(REPO, ".vibeflow", "REGISTRY_FANOUT.json")]: fanout({ targets }),
      });
      const args = dryRun ? [...PROPOSE, "--dry-run"] : PROPOSE;
      expect(handleRegistryReleaseCommand(REPO, args, h.deps)).toBe(0);
      const snapshot = lastJson(h) as { plans: Array<{ status?: string }> };
      expect(snapshot.plans.map((plan) => plan.status)).toEqual(["pending", "pending"]);
      expect(h.writes).toHaveLength(dryRun ? 0 : 1);
    }
  });

  test("missing config means no target and exits 0", () => {
    const h = harness();
    h.files.delete(join(REPO, ".vibeflow", "REGISTRY_FANOUT.json"));
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.output.at(-1)?.text).toContain("No release targets");
  });

  test("no eligible configured target exits 0 without writing", () => {
    const h = harness({
      [join(REPO, ".vibeflow", "REGISTRY_FANOUT.json")]: fanout({
        targets: [{ repository: "owner/repo", baseBranch: "main", registries: ["reg-b"] }],
      }),
    });
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    expect(h.writes).toEqual([]);
  });

  test("malformed config or read failure exits 1", () => {
    const malformed = harness({
      [join(REPO, ".vibeflow", "REGISTRY_FANOUT.json")]: fanout({ extra: true }),
    });
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, malformed.deps)).toBe(1);

    const unreadable = harness();
    unreadable.deps.readFileSync = () => {
      throw new Error("denied");
    };
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, unreadable.deps)).toBe(1);
  });

  test("requires a strict source lock entry matching the new OID", () => {
    const wrongOid = harness({
      [join(REPO, ".vibeflow", "SKILL_REGISTRY.lock.json")]: lock(FROM),
    });
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, wrongOid.deps)).toBe(1);

    const missingRegistry = harness({
      [join(REPO, ".vibeflow", "SKILL_REGISTRY.lock.json")]: JSON.stringify({
        schemaVersion: 1,
        registries: [],
      }),
    });
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, missingRegistry.deps)).toBe(1);

    const loose = harness({
      [join(REPO, ".vibeflow", "SKILL_REGISTRY.lock.json")]: JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "reg-a",
            url: "https://example.com/skills.git",
            ref: "main",
            commitOID: TO,
            unexpected: true,
          },
        ],
      }),
    });
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, loose.deps)).toBe(1);
  });

  test("reports a proposal snapshot write failure", () => {
    const h = harness();
    h.deps.writeFileSafe = () => {
      throw new Error("disk full");
    };

    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(1);
    expect(h.output.at(-1)).toEqual({
      text: "Failed to write release proposal snapshot.",
      level: "error",
    });
  });
});

describe("release snapshot commands", () => {
  test("list and show strictly read stored proposals", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const proposal = JSON.parse(h.writes[0]?.content ?? "") as { id: string };

    expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(0);
    expect(lastJson(h)).toEqual([expect.objectContaining({ id: proposal.id, state: "pending" })]);

    expect(handleRegistryReleaseCommand(REPO, ["release", "show", proposal.id], h.deps)).toBe(0);
    expect(lastJson(h)).toMatchObject({ id: proposal.id, state: "pending" });

    const path = join(REPO, ".vibeflow", "registry-release-proposals", `${proposal.id}.json`);
    h.files.set(path, JSON.stringify({ ...JSON.parse(h.files.get(path) ?? "{}"), extra: true }));
    expect(handleRegistryReleaseCommand(REPO, ["release", "show", proposal.id], h.deps)).toBe(1);
    expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(1);
  });

  test("empty list is valid and missing proposal exits 1", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(0);
    expect(lastJson(h)).toEqual([]);
    expect(handleRegistryReleaseCommand(REPO, ["release", "show", "c".repeat(64)], h.deps)).toBe(1);
  });

  test("reports a proposal directory read failure", () => {
    const h = harness();
    h.deps.existsSync = () => true;
    h.deps.readdirSync = () => {
      throw new Error("denied");
    };

    expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(1);
    expect(h.output.at(-1)).toEqual({
      text: "Failed to read release proposals.",
      level: "error",
    });
  });

  test("strictly reconstructs stored plans with valid lifecycle status", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const snapshot = JSON.parse(h.writes[0]?.content ?? "{}") as {
      id: string;
      plans: Array<Record<string, unknown>>;
    };
    const path = join(REPO, ".vibeflow", "registry-release-proposals", `${snapshot.id}.json`);
    const statuses = [
      "pending",
      "not-eligible",
      "already-current",
      "existing-pr",
      "drifted",
      "verifying",
      "pr-opened",
      "failed",
    ];
    for (const status of statuses) {
      const plans = snapshot.plans.map((plan) => ({ ...plan, status }));
      h.files.set(path, JSON.stringify({ ...snapshot, plans }));
      expect(handleRegistryReleaseCommand(REPO, ["release", "show", snapshot.id], h.deps)).toBe(0);
      expect((lastJson(h) as { plans: Array<{ status: string }> }).plans[0]?.status).toBe(status);
    }

    const valid = { ...snapshot.plans[0], status: "pending" };
    const { status: _status, ...missingStatus } = valid;
    for (const plan of [
      missingStatus,
      { ...valid, status: "done" },
      { ...valid, extra: true },
      { ...valid, branch: 7 },
    ]) {
      h.files.set(path, JSON.stringify({ ...snapshot, plans: [plan] }));
      expect(handleRegistryReleaseCommand(REPO, ["release", "show", snapshot.id], h.deps)).toBe(1);
    }

    const target = { repository: "other/repo", baseBranch: "main", registries: ["reg-b"] };
    h.files.set(
      path,
      JSON.stringify({
        ...snapshot,
        plans: [valid, { ...valid, target, fanout: { schemaVersion: 1, targets: [target] } }],
      }),
    );
    expect(handleRegistryReleaseCommand(REPO, ["release", "show", snapshot.id], h.deps)).toBe(1);
  });

  test("fails closed when a stored changelog is not already sanitized", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const snapshot = JSON.parse(h.writes[0]?.content ?? "{}") as { id: string };
    const path = join(REPO, ".vibeflow", "registry-release-proposals", `${snapshot.id}.json`);
    // A hand-tampered snapshot whose changelog contains an absolute path (which
    // sanitizeForOutput would rewrite) must be rejected on read, not silently
    // rewritten — otherwise show/list display a snapshot approve() later rejects.
    for (const changelog of ["see /etc/passwd", "ctrl\u0007char", "https://u:p@h.co/x"]) {
      h.files.set(path, JSON.stringify({ ...snapshot, changelog }));
      expect(handleRegistryReleaseCommand(REPO, ["release", "show", snapshot.id], h.deps)).toBe(1);
      expect(handleRegistryReleaseCommand(REPO, ["release", "list"], h.deps)).toBe(1);
    }
  });

  test("reject writes only the pending-to-rejected transition", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const proposal = JSON.parse(h.writes[0]?.content ?? "") as { id: string };
    const command = ["release", "reject", proposal.id];

    expect(handleRegistryReleaseCommand(REPO, command, h.deps)).toBe(0);
    expect(JSON.parse(h.writes.at(-1)?.content ?? "").state).toBe("rejected");
    expect(handleRegistryReleaseCommand(REPO, command, h.deps)).toBe(1);
    expect(h.writes).toHaveLength(2);
  });

  test("reports a rejected snapshot write failure", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const proposal = JSON.parse(h.writes[0]?.content ?? "") as { id: string };
    h.deps.writeFileSafe = () => {
      throw new Error("disk full");
    };

    expect(handleRegistryReleaseCommand(REPO, ["release", "reject", proposal.id], h.deps)).toBe(1);
    expect(h.output.at(-1)).toEqual({
      text: "Failed to write release proposal snapshot.",
      level: "error",
    });
  });

  test("approve requires exact args and --yes before constructing an adapter", () => {
    const h = harness();
    let factories = 0;
    h.deps.executorAdapterFactory = () => {
      factories++;
      return approvalDeps();
    };
    for (const args of [
      ["release", "approve", "c".repeat(64)],
      ["release", "approve", "c".repeat(64), "--yes", "extra"],
      ["release", "approve", "not-an-id", "--yes"],
    ])
      expect(handleRegistryReleaseCommand(REPO, args, h.deps)).toBe(2);
    expect(factories).toBe(0);
  });

  test("approve returns a number and persists executor terminal statuses before returning", () => {
    const h = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, h.deps)).toBe(0);
    const proposal = JSON.parse(h.writes[0]?.content ?? "{}") as { id: string };
    h.deps.executorAdapterFactory = () => approvalDeps();

    const code = handleRegistryReleaseCommand(
      REPO,
      ["release", "approve", proposal.id, "--yes"],
      h.deps,
    );
    expect(typeof code).toBe("number");
    expect(code).toBe(0);
    expect(JSON.parse(h.writes.at(-1)?.content ?? "{}")).toMatchObject({
      state: "completed",
      plans: [{ status: "already-current" }],
    });
    expect(lastJson(h)).toMatchObject({ snapshot: { state: "completed" } });
  });

  test("approve returns 1 for missing/corrupt snapshots and persists failures", () => {
    const missing = harness();
    let factories = 0;
    missing.deps.executorAdapterFactory = () => {
      factories++;
      return approvalDeps();
    };
    expect(
      handleRegistryReleaseCommand(
        REPO,
        ["release", "approve", "c".repeat(64), "--yes"],
        missing.deps,
      ),
    ).toBe(1);
    expect(factories).toBe(0);

    const corrupt = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, corrupt.deps)).toBe(0);
    const proposal = JSON.parse(corrupt.writes[0]?.content ?? "{}") as { id: string };
    const path = join(REPO, ".vibeflow", "registry-release-proposals", `${proposal.id}.json`);
    corrupt.files.set(path, "not-json");
    corrupt.deps.executorAdapterFactory = () => {
      factories++;
      return approvalDeps();
    };
    expect(
      handleRegistryReleaseCommand(
        REPO,
        ["release", "approve", proposal.id, "--yes"],
        corrupt.deps,
      ),
    ).toBe(1);
    expect(factories).toBe(0);

    const failed = harness();
    expect(handleRegistryReleaseCommand(REPO, PROPOSE, failed.deps)).toBe(0);
    const failedProposal = JSON.parse(failed.writes[0]?.content ?? "{}") as { id: string };
    failed.deps.executorAdapterFactory = () => {
      const deps = approvalDeps(FROM);
      deps.activeIdentity = () => {
        throw new Error("identity unavailable");
      };
      return deps;
    };
    const code = handleRegistrySubcommand(
      REPO,
      ["release", "approve", failedProposal.id, "--yes"],
      failed.deps,
    );
    expect(typeof code).toBe("number");
    expect(code).toBe(1);
    expect(JSON.parse(failed.writes.at(-1)?.content ?? "{}")).toMatchObject({
      state: "partial-failure",
      plans: [{ status: "failed" }],
    });
  });
});

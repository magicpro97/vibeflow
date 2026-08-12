import { describe, expect, test } from "bun:test";
import {
  type ApprovalResult,
  type ExecutorDeps,
  type ReleaseSnapshot,
  type StoredReleasePlan,
  approveProposal,
} from "../src/skills/registry-release-executor.js";
import {
  type FanoutTarget,
  type ReleaseIdentity,
  type TargetState,
  buildReleasePlans,
} from "../src/skills/registry-release.js";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const IDENTITY: ReleaseIdentity = {
  fromOid: FROM,
  toOid: TO,
  version: "1.2.3",
  registry: "reg-a",
};
const TARGET_ONE: FanoutTarget = {
  repository: "owner/one",
  baseBranch: "main",
  registries: ["reg-a"],
};
const TARGET_TWO: FanoutTarget = {
  repository: "owner/two",
  baseBranch: "stable",
  registries: ["reg-a"],
};
const TARGETS = [TARGET_ONE, TARGET_TWO];

function snapshot(count = 1): ReleaseSnapshot {
  const plans = buildReleasePlans(TARGETS.slice(0, count), IDENTITY, "demo-skill").map((plan) => ({
    ...plan,
    status: "pending" as const,
  }));
  return {
    schemaVersion: 1,
    id: plans[0]?.proposalId ?? "",
    identity: IDENTITY,
    changelog: "Ready",
    state: "pending",
    plans,
  };
}

function harness() {
  const calls: string[] = [];
  const mark = (name: string) => calls.push(name);
  const deps: ExecutorDeps = {
    activeIdentity: () => {
      mark("identity");
      return "release-bot";
    },
    authorizeTarget: ({ identity, target }) => {
      mark(`authorize:${target.repository}`);
      return {
        identity,
        repository: target.repository,
        baseBranch: target.baseBranch,
        authorized: true,
      };
    },
    existingPullRequest: ({ target }) => {
      mark(`existing:${target.repository}`);
      return null;
    },
    createWorktree: ({ target }) => {
      mark(`worktree:${target.repository}`);
      return { id: `wt:${target.repository}` };
    },
    readTargetRegistryOid: ({ target }) => {
      mark(`read:${target.repository}`);
      return FROM;
    },
    writeTargetRegistryOid: ({ target }) => {
      mark(`write:${target.repository}`);
    },
    assertLockOnlyDiff: ({ target }) => {
      mark(`diff:${target.repository}`);
    },
    verify: ({ target }) => {
      mark(`verify:${target.repository}`);
      return { ok: true, evidence: "verified" };
    },
    commit: ({ target }) => {
      mark(`commit:${target.repository}`);
      return "c".repeat(40);
    },
    push: ({ target }) => {
      mark(`push:${target.repository}`);
    },
    createPullRequest: ({ target }) => {
      mark(`pr:${target.repository}`);
      return { url: `https://github.com/${target.repository}/pull/1?token=secret` };
    },
    cleanupWorktree: ({ target }) => {
      mark(`cleanup:${target.repository}`);
    },
  };
  return { calls, deps };
}

function status(result: ApprovalResult, index = 0): TargetState | undefined {
  return result.snapshot.plans[index]?.status;
}

function firstPlan(value: ReleaseSnapshot): StoredReleasePlan {
  const plan = value.plans[0];
  if (!plan) throw new Error("missing plan");
  return plan;
}

function expectInvalidSnapshot(value: ReleaseSnapshot): void {
  const h = harness();
  expect(() => approveProposal(value, { yes: true }, h.deps)).toThrow("Invalid release snapshot");
  expect(h.calls).toEqual([]);
}

describe("approveProposal", () => {
  test("runs the happy path in order and returns bounded sanitized evidence", () => {
    const h = harness();
    const result = approveProposal(snapshot(), { yes: true }, h.deps);

    expect(h.calls).toEqual([
      "identity",
      "authorize:owner/one",
      "existing:owner/one",
      "worktree:owner/one",
      "read:owner/one",
      "write:owner/one",
      "diff:owner/one",
      "verify:owner/one",
      "commit:owner/one",
      "push:owner/one",
      "pr:owner/one",
      "cleanup:owner/one",
    ]);
    expect(result.snapshot.state).toBe("completed");
    expect(status(result)).toBe("pr-opened");
    expect(result.targets[0]?.evidence).toBe("https://github.com/owner/one/pull/1");
    expect(result.targets[0]?.evidence.length).toBeLessThanOrEqual(256);
  });

  test("refuses missing --yes and every non-pending proposal with zero external calls", () => {
    const no = harness();
    expect(() => approveProposal(snapshot(), { yes: false }, no.deps)).toThrow("--yes");
    expect(no.calls).toEqual([]);

    for (const state of [
      "running",
      "completed",
      "partial-failure",
      "rejected",
      "expired",
    ] as const) {
      const h = harness();
      expect(() => approveProposal({ ...snapshot(), state }, { yes: true }, h.deps)).toThrow(
        "not pending",
      );
      expect(h.calls).toEqual([]);
    }
  });

  test("fails closed on identity, authorization, and canonical target metadata", () => {
    const cases: Array<(deps: ExecutorDeps) => void> = [
      (deps) => {
        deps.authorizeTarget = ({ target }) => ({
          identity: "other-bot",
          repository: target.repository,
          baseBranch: target.baseBranch,
          authorized: true,
        });
      },
      (deps) => {
        deps.authorizeTarget = ({ identity, target }) => ({
          identity,
          repository: target.repository,
          baseBranch: target.baseBranch,
          authorized: false,
        });
      },
      (deps) => {
        deps.authorizeTarget = ({ identity, target }) => ({
          identity,
          repository: "owner/other",
          baseBranch: target.baseBranch,
          authorized: true,
        });
      },
      (deps) => {
        deps.authorizeTarget = ({ identity, target }) => ({
          identity,
          repository: target.repository,
          baseBranch: "other",
          authorized: true,
        });
      },
    ];
    for (const alter of cases) {
      const h = harness();
      alter(h.deps);
      const result = approveProposal(snapshot(), { yes: true }, h.deps);
      expect(status(result)).toBe("failed");
      expect(result.snapshot.state).toBe("partial-failure");
      expect(h.calls.some((call) => call.startsWith("existing:"))).toBe(false);
      expect(h.calls.some((call) => call.startsWith("worktree:"))).toBe(false);
    }
  });

  test("rejects an invalid schema version before external operations", () => {
    const value = snapshot();
    (value as { schemaVersion: number }).schemaVersion = 2;
    expectInvalidSnapshot(value);
  });

  test("rejects invalid and mismatched snapshot IDs before external operations", () => {
    const invalid = snapshot();
    invalid.id = "not-an-id";
    expectInvalidSnapshot(invalid);

    const mismatched = snapshot();
    mismatched.id = "f".repeat(64);
    expectInvalidSnapshot(mismatched);
  });

  test("rejects a coordinated forged snapshot and plan ID before external operations", () => {
    const value = snapshot(2);
    const forged = "f".repeat(64);
    value.id = forged;
    value.plans = value.plans.map((plan) => ({ ...plan, proposalId: forged }));
    expectInvalidSnapshot(value);
  });

  test("rejects an invalid release identity before external operations", () => {
    const value = snapshot();
    value.identity = { ...IDENTITY, toOid: FROM };
    expectInvalidSnapshot(value);
  });

  test("rejects an empty plan list before external operations", () => {
    const value = snapshot();
    value.plans = [];
    expectInvalidSnapshot(value);
  });

  test("rejects unsafe and overlong changelogs before external operations", () => {
    const unsafe = snapshot();
    unsafe.changelog = "See /Users/alice/private/release-notes.md";
    expectInvalidSnapshot(unsafe);

    const overlong = snapshot();
    overlong.changelog = "x".repeat(10_001);
    expectInvalidSnapshot(overlong);
  });

  test("rejects any invalid plan before processing an earlier valid plan", () => {
    const value = snapshot(2);
    const plan = value.plans[1];
    if (!plan) throw new Error("missing second plan");
    value.plans[1] = { ...plan, version: "9.9.9" };
    expectInvalidSnapshot(value);
  });

  test("rejects invalid plan identity, branch, fanout, and status metadata globally", () => {
    const cases: Array<(value: ReleaseSnapshot) => void> = [
      (value) => {
        value.plans[0] = { ...firstPlan(value), proposalId: "wrong" };
      },
      (value) => {
        value.plans[0] = { ...firstPlan(value), version: "9.9.9" };
      },
      (value) => {
        value.plans[0] = { ...firstPlan(value), registry: "reg-b" };
      },
      (value) => {
        value.plans[0] = { ...firstPlan(value), branch: "feature/update-skill-safe" };
      },
      (value) => {
        value.plans[0] = {
          ...firstPlan(value),
          fanout: { schemaVersion: 1, targets: [TARGET_TWO] },
        };
      },
      (value) => {
        value.plans[0] = { ...firstPlan(value), status: "unknown" as TargetState };
      },
    ];
    for (const alter of cases) {
      const value = snapshot();
      alter(value);
      expectInvalidSnapshot(value);
    }
  });

  test("rejects plan fields not exactly derived from snapshot identity and targets", () => {
    const cases: Array<(value: ReleaseSnapshot) => void> = [
      (value) => {
        const second = value.plans[1];
        if (!second) throw new Error("missing second plan");
        value.plans[1] = { ...second, skill: "other-skill" };
      },
      (value) => {
        value.identity = { ...value.identity, version: "9.9.9" };
        value.plans = value.plans.map((plan) => ({ ...plan, version: "9.9.9" }));
      },
      (value) => {
        value.plans[0] = {
          ...firstPlan(value),
          branch: "chore/update-skill-forged-1.2.3",
        };
      },
      (value) => {
        const plan = firstPlan(value);
        const target = { ...plan.target, baseBranch: "release" };
        value.plans[0] = {
          ...plan,
          target,
          fanout: { schemaVersion: 1, targets: [target] },
        };
      },
    ];
    for (const alter of cases) {
      const value = snapshot(2);
      alter(value);
      expectInvalidSnapshot(value);
    }
  });

  test("rejects an invalid common skill even when its derived branch matches", () => {
    const value = snapshot();
    const [plan] = buildReleasePlans([TARGET_ONE], IDENTITY, "");
    if (!plan) throw new Error("missing plan");
    value.plans[0] = { ...plan, status: "pending" };
    expectInvalidSnapshot(value);
  });

  test("rejects target plans outside canonical derived order", () => {
    const value = snapshot(2);
    value.plans.reverse();
    expectInvalidSnapshot(value);
  });

  test("validates terminal plans before reusing their outcomes", () => {
    const value = snapshot();
    value.plans[0] = {
      ...firstPlan(value),
      branch: "feature/update-skill-safe",
      status: "pr-opened",
    };
    expectInvalidSnapshot(value);
  });

  test("existing PR stops before worktree creation", () => {
    const h = harness();
    h.deps.existingPullRequest = ({ target }) => {
      h.calls.push(`existing:${target.repository}`);
      return "https://github.com/owner/one/pull/9";
    };
    const result = approveProposal(snapshot(), { yes: true }, h.deps);
    expect(status(result)).toBe("existing-pr");
    expect(h.calls).toEqual(["identity", "authorize:owner/one", "existing:owner/one"]);
  });

  test("exact new OID is already current and never mutates the target", () => {
    const h = harness();
    h.deps.readTargetRegistryOid = ({ target }) => {
      h.calls.push(`read:${target.repository}`);
      return TO;
    };
    const result = approveProposal(snapshot(), { yes: true }, h.deps);
    expect(status(result)).toBe("already-current");
    expect(h.calls).toEqual([
      "identity",
      "authorize:owner/one",
      "existing:owner/one",
      "worktree:owner/one",
      "read:owner/one",
      "cleanup:owner/one",
    ]);
  });

  test("anything other than exact old/new OID is drift and never mutates the target", () => {
    for (const oid of [null, "A".repeat(40), "d".repeat(40)]) {
      const h = harness();
      h.deps.readTargetRegistryOid = () => oid;
      const result = approveProposal(snapshot(), { yes: true }, h.deps);
      expect(status(result)).toBe("drifted");
      expect(h.calls.some((call) => call.startsWith("write:"))).toBe(false);
      expect(h.calls.at(-1)).toBe("cleanup:owner/one");
    }
  });

  test("failed verification never commits, pushes, or opens a PR", () => {
    const h = harness();
    h.deps.verify = ({ target }) => {
      h.calls.push(`verify:${target.repository}`);
      return { ok: false, evidence: "failed at /Users/alice/private\u0000" };
    };
    const result = approveProposal(snapshot(), { yes: true }, h.deps);
    expect(status(result)).toBe("failed");
    expect(result.targets[0]?.evidence).toBe("failed at [redacted]");
    expect(h.calls.some((call) => /^(commit|push|pr):/.test(call))).toBe(false);
    expect(h.calls.at(-1)).toBe("cleanup:owner/one");
  });

  test("always cleans up when a target operation throws and sanitizes the error", () => {
    const h = harness();
    h.deps.assertLockOnlyDiff = () => {
      throw new Error(`bad diff\u0000${"x".repeat(400)}`);
    };
    const result = approveProposal(snapshot(), { yes: true }, h.deps);
    expect(status(result)).toBe("failed");
    expect(result.targets[0]?.evidence).toStartWith("bad diffx");
    expect(result.targets[0]?.evidence.length).toBe(256);
    expect(h.calls.some((call) => /^(verify|commit|push|pr):/.test(call))).toBe(false);
    expect(h.calls.at(-1)).toBe("cleanup:owner/one");
  });

  test("continues independently after one target fails", () => {
    const h = harness();
    h.deps.verify = ({ target }) => {
      h.calls.push(`verify:${target.repository}`);
      return target.repository === "owner/one"
        ? { ok: false, evidence: "no" }
        : { ok: true, evidence: "yes" };
    };
    const result = approveProposal(snapshot(2), { yes: true }, h.deps);
    expect(result.snapshot.state).toBe("partial-failure");
    expect(result.snapshot.plans.map((plan) => plan.status)).toEqual(["failed", "pr-opened"]);
    expect(h.calls).toContain("pr:owner/two");
    expect(h.calls).toContain("cleanup:owner/one");
    expect(h.calls).toContain("cleanup:owner/two");
  });

  test("does not repeat terminal target actions and rejects duplicate plans", () => {
    const terminal = harness();
    const done = snapshot();
    done.plans[0] = { ...firstPlan(done), status: "pr-opened" };
    const resumed = approveProposal(done, { yes: true }, terminal.deps);
    expect(status(resumed)).toBe("pr-opened");
    expect(terminal.calls).toEqual([]);

    const duplicate = harness();
    const duplicated = snapshot();
    duplicated.plans.push({ ...firstPlan(duplicated) });
    expect(() => approveProposal(duplicated, { yes: true }, duplicate.deps)).toThrow(
      "Invalid release snapshot",
    );
    expect(duplicate.calls).toEqual([]);
  });

  test("cleanup failure is recorded without erasing a successful target", () => {
    const h = harness();
    h.deps.cleanupWorktree = () => {
      throw new Error("cleanup failed");
    };
    const result = approveProposal(snapshot(), { yes: true }, h.deps);
    expect(status(result)).toBe("failed");
    expect(result.snapshot.state).toBe("partial-failure");
    expect(result.targets[0]?.evidence).toBe("cleanup failed");
  });
});

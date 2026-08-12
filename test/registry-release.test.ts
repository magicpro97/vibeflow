import { describe, expect, test } from "bun:test";
import {
  type ProposalState,
  type ReleaseIdentity,
  type TargetState,
  buildReleasePlans,
  parseRegistryFanout,
  parseReleaseIdentity,
  proposalIdFor,
  sanitizeForOutput,
  setProposalState,
  setTargetState,
  toPublicProposal,
} from "../src/skills/registry-release.js";

const VALID_FANOUT = {
  schemaVersion: 1,
  targets: [{ repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] }],
};

const OID = "a".repeat(40);
const OID2 = "b".repeat(40);

function ident(over: Partial<ReleaseIdentity> = {}): ReleaseIdentity {
  return { fromOid: OID, toOid: OID2, version: "1.2.3", registry: "reg-a", ...over };
}

describe("parseRegistryFanout", () => {
  test("accepts exact valid schema", () => {
    const r = parseRegistryFanout(VALID_FANOUT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.targets).toHaveLength(1);
      expect(r.value.targets[0]).toEqual({
        repository: "owner/repo",
        baseBranch: "main",
        registries: ["reg-a"],
      });
    }
  });

  test("rejects non-object / null input", () => {
    expect(parseRegistryFanout(null).ok).toBe(false);
    expect(parseRegistryFanout("nope").ok).toBe(false);
    expect(parseRegistryFanout(undefined).ok).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    expect(parseRegistryFanout({ ...VALID_FANOUT, extra: 1 }).ok).toBe(false);
  });

  test("rejects wrong schemaVersion", () => {
    expect(parseRegistryFanout({ ...VALID_FANOUT, schemaVersion: 2 }).ok).toBe(false);
  });

  test("rejects missing/non-array targets", () => {
    expect(parseRegistryFanout({ schemaVersion: 1 }).ok).toBe(false);
    expect(parseRegistryFanout({ schemaVersion: 1, targets: {} }).ok).toBe(false);
  });

  test("rejects unknown keys inside a target", () => {
    const bad = { ...VALID_FANOUT, targets: [{ ...VALID_FANOUT.targets[0], bogus: 1 }] };
    expect(parseRegistryFanout(bad).ok).toBe(false);
  });

  test("rejects invalid repository shape", () => {
    for (const repo of [
      "",
      "owner",
      "owner/repo/extra",
      "owner//repo",
      "Owner/Repo spaces",
      "o r/repo",
    ]) {
      const bad = { ...VALID_FANOUT, targets: [{ ...VALID_FANOUT.targets[0], repository: repo }] };
      expect(parseRegistryFanout(bad).ok).toBe(false);
    }
  });

  test("rejects unsafe baseBranch ref", () => {
    for (const ref of ["..", "main..x", "a b", "refs/heads/main", "main;rm -rf", "-x"]) {
      const bad = { ...VALID_FANOUT, targets: [{ ...VALID_FANOUT.targets[0], baseBranch: ref }] };
      expect(parseRegistryFanout(bad).ok).toBe(false);
    }
  });

  test("rejects empty, duplicate, or malformed registries", () => {
    const empty = { ...VALID_FANOUT, targets: [{ ...VALID_FANOUT.targets[0], registries: [] }] };
    expect(parseRegistryFanout(empty).ok).toBe(false);

    const dup = {
      ...VALID_FANOUT,
      targets: [{ ...VALID_FANOUT.targets[0], registries: ["reg-a", "reg-a"] }],
    };
    expect(parseRegistryFanout(dup).ok).toBe(false);

    const malformed = {
      ...VALID_FANOUT,
      targets: [{ ...VALID_FANOUT.targets[0], registries: ["Bad Name"] }],
    };
    expect(parseRegistryFanout(malformed).ok).toBe(false);
  });

  test("rejects duplicate (repository, registry) target pairs", () => {
    const dup = {
      schemaVersion: 1,
      targets: [
        { repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] },
        { repository: "owner/repo", baseBranch: "dev", registries: ["reg-a"] },
      ],
    };
    expect(parseRegistryFanout(dup).ok).toBe(false);
  });
});

describe("parseReleaseIdentity", () => {
  test("accepts distinct OIDs, bounded version, and validated registry", () => {
    const r = parseReleaseIdentity(ident());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.registry).toBe("reg-a");
  });

  test("accepts 64-hex OIDs", () => {
    const r = parseReleaseIdentity({
      fromOid: "c".repeat(64),
      toOid: "d".repeat(64),
      version: "0.1.0",
      registry: "reg-a",
    });
    expect(r.ok).toBe(true);
  });

  test("rejects unknown identity keys", () => {
    expect(parseReleaseIdentity({ ...ident(), extra: 1 }).ok).toBe(false);
  });

  test("rejects missing registry field", () => {
    const { registry: _r, ...rest } = ident();
    expect(parseReleaseIdentity(rest).ok).toBe(false);
  });

  test("rejects missing any required field", () => {
    for (const key of ["fromOid", "toOid", "version", "registry"] as const) {
      const { [key]: _omit, ...rest } = ident();
      expect(parseReleaseIdentity(rest).ok).toBe(false);
    }
  });

  test("rejects unsafe registry ID", () => {
    for (const reg of ["", "Bad Name", "reg..x", "reg/", "-reg", "reg--x"]) {
      expect(parseReleaseIdentity(ident({ registry: reg })).ok).toBe(false);
    }
  });

  test("rejects uppercase hex", () => {
    const r = parseReleaseIdentity(ident({ toOid: "B".repeat(40) }));
    expect(r.ok).toBe(false);
  });

  test("rejects non-distinct from/to OIDs", () => {
    const r = parseReleaseIdentity(ident({ toOid: OID }));
    expect(r.ok).toBe(false);
  });

  test("rejects wrong-length hex", () => {
    const r = parseReleaseIdentity(ident({ toOid: "b".repeat(41) }));
    expect(r.ok).toBe(false);
  });

  test("rejects unsafe/malformed version", () => {
    for (const v of ["", "1.0.0;rm -rf", "1.0.0\nextra", "v1.2.3", "1.0.0/../x"]) {
      const r = parseReleaseIdentity(ident({ version: v }));
      expect(r.ok).toBe(false);
    }
  });
});

describe("sanitizeForOutput", () => {
  test("strips control characters", () => {
    expect(sanitizeForOutput("a\u0001b\u0007c")).toBe("abc");
    expect(sanitizeForOutput("\u0000\u001f")).toBe("");
  });

  test("strips credentials from URLs", () => {
    expect(sanitizeForOutput("https://user:pass@example.com/x")).toBe("https://example.com/x");
  });

  test("strips query and fragment from URLs", () => {
    expect(sanitizeForOutput("https://example.com/p?q=1#frag")).toBe("https://example.com/p");
  });

  test("strips absolute paths", () => {
    expect(sanitizeForOutput("see /etc/passwd and /usr/local/bin/x now")).toBe(
      "see [redacted] and [redacted] now",
    );
  });

  test("leaves plain text intact", () => {
    expect(sanitizeForOutput("hello world 1.2.3")).toBe("hello world 1.2.3");
  });
});

describe("proposalIdFor identity binding (#2)", () => {
  const targets = () => {
    const r = parseRegistryFanout({
      schemaVersion: 1,
      targets: [
        { repository: "a/repo", baseBranch: "main", registries: ["reg-a"] },
        { repository: "b/repo", baseBranch: "main", registries: ["reg-a"] },
      ],
    });
    return r.ok ? r.value.targets : null;
  };

  test("binds schemaVersion, registry, oids, version, and sorted targets", () => {
    const t = targets();
    expect(t).toBeDefined();
    if (!t) return;
    expect(proposalIdFor(1, ident(), "reg-a", t)).toBe(proposalIdFor(1, ident(), "reg-a", t));
    expect(proposalIdFor(1, ident(), "reg-a", t)).not.toBe(proposalIdFor(2, ident(), "reg-a", t));
    expect(proposalIdFor(1, ident(), "reg-a", t)).not.toBe(proposalIdFor(1, ident(), "reg-b", t));
    expect(proposalIdFor(1, ident(), "reg-a", t)).not.toBe(
      proposalIdFor(1, ident({ fromOid: "c".repeat(40) }), "reg-a", t),
    );
    expect(proposalIdFor(1, ident(), "reg-a", t)).not.toBe(
      proposalIdFor(1, ident({ version: "2.0.0" }), "reg-a", t),
    );
  });

  test("changes when the eligible target set changes, not just a subset", () => {
    const t = targets();
    if (!t) return;
    const subset = t.slice(0, 1);
    expect(proposalIdFor(1, ident(), "reg-a", t)).not.toBe(
      proposalIdFor(1, ident(), "reg-a", subset),
    );
  });
});

describe("buildReleasePlans (#3)", () => {
  test("builds one deterministic plan per eligible (target, registry) pair", () => {
    const f = parseRegistryFanout(VALID_FANOUT);
    if (!f.ok) throw new Error("fixture invalid");
    const plans = buildReleasePlans(f.value.targets, ident(), "my-skill");
    expect(plans).toHaveLength(1);
    const p = plans[0];
    expect(p).toBeDefined();
    if (!p) return;
    expect(p.skill).toBe("my-skill");
    expect(p.registry).toBe("reg-a");
    expect(p.branch).toBe("chore/update-skill-my-skill-1.2.3");
    expect(p.proposalId).toBe(proposalIdFor(1, ident(), "reg-a", f.value.targets));
    expect(p.fanout).toEqual({
      schemaVersion: 1,
      targets: [{ repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] }],
    });
  });

  test("filters to eligible targets for the selected registry", () => {
    const f = parseRegistryFanout({
      schemaVersion: 1,
      targets: [
        { repository: "a/repo", baseBranch: "main", registries: ["reg-a"] },
        { repository: "a/repo", baseBranch: "main", registries: ["reg-b"] },
      ],
    });
    if (!f.ok) throw new Error("fixture invalid");
    const forA = buildReleasePlans(f.value.targets, ident(), "skill-a");
    expect(forA).toHaveLength(1);
    expect(forA[0]?.registry).toBe("reg-a");
    const forB = buildReleasePlans(f.value.targets, ident({ registry: "reg-b" }), "skill-b");
    expect(forB).toHaveLength(1);
    expect(forB[0]?.registry).toBe("reg-b");
  });

  test("produces distinct plans and IDs across multiple registries", () => {
    const f = parseRegistryFanout({
      schemaVersion: 1,
      targets: [{ repository: "o/r", baseBranch: "main", registries: ["reg-a", "reg-b"] }],
    });
    if (!f.ok) throw new Error("fixture invalid");
    const a = buildReleasePlans(f.value.targets, ident(), "skill");
    const b = buildReleasePlans(f.value.targets, ident({ registry: "reg-b" }), "skill");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.registry).toBe("reg-a");
    expect(b[0]?.registry).toBe("reg-b");
    expect(a[0]?.proposalId).not.toBe(b[0]?.proposalId);
  });

  test("sorts repository then baseBranch deterministically", () => {
    const f = parseRegistryFanout({
      schemaVersion: 1,
      targets: [
        { repository: "zeta/z", baseBranch: "main", registries: ["reg-a"] },
        { repository: "alpha/a", baseBranch: "dev", registries: ["reg-a"] },
        { repository: "beta/b", baseBranch: "mid", registries: ["reg-a"] },
      ],
    });
    if (!f.ok) throw new Error("fixture invalid");
    const order = buildReleasePlans(f.value.targets, ident(), "s").map(
      (p) => `${p.target.repository}:${p.target.baseBranch}`,
    );
    expect(order).toEqual(["alpha/a:dev", "beta/b:mid", "zeta/z:main"]);
  });

  test("branch uses skillName distinct from registry ID", () => {
    const f = parseRegistryFanout(VALID_FANOUT);
    if (!f.ok) throw new Error("fixture invalid");
    const plans = buildReleasePlans(f.value.targets, ident(), "my.skill_name");
    const branch = plans[0]?.branch ?? "";
    expect(branch).toBe("chore/update-skill-my-skill-name-1.2.3");
    expect(branch).not.toContain("reg-a");
  });
});

describe("state transitions (#4)", () => {
  test("proposal permits only pending->running|rejected", () => {
    expect(setProposalState("pending", "running")).toBe(true);
    expect(setProposalState("pending", "rejected")).toBe(true);
    expect(setProposalState("pending", "completed")).toBe(false);
    expect(setProposalState("pending", "partial-failure")).toBe(false);
    expect(setProposalState("pending", "expired")).toBe(false);
    expect(setProposalState("pending", "pending")).toBe(false);
    expect(setProposalState("running", "completed")).toBe(false);
    expect(setProposalState("running", "rejected")).toBe(false);
    expect(setProposalState("rejected", "running")).toBe(false);
    expect(setProposalState("completed", "expired")).toBe(false);
  });

  test("target transitions only from pending into a non-pending state", () => {
    expect(setTargetState("pending", "not-eligible")).toBe(true);
    expect(setTargetState("pending", "already-current")).toBe(true);
    expect(setTargetState("pending", "existing-pr")).toBe(true);
    expect(setTargetState("pending", "drifted")).toBe(true);
    expect(setTargetState("pending", "verifying")).toBe(true);
    expect(setTargetState("pending", "pr-opened")).toBe(true);
    expect(setTargetState("pending", "failed")).toBe(true);
    expect(setTargetState("pending", "pending")).toBe(false);
    expect(setTargetState("not-eligible", "failed")).toBe(false);
    expect(setTargetState("failed", "pr-opened")).toBe(false);
  });
});

describe("toPublicProposal (#5)", () => {
  const base = () => ({
    id: "abc",
    skill: "my-skill",
    version: "1.2.3",
    state: "pending" as ProposalState,
    branch: "chore/update-skill-my-skill-1.2.3",
    target: { repository: "owner/repo", baseBranch: "main", registries: ["reg-a"] },
  });

  test("returns safe DTO with all exposed strings sanitized", () => {
    const dto = toPublicProposal({
      ...base(),
      id: "abc\u0001",
      skill: "my-skill\u0007",
      branch: "chore\u0000/update",
    });
    expect(dto.id).toBe("abc");
    expect(dto.skill).toBe("my-skill");
    expect(dto.branch).toBe("chore/update");
    expect(dto.target.repository).toBe("owner/repo");
  });

  test("sanitizes target fields including credentials and paths", () => {
    const dto = toPublicProposal({
      ...base(),
      target: {
        repository: "https://user:pass@example.com/x",
        baseBranch: "see /etc/passwd",
        registries: ["reg-a\u0001"],
      },
    });
    expect(dto.target.repository).toBe("https://example.com/x");
    expect(dto.target.baseBranch).toBe("see [redacted]");
    expect(dto.target.registries).toEqual(["reg-a"]);
  });

  test("bounds over-long exposed strings", () => {
    const dto = toPublicProposal({ ...base(), skill: "s".repeat(400) });
    expect(dto.skill.length).toBeLessThanOrEqual(256);
  });

  test("does not mutate the input target", () => {
    const input = base();
    toPublicProposal(input);
    expect(input.target.repository).toBe("owner/repo");
    expect(input.id).toBe("abc");
  });
});

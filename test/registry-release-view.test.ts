import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReleaseSnapshot } from "../src/skills/registry-release-executor.js";
import {
  type SnapshotReader,
  getReleaseProposal,
  listReleaseProposals,
} from "../src/skills/registry-release-view.js";
import {
  type FanoutTarget,
  type ProposalState,
  type ReleaseIdentity,
  type TargetState,
  buildReleasePlans,
  parseReleaseIdentity,
  proposalIdFor,
} from "../src/skills/registry-release.js";

const REPO = "/repo";
const DIR = join(REPO, ".vibeflow", "registry-release-proposals");
const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const DEFAULT_TARGETS: FanoutTarget[] = [
  { repository: "owner/one", baseBranch: "main", registries: ["reg-a"] },
];

interface FixtureOptions {
  version?: string;
  changelog?: string;
  state?: ProposalState;
  targets?: FanoutTarget[];
  statuses?: TargetState[];
}

function snapshot(options: FixtureOptions = {}): ReleaseSnapshot {
  const parsedIdentity = parseReleaseIdentity({
    fromOid: FROM,
    toOid: TO,
    version: options.version ?? "1.2.3",
    registry: "reg-a",
  });
  if (!parsedIdentity.ok) throw new Error(parsedIdentity.value);
  const identity: ReleaseIdentity = parsedIdentity.value;
  const targets = options.targets ?? DEFAULT_TARGETS;
  const id = proposalIdFor(1, identity, identity.registry, targets);
  const plans = buildReleasePlans(targets, identity, identity.registry).map((plan, index) => ({
    ...plan,
    status: options.statuses?.[index] ?? ("pending" as const),
  }));
  return {
    schemaVersion: 1,
    id,
    identity,
    changelog: options.changelog ?? "Ready",
    state: options.state ?? "pending",
    plans,
  };
}

function withPlanFields(value: ReleaseSnapshot, fields: Record<string, unknown>): unknown {
  return {
    ...value,
    plans: value.plans.map((plan, index) => (index === 0 ? { ...plan, ...fields } : plan)),
  };
}

function memoryReader(dirExists = true) {
  const files = new Map<string, string>();
  const entries: string[] = [];
  const reads: string[] = [];
  const reader: SnapshotReader = {
    exists: (path) => (path === DIR ? dirExists : files.has(path)),
    read: (path) => {
      reads.push(path);
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    readdir: () => entries,
  };
  const put = (value: unknown, filename: string) => {
    files.set(join(DIR, filename), JSON.stringify(value));
    entries.push(filename);
  };
  return { entries, files, put, reader, reads };
}

describe("listReleaseProposals", () => {
  test("returns [] when the proposals directory is missing or unreadable", () => {
    expect(listReleaseProposals(REPO, memoryReader(false).reader)).toEqual([]);

    const throwingReader: SnapshotReader = {
      exists: () => true,
      read: () => "",
      readdir: () => {
        throw new Error("EACCES");
      },
    };
    expect(listReleaseProposals(REPO, throwingReader)).toEqual([]);
  });

  test("returns [] for an empty proposals directory", () => {
    expect(listReleaseProposals(REPO, memoryReader().reader)).toEqual([]);
  });

  test("maps one valid snapshot to a summary", () => {
    const h = memoryReader();
    const value = snapshot({ state: "running" });
    h.put(value, `${value.id}.json`);

    expect(listReleaseProposals(REPO, h.reader)).toEqual([
      {
        id: value.id,
        registry: "reg-a",
        version: "1.2.3",
        state: "running",
        targetCount: 1,
      },
    ]);
  });

  test("skips a tampered snapshot while retaining a valid sibling", () => {
    const h = memoryReader();
    const valid = snapshot();
    const tampered = snapshot({ version: "2.0.0" });
    h.put({ ...tampered, extra: true }, `${tampered.id}.json`);
    h.put(valid, `${valid.id}.json`);

    expect(listReleaseProposals(REPO, h.reader).map(({ id }) => id)).toEqual([valid.id]);
  });

  test("skips a snapshot whose id differs from its filename", () => {
    const h = memoryReader();
    const value = snapshot();
    const filenameId = value.id === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    h.put(value, `${filenameId}.json`);

    expect(listReleaseProposals(REPO, h.reader)).toEqual([]);
  });

  test("ignores entries that do not match the lowercase 64-hex JSON filename", () => {
    const h = memoryReader();
    for (const filename of [
      "README.md",
      "abc.json",
      `${"A".repeat(64)}.json`,
      `${"a".repeat(64)}.txt`,
    ]) {
      h.put("not JSON", filename);
    }

    expect(listReleaseProposals(REPO, h.reader)).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  test("sorts summaries by id ascending regardless of directory order", () => {
    const h = memoryReader();
    const values = [snapshot({ version: "1.0.0" }), snapshot({ version: "2.0.0" })];
    for (const value of [...values].sort((a, b) => b.id.localeCompare(a.id))) {
      h.put(value, `${value.id}.json`);
    }

    expect(listReleaseProposals(REPO, h.reader).map(({ id }) => id)).toEqual(
      values.map(({ id }) => id).sort(),
    );
  });
});

describe("getReleaseProposal", () => {
  test("returns persisted evidence and PR URL in detail but not summary", () => {
    const h = memoryReader();
    const value = snapshot({ statuses: ["pr-opened"] });
    const evidence = "Verification passed";
    const prUrl = "https://github.com/owner/one/pull/42";
    h.put(withPlanFields(value, { evidence, prUrl }), `${value.id}.json`);

    expect(getReleaseProposal(REPO, value.id, h.reader)?.targets).toEqual([
      {
        repository: "owner/one",
        baseBranch: "main",
        status: "pr-opened",
        evidence,
        prUrl,
      },
    ]);
    const summaries = listReleaseProposals(REPO, h.reader);
    expect(summaries).toEqual([
      {
        id: value.id,
        registry: "reg-a",
        version: "1.2.3",
        state: "pending",
        targetCount: 1,
      },
    ]);
    expect(summaries[0]).not.toHaveProperty("evidence");
    expect(summaries[0]).not.toHaveProperty("prUrl");
  });

  test("omits evidence and PR URL keys for an older stored plan", () => {
    const h = memoryReader();
    const value = snapshot();
    h.put(value, `${value.id}.json`);

    const target = getReleaseProposal(REPO, value.id, h.reader)?.targets[0];
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty("evidence");
    expect(target).not.toHaveProperty("prUrl");
  });

  test("rejects invalid persisted result fields and unknown plan keys", () => {
    const prUrl = "https://github.com/owner/one/pull/42";
    const cases: [string, Record<string, unknown>][] = [
      ["overlong evidence", { evidence: "x".repeat(257) }],
      ["unsafe evidence", { evidence: "see /etc/passwd" }],
      ["non-GitHub PR URL", { status: "pr-opened", prUrl: "https://example.com/pull/42" }],
      ["PR URL on an ineligible status", { status: "pending", prUrl }],
      ["unknown plan key", { unexpected: true }],
    ];

    for (const [name, fields] of cases) {
      const h = memoryReader();
      const value = snapshot();
      h.put(withPlanFields(value, fields), `${value.id}.json`);

      expect(getReleaseProposal(REPO, value.id, h.reader), name).toBeNull();
      expect(listReleaseProposals(REPO, h.reader), name).toEqual([]);
    }
  });

  test("returns a bounded detail with full OIDs and one status per target", () => {
    const h = memoryReader();
    const targets: FanoutTarget[] = [
      { repository: "owner/one", baseBranch: "main", registries: ["reg-a"] },
      { repository: "owner/two", baseBranch: "stable", registries: ["reg-a"] },
    ];
    const value = snapshot({
      changelog: "x".repeat(300),
      targets,
      statuses: ["pending", "failed"],
    });
    h.put(value, `${value.id}.json`);

    expect(getReleaseProposal(REPO, value.id, h.reader)).toEqual({
      id: value.id,
      registry: "reg-a",
      version: "1.2.3",
      state: "pending",
      changelog: "x".repeat(256),
      fromOid: FROM,
      toOid: TO,
      targets: [
        { repository: "owner/one", baseBranch: "main", status: "pending" },
        { repository: "owner/two", baseBranch: "stable", status: "failed" },
      ],
    });
  });

  test("rejects a malformed id without reading", () => {
    const reader: SnapshotReader = {
      exists: () => {
        throw new Error("exists must not be called");
      },
      read: () => {
        throw new Error("read must not be called");
      },
      readdir: () => [],
    };

    expect(getReleaseProposal(REPO, "../proposal", reader)).toBeNull();
  });

  test("returns null for a missing id and a tampered snapshot", () => {
    const h = memoryReader();
    const missing = "0".repeat(64);
    expect(getReleaseProposal(REPO, missing, h.reader)).toBeNull();

    const value = snapshot();
    h.put({ ...value, extra: true }, `${value.id}.json`);
    expect(getReleaseProposal(REPO, value.id, h.reader)).toBeNull();
  });

  test("rejects an unsafe changelog instead of rewriting it", () => {
    const h = memoryReader();
    const value = snapshot({ changelog: "see /etc/passwd" });
    h.put(value, `${value.id}.json`);

    expect(listReleaseProposals(REPO, h.reader)).toEqual([]);
    expect(getReleaseProposal(REPO, value.id, h.reader)).toBeNull();
  });

  test("skips an entry whose read throws (list) and returns null when read throws (get)", () => {
    const value = snapshot();
    const file = `${value.id}.json`;
    const reader: SnapshotReader = {
      exists: () => true,
      read: () => {
        throw new Error("EIO");
      },
      readdir: () => [file],
    };
    expect(listReleaseProposals(REPO, reader)).toEqual([]);
    expect(getReleaseProposal(REPO, value.id, reader)).toBeNull();
  });

  test("returns null when the existence check itself throws (get)", () => {
    const value = snapshot();
    const reader: SnapshotReader = {
      exists: () => {
        throw new Error("EACCES");
      },
      read: () => "",
      readdir: () => [],
    };
    expect(getReleaseProposal(REPO, value.id, reader)).toBeNull();
  });
});

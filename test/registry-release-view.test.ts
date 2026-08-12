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
  const identity: ReleaseIdentity = {
    fromOid: FROM,
    toOid: TO,
    version: options.version ?? "1.2.3",
    registry: "reg-a",
  };
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

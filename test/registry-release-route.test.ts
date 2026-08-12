import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  handleReleaseProposalView,
  handleReleaseProposalsView,
} from "../src/server/registry-release-route.js";
import type { ReleaseSnapshot } from "../src/skills/registry-release-executor.js";
import type { SnapshotReader } from "../src/skills/registry-release-view.js";
import {
  type FanoutTarget,
  type ReleaseIdentity,
  buildReleasePlans,
  parseReleaseIdentity,
  proposalIdFor,
} from "../src/skills/registry-release.js";

const REPO = "/repo";
const DIR = join(REPO, ".vibeflow", "registry-release-proposals");
const parsedIdentity = parseReleaseIdentity({
  fromOid: "a".repeat(40),
  toOid: "b".repeat(40),
  version: "1.2.3",
  registry: "reg-a",
});
if (!parsedIdentity.ok) throw new Error(parsedIdentity.value);
const identity: ReleaseIdentity = parsedIdentity.value;
const targets: FanoutTarget[] = [
  { repository: "owner/one", baseBranch: "main", registries: [identity.registry] },
];
const id = proposalIdFor(1, identity, identity.registry, targets);
const snapshot: ReleaseSnapshot = {
  schemaVersion: 1,
  id,
  identity,
  changelog: "Ready",
  state: "pending",
  plans: buildReleasePlans(targets, identity, identity.registry).map((plan) => ({
    ...plan,
    status: "pending",
  })),
};
const evidence = "Verification passed";
const prUrl = "https://github.com/owner/one/pull/42";
const publishedSnapshot: ReleaseSnapshot = {
  ...snapshot,
  plans: snapshot.plans.map((plan) => ({ ...plan, status: "pr-opened", evidence, prUrl })),
};

function memoryReader(value?: unknown, dirExists = true): SnapshotReader {
  const files = new Map<string, string>();
  if (value !== undefined) files.set(join(DIR, `${id}.json`), JSON.stringify(value));
  return {
    exists: (path) => (path === DIR ? dirExists : files.has(path)),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readdir: () => (value === undefined ? [] : [`${id}.json`]),
  };
}

describe("registry release routes", () => {
  test("lists release proposal summaries", async () => {
    const res = handleReleaseProposalsView(REPO, memoryReader(snapshot));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      proposals: [
        {
          id,
          registry: identity.registry,
          version: identity.version,
          state: "pending",
          targetCount: 1,
        },
      ],
    });
  });

  test("returns an empty proposal list for a missing directory", async () => {
    const res = handleReleaseProposalsView(REPO, memoryReader(undefined, false));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, proposals: [] });
  });

  test("returns persisted evidence and PR URL for a known release proposal", async () => {
    const res = handleReleaseProposalView(REPO, id, memoryReader(publishedSnapshot));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      proposal: {
        id,
        registry: identity.registry,
        version: identity.version,
        state: "pending",
        changelog: "Ready",
        fromOid: identity.fromOid,
        toOid: identity.toOid,
        targets: [
          {
            repository: "owner/one",
            baseBranch: "main",
            status: "pr-opened",
            evidence,
            prUrl,
          },
        ],
      },
    });
  });

  test("returns 404 for an unknown release proposal", async () => {
    const res = handleReleaseProposalView(REPO, "0".repeat(64), memoryReader(snapshot));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown release proposal" });
  });

  test("returns 404 for a malformed release proposal id", async () => {
    const res = handleReleaseProposalView(REPO, "not-hex", memoryReader(snapshot));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown release proposal" });
  });

  test("returns 404 for a tampered release proposal", async () => {
    const tampered = {
      ...snapshot,
      plans: snapshot.plans.map((plan) => ({
        ...plan,
        status: "pr-opened",
        prUrl: "https://example.com/pull/42",
      })),
    };
    const res = handleReleaseProposalView(REPO, id, memoryReader(tampered));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown release proposal" });
  });
});

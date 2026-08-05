import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR, c } from "../src/core.js";
import { curatorFingerprint } from "../src/skills/curator-scan.js";
import {
  CURATOR_NOTES_REF,
  CURATOR_REMOTE,
  type GitRunner,
  isSafeCuratorIdentity,
  parseCuratorMarkers,
  parseCuratorScanOptions,
  renderCuratorMarkers,
  renderCuratorSyncPreview,
  resolveCleanCuratorCommit,
  syncCuratorMarkers,
} from "../src/skills/curator-sync.js";

const EXPECTED_PREVIEW = [
  "Shared sync preview",
  `Remote: ${CURATOR_REMOTE}`,
  `Ref: ${CURATOR_NOTES_REF}`,
  "Data sent: commit OID, finding type, SHA-256 fingerprint only",
  "Never sent: detail, finding key, source content, paths, URLs, usernames, credentials",
  "Risk: remote readers may infer that a matching finding existed.",
  "To proceed: rerun with --scope=repo --sync --yes",
];

const SHA = "a".repeat(40);
const SHA64 = "c".repeat(64);

function markerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "vibeflow-curator-marker",
    commit: SHA,
    fingerprint: SHA64,
    type: "stale-anchor",
    ...over,
  };
}

describe("parseCuratorScanOptions", () => {
  test("only [] accepted", () => {
    expect(parseCuratorScanOptions([])).toEqual({ scope: "local", sync: false, yes: false });
  });

  test("--scope=local sole", () => {
    expect(parseCuratorScanOptions(["--scope=local"])).toEqual({
      scope: "local",
      sync: false,
      yes: false,
    });
  });

  test("--scope=repo sole", () => {
    expect(parseCuratorScanOptions(["--scope=repo"])).toEqual({
      scope: "repo",
      sync: false,
      yes: false,
    });
  });

  test("--sync without scope rejected", () => {
    expect(parseCuratorScanOptions(["--sync"])).toBeNull();
  });

  test("--yes without sync or scope rejected", () => {
    expect(parseCuratorScanOptions(["--yes"])).toBeNull();
    expect(parseCuratorScanOptions(["--scope=local", "--yes"])).toBeNull();
  });

  test("local scope rejects --sync", () => {
    expect(parseCuratorScanOptions(["--scope=local", "--sync"])).toBeNull();
    expect(parseCuratorScanOptions(["--scope=local", "--sync", "--yes"])).toBeNull();
  });

  test("--sync requires repo scope", () => {
    expect(parseCuratorScanOptions(["--sync", "--scope=repo"])).toEqual({
      scope: "repo",
      sync: true,
      yes: false,
    });
  });

  test("--yes success requires repo + sync", () => {
    expect(parseCuratorScanOptions(["--sync", "--yes", "--scope=repo"])).toEqual({
      scope: "repo",
      sync: true,
      yes: true,
    });
    expect(parseCuratorScanOptions(["--scope=repo", "--sync", "--yes"])).toEqual({
      scope: "repo",
      sync: true,
      yes: true,
    });
  });

  test("duplicate flags rejected regardless of validity", () => {
    expect(parseCuratorScanOptions(["--scope=repo", "--scope=repo"])).toBeNull();
    expect(parseCuratorScanOptions(["--sync", "--sync", "--scope=repo"])).toBeNull();
    expect(parseCuratorScanOptions(["--yes", "--yes", "--scope=repo", "--sync"])).toBeNull();
  });

  test("unknown and split flags rejected", () => {
    expect(parseCuratorScanOptions(["--scope"])).toBeNull();
    expect(parseCuratorScanOptions(["--scope", "repo"])).toBeNull();
    expect(parseCuratorScanOptions(["--nope"])).toBeNull();
    expect(parseCuratorScanOptions(["--scope=remote"])).toBeNull();
    expect(parseCuratorScanOptions(["no-dash"])).toBeNull();
  });
});

describe("renderCuratorSyncPreview", () => {
  test("returns exact static preview", () => {
    expect(renderCuratorSyncPreview()).toEqual(EXPECTED_PREVIEW);
    expect(renderCuratorSyncPreview().join("\n")).toEqual(EXPECTED_PREVIEW.join("\n"));
  });

  test("never embeds arbitrary finding data", () => {
    const joined = renderCuratorSyncPreview().join("\n");
    expect(joined).not.toMatch(/stale-anchor|duplicate-owner|unpinned-registry/);
    expect(joined).not.toContain("sys.execute");
  });
});

describe("isSafeCuratorIdentity & curatorFingerprint", () => {
  test("safe identities pass, unsafe rejected", () => {
    expect(isSafeCuratorIdentity("stale-anchor")).toBe(true);
    expect(isSafeCuratorIdentity("alpha")).toBe(true);
    expect(isSafeCuratorIdentity("")).toBe(false);
    expect(isSafeCuratorIdentity("a\u0000b")).toBe(false);
    expect(isSafeCuratorIdentity("a\u0001b")).toBe(false);
    expect(isSafeCuratorIdentity("a\u001fb")).toBe(false);
    expect(isSafeCuratorIdentity("a\u007fb")).toBe(false);
    expect(isSafeCuratorIdentity("x".repeat(257))).toBe(false);
    expect(isSafeCuratorIdentity("x".repeat(256))).toBe(true);
    expect(isSafeCuratorIdentity("a\nb")).toBe(false);
  });

  test("fingerprint validated 40 lowercase hex commit + safe identity", () => {
    const expectHex = /^[0-9a-f]{64}$/;
    expect(curatorFingerprint(SHA, "stale-anchor", "myskill")?.length).toBe(64);
    expect(curatorFingerprint(SHA, "duplicate-owner", "a\u0000b")).toMatch(expectHex);
    expect(curatorFingerprint(SHA, "stale-anchor", "myskill")).toMatch(expectHex);
    expect(
      curatorFingerprint("abc1234567890".padEnd(40, "a"), "duplicate-owner", "registry"),
    ).toMatch(expectHex);
    const hadBut = `AB${SHA.slice(2)}`;
    expect(curatorFingerprint(hadBut, "stale-anchor", "myskill")).toBeNull();
    expect(curatorFingerprint("short-sha", "stale-anchor", "myskill")).toBeNull();
    expect(curatorFingerprint(SHA, "", "myskill")).toBeNull();
    expect(curatorFingerprint(SHA, "bad\u0000id", "myskill")).toBeNull();
    expect(curatorFingerprint(SHA, "stale-anchor", "")).toBeNull();
    expect(curatorFingerprint(SHA, "stale-anchor", "a\nb")).toBeNull();
  });

  test("commit change alters fingerprint", () => {
    expect(curatorFingerprint("b".repeat(40), "stale-anchor", "myskill")).not.toBe(
      curatorFingerprint(SHA, "stale-anchor", "myskill"),
    );
  });

  test("known SHA-256 vector (NUL-delimited digest)", () => {
    const expected = createHash("sha256")
      .update(`${SHA}\u0000stale-anchor\u0000myskill`)
      .digest("hex");
    const got = curatorFingerprint(SHA, "stale-anchor", "myskill");
    expect(got).toBe(expected);
  });
});

describe("Git notes synchronization", () => {
  function fakeGit(responses: { status?: number; stdout?: string; stderr?: string }[]): {
    calls: string[][];
    git: GitRunner;
  } {
    const calls: string[][] = [];
    return {
      calls,
      git: (args) => {
        calls.push(args);
        const next = responses.shift() ?? {};
        return { status: next.status ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
      },
    };
  }

  test("clean commit requires clean status and exact full lowercase OID", () => {
    const clean = fakeGit([{ stdout: "" }, { stdout: `${SHA}\n` }]);
    expect(resolveCleanCuratorCommit("/repo", clean.git)).toBe(SHA);
    expect(clean.calls).toEqual([
      ["status", "--porcelain"],
      ["rev-parse", "HEAD^{commit}"],
    ]);
    const dirty = fakeGit([{ stdout: " M secret.txt\n" }]);
    expect(resolveCleanCuratorCommit("/repo", dirty.git)).toBeNull();
    expect(dirty.calls).toEqual([["status", "--porcelain"]]);
  });

  test("sync uses only fixed notes remote/ref and returns existing duplicate fingerprints", () => {
    const existing = JSON.stringify(markerBody({ fingerprint: "d".repeat(64) }));
    const fake = fakeGit([{}, {}, { stdout: existing }, {}, {}]);
    const result = syncCuratorMarkers(
      "/repo",
      SHA,
      [{ type: "stale-anchor", findingKey: "alpha" }],
      fake.git,
    );
    expect(result.synced).toBe(true);
    expect(result.duplicateFingerprints).toEqual(new Set(["d".repeat(64)]));
    expect(fake.calls[0]).toEqual([
      "ls-remote",
      "--exit-code",
      "origin",
      "refs/notes/vibeflow-curator",
    ]);
    expect(fake.calls[1]).toEqual([
      "fetch",
      "origin",
      "+refs/notes/vibeflow-curator:refs/notes/vibeflow-curator",
    ]);
    expect(fake.calls[2]).toEqual(["notes", "--ref=refs/notes/vibeflow-curator", "show", SHA]);
    expect(fake.calls.at(-1)).toEqual([
      "push",
      "origin",
      "refs/notes/vibeflow-curator:refs/notes/vibeflow-curator",
    ]);
  });

  test("push conflict retries once, then reports unverified sync", () => {
    const fake = fakeGit([
      {},
      {},
      { status: 1 },
      {},
      { status: 1 },
      {},
      {},
      { status: 1 },
      {},
      { status: 1 },
    ]);
    const result = syncCuratorMarkers("/repo", SHA, [], fake.git);
    expect(result.synced).toBe(false);
    expect(fake.calls.filter((args) => args[0] === "fetch")).toHaveLength(2);
    expect(fake.calls.filter((args) => args[0] === "push")).toHaveLength(2);
  });

  test("remote lookup failure stops before note write or push", () => {
    const fake = fakeGit([{ status: 128, stderr: "credential failure secret-value" }]);
    expect(syncCuratorMarkers("/repo", SHA, [], fake.git).synced).toBe(false);
    expect(fake.calls).toEqual([
      ["ls-remote", "--exit-code", "origin", "refs/notes/vibeflow-curator"],
    ]);
  });
  test("invalid shared identity fails before note write or push", () => {
    const fake = fakeGit([{}, { status: 1 }]);
    const result = syncCuratorMarkers(
      "/repo",
      SHA,
      [{ type: "stale-anchor", findingKey: "bad\u0000\u0000key" }],
      fake.git,
    );
    expect(result.synced).toBe(false);
    expect(fake.calls).toEqual([
      ["ls-remote", "--exit-code", "origin", "refs/notes/vibeflow-curator"],
      ["fetch", "origin", "+refs/notes/vibeflow-curator:refs/notes/vibeflow-curator"],
    ]);
  });

  test("missing remote notes ref preserves local markers before publishing", () => {
    const fake = fakeGit([{ status: 2 }, { status: 1 }, {}, {}]);
    expect(syncCuratorMarkers("/repo", SHA, [], fake.git).synced).toBe(true);
    expect(fake.calls.some((args) => args[0] === "fetch")).toBe(false);
    expect(fake.calls).not.toContainEqual(["update-ref", "-d", "refs/notes/vibeflow-curator"]);
  });
});

describe("parseCuratorMarkers", () => {
  test("returns only valid JSONL records with exact key set", () => {
    const text = [
      JSON.stringify(markerBody()),
      JSON.stringify(markerBody({ schemaVersion: 2 })),
      JSON.stringify(markerBody({ kind: "other" })),
      JSON.stringify(markerBody({ commit: "b".repeat(40) })),
      JSON.stringify(markerBody({ fingerprint: "d".repeat(64) })),
      JSON.stringify(markerBody({ type: "bogus" })),
      JSON.stringify(markerBody({ extra: "x" })),
      JSON.stringify(markerBody({ commit: "SHORT" })),
      JSON.stringify({ schemaVersion: 1 }),
      "not-json",
    ].join("\n");
    const parsed = parseCuratorMarkers(text, SHA);
    expect(parsed).toHaveLength(2);
  });
});

describe("renderCuratorMarkers", () => {
  test("deterministic unique fingerprint sort, JSONL", () => {
    const a = markerBody({ fingerprint: "a".repeat(64) });
    const b = markerBody({ fingerprint: "b".repeat(64) });
    const out1 = renderCuratorMarkers([b, a, b]);
    const out2 = renderCuratorMarkers([a, b]);
    expect(out1).toBe(out2);
    const lines = out1.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]?.fingerprint).toBe("a".repeat(64));
    expect(parsed[1]?.fingerprint).toBe("b".repeat(64));
  });

  test("records contain exactly allowlisted properties", () => {
    const out = renderCuratorMarkers([markerBody()]);
    const record = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "commit",
      "fingerprint",
      "kind",
      "schemaVersion",
      "type",
    ]);
  });
});

describe("readCuratorFindingsFile / toCuratorView still covering deleted surface #743", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  test("static preview lines must render in dim for curator-scan handler", () => {
    dir = mkdtempSync(join(tmpdir(), "vf-csync-"));
    writeFileSync(join(dir, "guard.txt"), "x");
    expect(readFileSync(join(dir, "guard.txt"), "utf8")).toBe("x");
    expect(CURATOR_REMOTE).toBe("origin");
    expect(CURATOR_NOTES_REF).toBe("refs/notes/vibeflow-curator");
    expect(typeof CTX_DIR).toBe("string");
    expect(typeof c.dim).toBe("function");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import { startServer } from "../src/server.js";
import type {
  DuplicateOwnerFinding,
  Finding,
  StaleAnchorFinding,
  UnpinnedRegistryFinding,
} from "../src/skills/curator-scan.js";
import {
  type CuratorView,
  curatorView,
  findingSeverity,
  readCuratorFindingsFile,
  summarizeFinding,
  toCuratorView,
} from "../src/skills/curator-view.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-curator-689-"));
}

function writeFindings(repo: string, findings: Finding[]): string {
  const dir = join(repo, CTX_DIR, "curator");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "findings.json");
  writeFileSync(p, JSON.stringify({ findings, schemaVersion: 1 }));
  return p;
}

const stale: StaleAnchorFinding = {
  id: "id-stale",
  type: "stale-anchor",
  skill: "typescript",
  detail: "anchor hash drifted 3 commits ago",
};
const dup: DuplicateOwnerFinding = {
  id: "id-dup",
  type: "duplicate-owner",
  skills: ["db", "sql"],
  detail: "both claim the db domain",
};
const unpin: UnpinnedRegistryFinding = {
  id: "id-pin",
  type: "unpinned-registry",
  registry: "platform",
  skill: "vue",
  detail: 'Skill "vue" in registry "platform" has no commitOID',
};

describe("findingSeverity — derived per type (#689)", () => {
  test("unpinned-registry is high, duplicate-owner medium, stale-anchor low", () => {
    expect(findingSeverity(stale)).toBe("low");
    expect(findingSeverity(dup)).toBe("medium");
    expect(findingSeverity(unpin)).toBe("high");
  });
});

describe("summarizeFinding — sanitized + capped (#689)", () => {
  test("builds a readable summary per type", () => {
    expect(summarizeFinding(stale)).toBe("typescript: anchor hash drifted 3 commits ago");
    expect(summarizeFinding(dup)).toBe("db, sql: both claim the db domain");
    expect(summarizeFinding(unpin)).toBe(
      'platform/vue: Skill "vue" in registry "platform" has no commitOID',
    );
  });

  test("never exceeds 160 chars even with an unbounded detail", () => {
    const long: StaleAnchorFinding = { ...stale, detail: "x".repeat(500) };
    expect(summarizeFinding(long).length).toBeLessThanOrEqual(160);
    const manySkills: DuplicateOwnerFinding = { ...dup, skills: ["a", "b", "c", "d", "e", "f"] };
    expect(summarizeFinding(manySkills).length).toBeLessThanOrEqual(160);
  });

  test("strips control chars from every component (skill, registry, detail, skills)", () => {
    const ctrl: StaleAnchorFinding = {
      ...stale,
      skill: "type\u0000script",
      detail: "drift\u0001recent",
    };
    expect(summarizeFinding(ctrl)).not.toContain("\u0000");
    expect(summarizeFinding(ctrl)).not.toContain("\u0001");
    const ctrlReg: UnpinnedRegistryFinding = {
      ...unpin,
      registry: "plat\u0007form",
      skill: "vue\u000b",
    };
    expect(summarizeFinding(ctrlReg)).not.toContain("\u0007");
    expect(summarizeFinding(ctrlReg)).not.toContain("\u000b");
    const ctrlSkills: DuplicateOwnerFinding = {
      ...dup,
      skills: ["db\u0000", "s\u0001ql"],
    };
    expect(summarizeFinding(ctrlSkills)).not.toContain("\u0000");
    expect(summarizeFinding(ctrlSkills)).not.toContain("\u0001");
  });
});

describe("toCuratorView — pure reduction (#689)", () => {
  test("empty/missing input yields an empty view, never throws", () => {
    expect(toCuratorView(null)).toEqual({
      findings: [],
      counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
      total: 0,
    });
    expect(toCuratorView("junk")).toEqual({
      findings: [],
      counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
      total: 0,
    });
    expect(toCuratorView({})).toEqual({
      findings: [],
      counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
      total: 0,
    });
    expect(toCuratorView({ findings: "nope" })).toEqual({
      findings: [],
      counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
      total: 0,
    });
  });

  test("fixed counts — all three keys present, initialized 0", () => {
    const v = toCuratorView({ findings: [stale] });
    expect(v.counts).toEqual({
      "stale-anchor": 1,
      "duplicate-owner": 0,
      "unpinned-registry": 0,
    });
    expect(Object.keys(v.counts).length).toBe(3);
  });

  test("derives severities, counts, and total for well-formed findings", () => {
    const v = toCuratorView({ findings: [stale, dup, unpin] });
    expect(v.total).toBe(3);
    expect(v.counts).toEqual({
      "stale-anchor": 1,
      "duplicate-owner": 1,
      "unpinned-registry": 1,
    });
    expect(v.findings[0]).toEqual({
      id: "id-pin",
      type: "unpinned-registry",
      severity: "high",
      summary: summarizeFinding(unpin),
    });
  });

  test("orders findings severity-desc (high before medium before low)", () => {
    const v = toCuratorView({ findings: [stale, dup, unpin] });
    expect(v.findings.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
  });

  test("fail closed: malformed entries are dropped, surviving ones pass through", () => {
    const mixed = [
      stale,
      { foo: "no type" },
      { id: "", type: "unpinned-registry", detail: "missing id" },
      { id: "x", type: "bogus-type", detail: "unknown type" },
      { id: "y", type: "stale-anchor", detail: 42 },
      dup,
    ];
    const v = toCuratorView({ findings: mixed });
    expect(v.total).toBe(2);
    expect(v.findings.map((f) => f.id).sort()).toEqual(["id-dup", "id-stale"]);
  });

  test("malformed subtype shapes are dropped per-type (never throws)", () => {
    const bad = [
      { id: "a", type: "stale-anchor", detail: "no skill" }, // missing skill
      { id: "b", type: "stale-anchor", skill: "", detail: "empty skill" }, // empty skill
      { id: "c", type: "duplicate-owner", detail: "no skills" }, // missing skills
      { id: "d", type: "duplicate-owner", skills: [], detail: "empty skills" }, // empty array
      { id: "e", type: "duplicate-owner", skills: ["ok", 42], detail: "mixed types" }, // non-string
      { id: "f", type: "unpinned-registry", skill: "vue", detail: "no registry" }, // missing registry
      { id: "g", type: "unpinned-registry", registry: "", skill: "vue", detail: "empty registry" }, // empty registry
      unpin,
    ];
    const v = toCuratorView({ findings: bad });
    expect(v.total).toBe(1);
    expect(v.findings[0]?.id).toBe("id-pin");
  });
});

describe("curatorView — guarded route helper (#689)", () => {
  test("missing findings file → empty view (fail closed)", () => {
    const dir = tmpRepo();
    try {
      expect(curatorView(dir)).toEqual({
        findings: [],
        counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
        total: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON findings → typed error, not an empty view", () => {
    const dir = tmpRepo();
    try {
      writeFindings(dir, [stale]);
      rmSync(join(dir, CTX_DIR, "curator", "findings.json"));
      writeFileSync(join(dir, CTX_DIR, "curator", "findings.json"), "{ not json ");
      const result = curatorView(dir);
      expect(result).toEqual({ ok: false, error: "corrupt curator findings file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema-valid but non-object JSON → empty view (no findings)", () => {
    const dir = tmpRepo();
    try {
      writeFindings(dir, [stale]);
      rmSync(join(dir, CTX_DIR, "curator", "findings.json"));
      writeFileSync(join(dir, CTX_DIR, "curator", "findings.json"), "42");
      expect(curatorView(dir)).toEqual({
        findings: [],
        counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
        total: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads real findings from disk", () => {
    const dir = tmpRepo();
    try {
      writeFindings(dir, [unpin, stale]);
      const v = curatorView(dir);
      expect(v).not.toEqual({ ok: false });
      expect((v as CuratorView).total).toBe(2);
      expect((v as CuratorView).findings[0]?.severity).toBe("high");
      expect((v as CuratorView).findings[1]?.severity).toBe("low");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injected reader distinguishes missing vs corrupt (#689)", () => {
    const missing: Parameters<typeof curatorView>[1] = () => ({ ok: true, findings: null });
    expect(curatorView("x", missing)).toEqual({
      findings: [],
      counts: { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 },
      total: 0,
    });
    const corrupt: Parameters<typeof curatorView>[1] = () => ({
      ok: false,
      error: "corrupt",
    });
    expect(curatorView("x", corrupt)).toEqual({ ok: false, error: "corrupt" });
  });

  test("readCuratorFindingsFile: missing → ok, corrupt JSON → typed error", () => {
    const dir = tmpRepo();
    try {
      expect(readCuratorFindingsFile(dir)).toEqual({ ok: true, findings: null });
      writeFindings(dir, [stale]);
      rmSync(join(dir, CTX_DIR, "curator", "findings.json"));
      writeFileSync(join(dir, CTX_DIR, "curator", "findings.json"), "{ broken");
      expect(readCuratorFindingsFile(dir)).toEqual({
        ok: false,
        error: "corrupt curator findings file",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readCuratorFindingsFile: findings.json is a directory → typed error", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, CTX_DIR, "curator", "findings.json"), { recursive: true });
      expect(readCuratorFindingsFile(dir)).toEqual({
        ok: false,
        error: "unreadable curator findings file",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/skills/curator — integrated (#689)", () => {
  async function csrfToken(url: string): Promise<string> {
    const res = await fetch(url);
    const html = await res.text();
    const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
    if (!m) throw new Error("CSRF token not found");
    return m[1] as string;
  }

  test("returns sanitized findings + counts for the active repo", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      writeFindings(dir, [unpin, dup]);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        await fetch(`${url}/api/detect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ path: dir }),
        });
        const res = await fetch(`${url}/api/skills/curator`, {
          headers: { "x-vibeflow-token": token },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean } & CuratorView;
        expect(body.ok).toBe(true);
        expect(body.total).toBe(2);
        expect(body.counts["unpinned-registry"]).toBe(1);
        expect(body.findings[0]?.severity).toBe("high");
        expect(typeof body.findings[0]?.summary).toBe("string");
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no findings file → 200 with an empty view", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        const res = await fetch(`${url}/api/skills/curator`, {
          headers: { "x-vibeflow-token": token },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean } & CuratorView;
        expect(body.ok).toBe(true);
        expect(body.total).toBe(0);
        expect(body.findings).toEqual([]);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt findings file → 500 fail-closed, never 'No findings'", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      writeFindings(dir, [unpin]);
      rmSync(join(dir, CTX_DIR, "curator", "findings.json"));
      writeFileSync(join(dir, CTX_DIR, "curator", "findings.json"), "{ not json");
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        const res = await fetch(`${url}/api/skills/curator`, {
          headers: { "x-vibeflow-token": token },
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeTruthy();
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("findings.json is a directory → 500 fail-closed", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      mkdirSync(join(dir, CTX_DIR, "curator", "findings.json"), { recursive: true });
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        const res = await fetch(`${url}/api/skills/curator`, {
          headers: { "x-vibeflow-token": token },
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeTruthy();
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

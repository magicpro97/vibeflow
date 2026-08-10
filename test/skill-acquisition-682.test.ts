// #682 Phase B+C — pinned-registry acquisition proposals and approval gate.
// Candidate source ceiling: configured pinned registry caches only. Proposal
// construction is read-only (no network, no writes, no lock/cache mutation).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcquisitionApprover,
  AcquisitionDecision,
  ProposalBuildResult,
} from "../src/skills/acquisition.js";
import {
  buildAcquisitionProposals,
  findAcquisitionCandidates,
  runSkillAcquisitionGate,
} from "../src/skills/acquisition.js";
import { registryCacheDir, writeRegistryLock } from "../src/skills/registry-channel.js";
import type { SkillNeed } from "../src/skills/resolver.js";

const VALID_FM = [
  "---",
  "name: xlsx-reader",
  "version: 1.2.0",
  "description: Read xlsx files.",
  "---",
  "",
  "# xlsx-reader",
  "",
  "Body with enough actionable content to pass the 50-char threshold.",
].join("\n");

interface FixtureOpts {
  home?: string;
  lockRegistries?: Array<{ name: string; url: string; commitOID: string; skills: string[] }>;
  needs?: SkillNeed[];
  repo?: string;
  marketplaces?: Map<string, { name: string; version: string; status?: string; path?: string }[]>;
}

interface Fixture {
  repo: string;
  home: string;
  needs: SkillNeed[];
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-acq-"));
  dirs.push(d);
  return d;
}

function registryUrl(name: string): string {
  return `https://github.com/x/${name}.git`;
}

function makeFixture(opts: FixtureOpts = {}): Fixture {
  const repo = opts.repo ?? join(tmp(), "repo");
  const home = opts.home ?? join(tmp(), "home");
  mkdirSync(join(repo, ".vibeflow"), { recursive: true });

  const regs = opts.lockRegistries ?? [
    {
      name: "skills",
      url: registryUrl("skills"),
      commitOID: "a".repeat(40),
      skills: ["xlsx-reader"],
    },
  ];
  writeRegistryLock(
    repo,
    {
      schemaVersion: 1,
      registries: regs.map((r) => ({
        name: r.name,
        url: r.url,
        ref: "v1",
        commitOID: r.commitOID,
      })),
    },
    { writeFileSafe: (p: string, content: string) => writeFileSync(p, content) },
  );

  const mpSets =
    opts.marketplaces ??
    new Map<string, { name: string; version: string; status?: string; path?: string }[]>();
  for (const r of regs) {
    const cacheDir = registryCacheDir(r.url, { homedir: () => home });
    mkdirSync(cacheDir, { recursive: true });
    const skills: Array<{ name: string; version: string; status?: string; path?: string }> =
      mpSets.get(r.name) ??
      r.skills.map((name) => ({ name, version: "1.2.0", status: "verified" }));
    writeFileSync(join(cacheDir, "marketplace.json"), JSON.stringify({ schemaVersion: 1, skills }));
    for (const s of skills) {
      const sub = s.path ?? `skills/${s.name}`;
      mkdirSync(join(cacheDir, sub), { recursive: true });
      writeFileSync(
        join(cacheDir, sub, "SKILL.md"),
        VALID_FM.replace("xlsx-reader", s.name).replace("1.2.0", s.version),
      );
    }
  }

  const needs = opts.needs ?? [
    {
      need: "xlsx-reader",
      reason: "attachment data.xlsx",
      status: "missing",
      acquire: "vf discover skills xlsx --yes",
    } as SkillNeed,
  ];
  return { repo, home, needs };
}

function missingNeed(need: string, acquire?: string): SkillNeed {
  return {
    need,
    reason: `reason for ${need}`,
    status: "missing",
    acquire: acquire ?? `vf discover skills ${need} --yes`,
  };
}

function readDeps(home: string) {
  return { homedir: () => home };
}

describe("findAcquisitionCandidates", () => {
  test("ignores satisfied and available-unverified needs", () => {
    const f = makeFixture({
      needs: [
        { need: "a", reason: "r", status: "satisfied", satisfiedBy: "a" },
        { need: "b", reason: "r", status: "available-unverified", promote: "b" },
      ],
    });
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(res).toEqual([]);
  });

  test("finds exact name in one valid pinned registry cache", () => {
    const f = makeFixture();
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(res).toHaveLength(1);
    const r = res[0];
    expect(r?.state).toBe("proposal");
    if (r?.state === "proposal") {
      expect(r.proposal.name).toBe("xlsx-reader");
      expect(r.proposal.version).toBe("1.2.0");
      expect(r.proposal.need).toBe("xlsx-reader");
    }
  });

  test("returns immutable source/version/path fields", () => {
    const f = makeFixture();
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    const r = res[0];
    expect(r?.state).toBe("proposal");
    if (r?.state === "proposal") {
      expect(r.proposal.source.registryId).toBe("skills");
      expect(r.proposal.source.commitOID).toBe("a".repeat(40));
      expect(r.proposal.source.skillPath).toBe("skills/xlsx-reader");
      expect(r.proposal.version).toBe("1.2.0");
    }
  });

  test("zero match returns unresolved with existing acquire hint", () => {
    const f = makeFixture({ needs: [missingNeed("pdf-reader")] });
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({
      state: "unresolved",
      need: "pdf-reader",
      reason: "reason for pdf-reader",
      acquire: "vf discover skills pdf-reader --yes",
    });
  });

  test("duplicate exact matches return ambiguity and no proposal", () => {
    const f = makeFixture({
      lockRegistries: [
        {
          name: "one",
          url: registryUrl("one"),
          commitOID: "b".repeat(40),
          skills: ["xlsx-reader"],
        },
        {
          name: "two",
          url: registryUrl("two"),
          commitOID: "c".repeat(40),
          skills: ["xlsx-reader"],
        },
      ],
    });
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(res).toHaveLength(1);
    expect(res[0]?.state).toBe("ambiguous");
    if (res[0]?.state === "ambiguous") {
      expect(res[0].matches).toHaveLength(2);
    }
  });

  test("malformed lock, missing cache, or path escape fails closed", () => {
    const repo = join(tmp(), "repo");
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(
      repo,
      { schemaVersion: 1, registries: [] },
      { writeFileSafe: (p: string, c: string) => writeFileSync(p, c) },
    );
    const noCache = findAcquisitionCandidates(
      repo,
      [missingNeed("xlsx-reader")],
      readDeps(join(tmp(), "home")),
    );
    expect(noCache[0]?.state).toBe("unresolved");

    const f = makeFixture({
      marketplaces: new Map([
        [
          "skills",
          [{ name: "xlsx-reader", version: "1.2.0", status: "verified", path: "../escape" }],
        ],
      ]),
    });
    const escapedPath = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(escapedPath).toHaveLength(1);
    expect(escapedPath[0]?.state).toBe("unresolved");
  });

  test("deterministic proposal order", () => {
    const f = makeFixture({
      lockRegistries: [
        { name: "zz", url: registryUrl("zz"), commitOID: "d".repeat(40), skills: ["aaa-reader"] },
        { name: "aa", url: registryUrl("aa"), commitOID: "e".repeat(40), skills: ["aaa-reader"] },
      ],
      needs: [missingNeed("aaa-reader")],
    });
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    expect(res).toHaveLength(1);
    expect(res[0]?.state).toBe("ambiguous");
    if (res[0]?.state === "ambiguous") {
      expect(res[0].matches.map((m) => m.registryId)).toEqual(["aa", "zz"]);
    }
  });

  test("browser-safe bounded strings; no absolute path/URL/credentials", () => {
    const f = makeFixture();
    const res = findAcquisitionCandidates(f.repo, f.needs, readDeps(f.home));
    const r = res[0];
    expect(r?.state).toBe("proposal");
    if (r?.state === "proposal") {
      const json = JSON.stringify(r.proposal);
      expect(json).not.toContain(f.home);
      expect(json).not.toContain("github.com");
      expect(json).not.toContain(f.repo);
      expect(r.proposal.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("buildAcquisitionProposals returns unresolved list and proposals", () => {
    const f = makeFixture({ needs: [missingNeed("xlsx-reader"), missingNeed("pdf-reader")] });
    const result: ProposalBuildResult = buildAcquisitionProposals(
      f.repo,
      f.needs,
      readDeps(f.home),
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.unresolved).toEqual(["pdf-reader"]);
    expect(result.ambiguous).toEqual([]);
  });
});

describe("runSkillAcquisitionGate", () => {
  test("execute:false never calls approver or install", async () => {
    const f = makeFixture();
    let installCalls = 0;
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: false,
      install: () => {
        installCalls++;
        return 0;
      },
    });
    expect(installCalls).toBe(0);
    expect(gate.ok).toBe(true);
    expect(gate.installed).toEqual([]);
    expect(gate.unresolved).toEqual(["xlsx-reader"]);
    expect(gate.proposals).toHaveLength(1);
  });

  test("missing approver fails closed", async () => {
    const f = makeFixture();
    let installCalls = 0;
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      install: () => {
        installCalls++;
        return 0;
      },
    });
    expect(installCalls).toBe(0);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.unresolved).toContain("xlsx-reader");
  });

  test("missing approver records each proposal as rejected", async () => {
    const f = makeFixture();
    const events: Array<{ decision: string }> = [];
    await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      execute: true,
      readDeps: readDeps(f.home),
      recordDecisions: (recorded) => events.push(...recorded),
    });
    expect(events.map((event) => event.decision)).toEqual(["reject"]);
  });

  test("decisions for all proposals collected before first install", async () => {
    const f = makeFixture({
      needs: [missingNeed("xlsx-reader"), missingNeed("text-reader")],
      lockRegistries: [
        {
          name: "s",
          url: registryUrl("s"),
          commitOID: "a".repeat(40),
          skills: ["xlsx-reader", "text-reader"],
        },
      ],
    });
    const seen: string[][] = [];
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      approver: async (proposals) => {
        expect(proposals).toHaveLength(2);
        return new Map(proposals.map((p) => [p.id, "approve" as AcquisitionDecision]));
      },
      install: (_repo, _reg, name) => {
        const last = seen.at(-1) ?? [];
        seen.push([...last, name]);
        return 0;
      },
    });
    expect(seen).toHaveLength(2);
  });

  test("one reject causes zero installs", async () => {
    const f = makeFixture();
    let installCalls = 0;
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      approver: async () => new Map<string, AcquisitionDecision>(),
      install: () => {
        installCalls++;
        return 0;
      },
    });
    expect(installCalls).toBe(0);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.unresolved).toContain("xlsx-reader");
  });

  test("approved batch delegates exact version/source to registryInstall with yes:true, onCollision:skip, no review-proof", async () => {
    const f = makeFixture();
    const calls: Array<{ repo: string; reg: string; name: string; opts: Record<string, unknown> }> =
      [];
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      approver: async (proposals) => {
        const m = new Map<string, AcquisitionDecision>();
        for (const p of proposals) m.set(p.id, "approve");
        return m;
      },
      install: (repo, reg, name, opts) => {
        calls.push({ repo, reg, name, opts: opts as Record<string, unknown> });
        return 0;
      },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.repo).toBe(f.repo);
    expect(call?.reg).toBe("skills");
    expect(call?.name).toBe("xlsx-reader");
    expect(call?.opts.yes).toBe(true);
    expect(call?.opts.onCollision).toBe("skip");
    expect(call?.opts.version).toBe("1.2.0");
    expect(call?.opts.recordReview).toBeUndefined();
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.installed).toEqual(["xlsx-reader"]);
  });

  test("install failure stops batch and returns failure", async () => {
    const f = makeFixture({
      needs: [missingNeed("xlsx-reader"), missingNeed("text-reader")],
      lockRegistries: [
        {
          name: "s",
          url: registryUrl("s"),
          commitOID: "a".repeat(40),
          skills: ["xlsx-reader", "text-reader"],
        },
      ],
    });
    const attempts: string[] = [];
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      approver: async (proposals) =>
        new Map(proposals.map((p) => [p.id, "approve" as AcquisitionDecision])),
      install: (_repo, _reg, name) => {
        attempts.push(name);
        return 1;
      },
    });
    expect(attempts).toEqual(["text-reader"]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("text-reader");
    expect(gate.unresolved).toContain("xlsx-reader");
  });

  test("approved proposals skipped after an earlier install failure are not audited as rejects", async () => {
    const f = makeFixture({
      needs: [missingNeed("xlsx-reader"), missingNeed("text-reader")],
      lockRegistries: [
        {
          name: "s",
          url: registryUrl("s"),
          commitOID: "a".repeat(40),
          skills: ["xlsx-reader", "text-reader"],
        },
      ],
    });
    const events: Array<{ decision: string }> = [];
    await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      execute: true,
      readDeps: readDeps(f.home),
      approver: async (proposals) =>
        new Map(proposals.map((proposal) => [proposal.id, "approve" as const])),
      install: () => 1,
      recordDecisions: (recorded) => events.push(...recorded),
    });
    expect(events.map((event) => event.decision)).toEqual(["install-failed", "install-failed"]);
  });

  test("HIGH/CRITICAL scan blocks approval (non-approvable)", async () => {
    const f = makeFixture({
      marketplaces: new Map([
        ["skills", [{ name: "xlsx-reader", version: "1.2.0", status: "verified" }]],
      ]),
    });
    const scanner = () => ({
      scanned: true,
      risk_severity: "HIGH" as const,
      risk_score: 42,
      findings: [{ rule_id: "R1", message: "dangerous exec" }],
    });
    const result = buildAcquisitionProposals(f.repo, f.needs, {
      homedir: () => f.home,
      scanner: scanner as never,
    });
    expect(result.proposals[0]?.approvable).toBe(false);
    if (result.proposals[0]?.scan.state === "blocked") {
      expect(result.proposals[0].scan.highestSeverity).toBe("high");
      expect(result.proposals[0].scan.findings).toBe(1);
    }
    const gate = await runSkillAcquisitionGate({
      repo: f.repo,
      needs: f.needs,
      readDeps: readDeps(f.home),
      execute: true,
      scanner: scanner as never,
      approver: async (proposals) => {
        const m = new Map<string, AcquisitionDecision>();
        for (const p of proposals) m.set(p.id, "approve");
        return m;
      },
      install: () => 0,
    });
    expect(gate.ok).toBe(true);
  });

  test("scanner absent maps to bounded not-scanned", () => {
    const f = makeFixture();
    const result = buildAcquisitionProposals(f.repo, f.needs, readDeps(f.home));
    expect(result.proposals[0]?.scan.state).toBe("not-scanned");
    expect(result.proposals[0]?.approvable).toBe(true);
  });

  test("none/low/medium maps to approvable passed state", () => {
    const f = makeFixture();
    for (const sev of ["NONE", "LOW", "MEDIUM"] as const) {
      const result = buildAcquisitionProposals(f.repo, f.needs, {
        homedir: () => f.home,
        scanner: () => ({
          scanned: true,
          risk_severity: sev,
          risk_score: 1,
          findings: [],
        }),
      });
      const p = result.proposals[0];
      expect(p?.scan.state).toBe("passed");
      expect(p?.approvable).toBe(true);
    }
  });
});

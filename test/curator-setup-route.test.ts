import { describe, expect, test } from "bun:test";
import {
  CURATOR_SETUP_CONFIRMATION,
  buildCuratorWorkflow,
  curatorContentHash,
} from "../src/curator-setup.js";
import {
  applyCuratorSetup,
  curatorSetupDeps,
  previewCuratorSetup,
} from "../src/server/curator-setup-route.js";
import type { StoredSkillAuditEvent } from "../src/skills/audit-log.js";

const TARGET = ".github/workflows/skill-curator.yml";

interface RouteDeps {
  read: (repo: string) => string;
  write: (repo: string, rel: string, content: string) => boolean;
  audit: (event: Omit<StoredSkillAuditEvent, "ts">) => boolean;
  now: () => number;
}

interface Harness {
  readCalls: string[];
  writeCalls: { repo: string; rel: string }[];
  audited: Omit<StoredSkillAuditEvent, "ts">[];
  written: Map<string, string>;
  deps: RouteDeps;
  failWrite: boolean;
  failAudit: boolean;
}

function harness(current: Record<string, string> = {}, now = 1000): Harness {
  const disk = new Map<string, string>(Object.entries(current));
  const readCalls: string[] = [];
  const writeCalls: { repo: string; rel: string }[] = [];
  const audited: Omit<StoredSkillAuditEvent, "ts">[] = [];
  const h: Harness = {
    readCalls,
    writeCalls,
    audited,
    written: disk,
    failWrite: false,
    failAudit: false,
    deps: {
      read: (repo) => {
        readCalls.push(repo);
        return disk.get(`${repo}::${TARGET}`) ?? ""; // "" = absent/missing file
      },
      write: (repo, rel, content) => {
        writeCalls.push({ repo, rel });
        if (h.failWrite) return false;
        disk.set(`${repo}::${rel}`, content);
        return true;
      },
      audit: (event) => {
        audited.push(event);
        return !h.failAudit;
      },
      now: () => now,
    },
  };
  return h;
}

async function preview(h: Harness, repo = "repo-a") {
  return previewCuratorSetup(repo, {}, { read: h.deps.read, now: h.deps.now });
}

function apply(h: Harness, repo: string, previewId: string, currentHash: string) {
  return applyCuratorSetup(
    repo,
    { previewId, currentHash, confirmationText: CURATOR_SETUP_CONFIRMATION },
    h.deps,
  );
}

describe("previewCuratorSetup — read-only, exact diff #693", () => {
  test("default dependency fallbacks handle missing/read-only target", () => {
    const d = curatorSetupDeps();
    expect(d.read("/definitely/missing/repo", TARGET)).toBe("");
    expect(d.write("/definitely/missing/repo", TARGET, "x")).toBe(false);
  });

  test("invalid Request JSON returns 400", async () => {
    const h = harness();
    const res = await previewCuratorSetup(
      "repo-a",
      new Request("http://localhost", { method: "POST", body: "[" }),
      { read: h.deps.read, now: h.deps.now },
    );
    expect(res.status).toBe(400);
  });
  test("read failure returns 500", async () => {
    const res = await previewCuratorSetup(
      "repo-a",
      {},
      {
        read: () => {
          throw new Error("read");
        },
        now: Date.now,
      },
    );
    expect(res.status).toBe(500);
  });
  test("new file: 200 with opaque preview id + exact unified diff", async () => {
    const h = harness();
    const res = await preview(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      target: string;
      existing: boolean;
      currentHash: string;
      diff: string;
      confirmation: string;
    };
    expect(body.id).toBeTruthy();
    expect(body.id).not.toContain(" ");
    expect(body.target).toBe(TARGET);
    expect(body.existing).toBe(false);
    expect(body.currentHash).toBe(curatorContentHash(""));
    expect(body.confirmation).toBe(CURATOR_SETUP_CONFIRMATION);
    expect(body.diff).toContain("--- /dev/null");
    expect(body.diff).toContain(`+++ b/${TARGET}`);
    expect(body.diff).toContain("+name: Skill Curator Weekly Report");
  });

  test("preview is read-only — never calls write", async () => {
    const h = harness();
    await preview(h);
    expect(h.writeCalls).toEqual([]);
  });

  test("existing file: surfaces exact diff against current content, existing=true", async () => {
    const existing = "name: Old Report\n";
    const h = harness({ [`repo-a::${TARGET}`]: existing });
    const res = await preview(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      existing: boolean;
      currentHash: string;
      diff: string;
    };
    expect(body.existing).toBe(true);
    expect(body.currentHash).toBe(curatorContentHash(existing));
    expect(body.diff).toContain("--- a/.github/workflows/skill-curator.yml");
    expect(body.diff).toContain("-name: Old Report");
    expect(body.diff).toContain("+name: Skill Curator Weekly Report");
  });

  test("stale/changed target between preview and apply → apply rejected", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const conflicted = apply(h, "repo-a", body.id, curatorContentHash("someone-changed-it"));
    expect(conflicted.status).toBe(409);
    expect((await conflicted.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/changed/i),
    });
    expect(h.writeCalls).toEqual([]);
  });

  test("wrong confirmation text → apply rejected, target untouched", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const out = applyCuratorSetup(
      "repo-a",
      { previewId: body.id, currentHash: body.currentHash, confirmationText: "nope" },
      h.deps,
    );
    expect(out.status).toBe(400);
    expect(h.writeCalls).toEqual([]);
  });

  test("consumed preview cannot be reused", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const first = apply(h, "repo-a", body.id, body.currentHash);
    expect(first.status).toBe(200);
    const second = apply(h, "repo-a", body.id, body.currentHash);
    expect(second.status).toBe(409);
    expect(h.writeCalls.length).toBe(1);
  });

  test("unknown preview id returns 400", () => {
    const h = harness();
    const out = applyCuratorSetup(
      "repo-a",
      {
        previewId: "missing",
        currentHash: curatorContentHash(""),
        confirmationText: CURATOR_SETUP_CONFIRMATION,
      },
      h.deps,
    );
    expect(out.status).toBe(400);
  });
});

describe("applyCuratorSetup — creates exact file + local audit evidence #693", () => {
  test("writes exactly the previewed workflow to the canonical target", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const out = apply(h, "repo-a", body.id, body.currentHash);
    expect(out.status).toBe(200);
    const written = h.written.get(`repo-a::${TARGET}`);
    expect(written).toBe(buildCuratorWorkflow());
    expect(h.writeCalls).toEqual([{ repo: "repo-a", rel: TARGET }]);
    expect(written?.startsWith("name: Skill Curator Weekly Report")).toBe(true);
  });

  test("overwrites an existing file when explicitly confirmed — exact diff state", async () => {
    const existing = "name: Old Report\n";
    const h = harness({ [`repo-a::${TARGET}`]: existing });
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const out = apply(h, "repo-a", body.id, body.currentHash);
    expect(out.status).toBe(200);
    expect(h.written.get(`repo-a::${TARGET}`)).toBe(buildCuratorWorkflow());
  });

  test("appendSkillAudit says no → rollback to prior content + 409", async () => {
    const h = harness({ [`repo-a::${TARGET}`]: "old\n" });
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    h.failAudit = true;
    const out = apply(h, "repo-a", body.id, body.currentHash);
    expect(out.status).not.toBe(200);
    expect(h.written.get(`repo-a::${TARGET}`)).toBe("old\n");
  });

  test("write failure → 500, no audit", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    h.failWrite = true;
    const out = apply(h, "repo-a", body.id, body.currentHash);
    expect(out.status).toBe(500);
    expect(h.audited).toEqual([]);
  });

  test("audit evidence: action curator-setup, evidence has preview id, NO file content", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    apply(h, "repo-a", body.id, body.currentHash);
    expect(h.audited.length).toBe(1);
    const ev = h.audited[0];
    if (!ev) throw new Error("no audit");
    expect(ev.action).toBe("curator-setup");
    expect(ev.actor).toBe("human");
    expect(ev.evidence[0]).toBe(`preview:${body.id}`);
    expect(ev.evidence.some((e) => e.startsWith("preview:"))).toBe(true);
    expect(ev.reason).toContain("curator CI workflow");
    for (const e of ev.evidence) {
      expect(e).not.toContain(buildCuratorWorkflow().slice(0, 40));
      expect(e).not.toContain("GITHUB_TOKEN");
    }
  });

  test("audit failure with rollback failure returns 500", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    h.failAudit = true;
    let writes = 0;
    const out = applyCuratorSetup(
      "repo-a",
      {
        previewId: body.id,
        currentHash: body.currentHash,
        confirmationText: CURATOR_SETUP_CONFIRMATION,
      },
      {
        ...h.deps,
        write: () => {
          writes++;
          return writes < 2;
        },
      },
    );
    expect(out.status).toBe(500);
  });

  test("rejects traversal or wrong target in payload — server-supplied target wins", async () => {
    const h = harness();
    const res = await preview(h);
    const body = (await res.json()) as { id: string; currentHash: string };
    const out = applyCuratorSetup(
      "repo-a",
      {
        previewId: body.id,
        currentHash: body.currentHash,
        confirmationText: CURATOR_SETUP_CONFIRMATION,
        target: "../../evil.yml",
      },
      h.deps,
    );
    expect(out.status).toBe(400);
    expect(h.writeCalls).toEqual([]);
  });

  test("target read failure returns 500", () => {
    const h = harness();
    const out = applyCuratorSetup(
      "repo-a",
      { previewId: "x", currentHash: "x", confirmationText: CURATOR_SETUP_CONFIRMATION },
      {
        ...h.deps,
        read: () => {
          throw new Error("read");
        },
      },
    );
    expect(out.status).toBe(500);
  });
});

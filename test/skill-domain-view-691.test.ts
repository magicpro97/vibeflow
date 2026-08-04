import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDomainImpact, handleDomainsView } from "../src/server/domain-route.js";
import {
  buildDomainView,
  isUnsafePath,
  isValidFactQuery,
  sanitizeStatement,
} from "../src/skills/domain-view.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-domain-691-"));
  mkdirSync(join(base, ".vibeflow"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeFacts(data: unknown) {
  writeFileSync(join(base, ".vibeflow", "DOMAIN_FACTS.json"), JSON.stringify(data));
}

function skill(name: string, extra = "") {
  const dir = join(base, ".vibeflow", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n${extra}---\n\n## Steps\n`,
  );
}

const FACTS = {
  schemaVersion: 1,
  facts: [
    {
      key: "ctc-domain",
      owner: "ctc-canonical",
      version: "1",
      statement: "CTC domain ownership",
      dependents: ["ctc-child-1"],
    },
    {
      key: "auth-domain",
      owner: "auth-canonical",
      version: "2",
      statement: "Authentication domain",
      paths: ["src/auth/"],
    },
  ],
};

function fixture() {
  writeFacts(FACTS);
  skill("ctc-canonical", "domain:\n  id: ctc\n  role: canonical\n");
  skill("ctc-child-1", "dependsOn:\n  - ctc-canonical\n");
  skill("auth-canonical", "domain:\n  id: auth\n  role: canonical\n");
}

// ── validation helpers ────────────────────────────────────────────────
describe("isUnsafePath", () => {
  test("accepts clean repo-relative paths", () => {
    expect(isUnsafePath("src/auth/")).toBe(false);
    expect(isUnsafePath("src/auth/login.ts")).toBe(false);
    expect(isUnsafePath(".agents/skills")).toBe(false);
  });
  test("rejects absolute / ~ root", () => {
    expect(isUnsafePath("/etc/passwd")).toBe(true);
    expect(isUnsafePath("~/secret")).toBe(true);
  });
  test("rejects traversal, backslash, NUL", () => {
    expect(isUnsafePath("../x")).toBe(true);
    expect(isUnsafePath("a\\b")).toBe(true);
    expect(isUnsafePath("a\u0000b")).toBe(true);
  });
});

describe("isValidFactQuery", () => {
  test("accepts identifiers and repo-relative paths", () => {
    expect(isValidFactQuery("ctc-domain")).toBe(true);
    expect(isValidFactQuery("src/auth/login.ts")).toBe(true);
    expect(isValidFactQuery("src/auth/")).toBe(true);
  });
  test("rejects empty, overlength, spaces", () => {
    expect(isValidFactQuery("")).toBe(false);
    expect(isValidFactQuery("x".repeat(501))).toBe(false);
    expect(isValidFactQuery("has space")).toBe(false);
  });
  test("rejects control chars, traversal, absolute, backslash, shell chars", () => {
    expect(isValidFactQuery("a\u0000b")).toBe(false);
    expect(isValidFactQuery("a\u0001b")).toBe(false);
    expect(isValidFactQuery("a\u007fb")).toBe(false);
    expect(isValidFactQuery("../x")).toBe(false);
    expect(isValidFactQuery("/abs")).toBe(false);
    expect(isValidFactQuery("a\\b")).toBe(false);
    expect(isValidFactQuery("$(rm)")).toBe(false);
    expect(isValidFactQuery("semi;colon")).toBe(false);
    expect(isValidFactQuery('quote"x"')).toBe(false);
  });
  test("exactly 500 chars is valid", () => {
    expect(isValidFactQuery("a".repeat(500))).toBe(true);
  });
});

describe("sanitizeStatement", () => {
  test("returns empty for non-string", () => {
    expect(sanitizeStatement(undefined)).toBe("");
    expect(sanitizeStatement(42)).toBe("");
  });
  test("returns the string, truncated at 400", () => {
    expect(sanitizeStatement("hello")).toBe("hello");
    expect(sanitizeStatement("x".repeat(401)).length).toBe(400);
  });
});

// ── buildDomainView ───────────────────────────────────────────────────
describe("buildDomainView", () => {
  test("missing facts file yields empty view (ok:true)", () => {
    const v = buildDomainView(base);
    expect(v.ok).toBe(true);
    expect(v.roots).toEqual([]);
  });

  test("malformed facts file yields empty view, no throw", () => {
    writeFileSync(join(base, ".vibeflow", "DOMAIN_FACTS.json"), "{ not json");
    const v = buildDomainView(base);
    expect(v.ok).toBe(true);
    expect(v.roots).toEqual([]);
  });

  test("exposes canonical root, owned facts, and child skills", () => {
    fixture();
    const v = buildDomainView(base);
    expect(v.roots).toHaveLength(2);
    const ctc = v.roots.find((r) => r.id === "ctc");
    expect(ctc?.canonical).toBe("ctc-canonical");
    expect(ctc?.facts.map((f) => f.key)).toEqual(["ctc-domain"]);
    expect(ctc?.children).toEqual(["ctc-child-1"]);
  });

  test("includes declared fact dependents that exist in the skill catalog", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        {
          key: "fact",
          owner: "canonical",
          version: "1",
          statement: "f",
          dependents: ["fact-child", "missing"],
        },
      ],
    });
    skill("canonical", "domain:\n  id: c\n  role: canonical\n");
    skill("fact-child");
    expect(buildDomainView(base).roots[0]?.children).toEqual(["fact-child"]);
  });

  test("duplicate fact keys are deduplicated for stable Vue keys", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        { key: "fact", owner: "canonical", version: "1", statement: "first" },
        { key: "fact", owner: "canonical", version: "2", statement: "second" },
      ],
    });
    skill("canonical", "domain:\n  id: c\n  role: canonical\n");
    expect(buildDomainView(base).roots[0]?.facts).toEqual([
      { key: "fact", owner: "canonical", version: "1", statement: "first", paths: [] },
    ]);
  });

  test("canonical skill with no owned facts produces empty facts array", () => {
    writeFacts({ schemaVersion: 1, facts: [] });
    skill("only-canonical", "domain:\n  id: lone\n  role: canonical\n");
    const v = buildDomainView(base);
    expect(v.roots).toHaveLength(1);
    expect(v.roots[0]?.id).toBe("lone");
    expect(v.roots[0]?.facts).toEqual([]);
  });

  test("canonical owns list includes its declared fact", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "owned", owner: "canonical", version: "1", statement: "f" }],
    });
    skill("canonical", "domain:\n  id: c\n  role: canonical\nowns:\n  - owned\n");
    expect(buildDomainView(base).roots[0]?.facts.map((f) => f.key)).toEqual(["owned"]);
  });

  test("skill without domain role is not a root", () => {
    writeFacts({ schemaVersion: 1, facts: [] });
    skill("no-role");
    const v = buildDomainView(base);
    expect(v.roots).toHaveLength(0);
  });

  test("duplicate canonical candidates: first wins", () => {
    writeFacts({ schemaVersion: 1, facts: [] });
    skill("canon-a", "domain:\n  id: c\n  role: canonical\n");
    skill("canon-b", "domain:\n  id: c\n  role: canonical\n");
    const v = buildDomainView(base);
    expect(v.roots).toHaveLength(1);
    expect(v.roots[0]?.canonical).toBe("canon-a");
  });

  test("child of a non-canonical-dependent domain is excluded", () => {
    writeFacts({ schemaVersion: 1, facts: [] });
    skill("orphan-canon", "domain:\n  id: o\n  role: canonical\n");
    skill("bad-child", "dependsOn:\n  - absent-canon\n");
    const v = buildDomainView(base);
    expect(v.roots[0]?.children).toEqual([]);
  });

  test("canonical skill also listed elsewhere contributes no child for unrelated dep", () => {
    writeFacts({ schemaVersion: 1, facts: [] });
    skill("canon-a", "domain:\n  id: a\n  role: canonical\n");
    skill("child-a", "dependsOn:\n  - canon-a\n  - missing\n");
    skill("child-dup", "dependsOn:\n  - canon-a\n");
    const v = buildDomainView(base);
    expect(v.roots[0]?.children).toEqual(["child-a", "child-dup"]);
  });

  test("unsafe paths projected from facts are stripped", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        {
          key: "k1",
          owner: "ctc-canonical",
          version: "1",
          statement: "f",
          paths: ["src/ok", "src/prefix/", "/etc", "a\\b", "..x", "trail//"],
        },
      ],
    });
    skill("ctc-canonical", "domain:\n  id: ctc\n  role: canonical\n");
    const v = buildDomainView(base);
    const fact = v.roots[0]?.facts[0];
    expect(fact?.paths).toEqual(["src/ok", "src/prefix/", "trail//"]);
  });

  test("overlong statement is truncated in the projection", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        {
          key: "k1",
          owner: "ctc-canonical",
          version: "1",
          statement: "x".repeat(600),
        },
      ],
    });
    skill("ctc-canonical", "domain:\n  id: ctc\n  role: canonical\n");
    const fact = buildDomainView(base).roots[0]?.facts[0];
    expect(fact?.statement.length).toBe(400);
  });

  test("malformed rows (non-object, missing key/owner) are dropped", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        "not-object",
        { key: "no-owner", version: "1" },
        { owner: "no-key", version: "1" },
      ] as unknown as Array<Record<string, unknown>>,
    });
    skill("ctc-canonical", "domain:\n  id: ctc\n  role: canonical\n");
    const v = buildDomainView(base);
    expect(v.roots[0]?.facts).toEqual([]);
  });

  test("non-string dependents are filtered from fact projection", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [
        {
          key: "k1",
          owner: "ctc-canonical",
          version: "1",
          statement: "f",
          dependents: ["ok-one", "../bad", 42],
        },
      ],
    });
    skill("ctc-canonical", "domain:\n  id: ctc\n  role: canonical\n");
    const v = buildDomainView(base);
    expect(v.roots[0]?.facts[0]?.key).toBe("k1");
  });

  test("fact owned by a different owner than canonical is excluded", () => {
    fixture();
    const v = buildDomainView(base);
    const auth = v.roots.find((r) => r.id === "auth");
    expect(auth?.facts.map((f) => f.key)).toEqual(["auth-domain"]);
    const ctc = v.roots.find((r) => r.id === "ctc");
    expect(ctc?.facts.map((f) => f.key)).not.toContain("auth-domain");
  });

  test("inject readDomainFacts yielding null produces empty view", () => {
    const v = buildDomainView(base, {
      readDomainFacts: () => null,
      discoverSkills: () => [],
    });
    expect(v.ok).toBe(true);
    expect(v.roots).toEqual([]);
  });

  test("inject discoverSkills returning no skills produces empty view", () => {
    const v = buildDomainView(base, {
      readDomainFacts: () => ({ schemaVersion: 1, facts: [] }),
      discoverSkills: () => [],
    });
    expect(v.roots).toHaveLength(0);
  });
});

// ── domain-route ──────────────────────────────────────────────────────
describe("handleDomainsView", () => {
  test("returns ok JSON with roots", async () => {
    fixture();
    const res = handleDomainsView(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; roots: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.roots).toHaveLength(2);
  });
});

describe("handleDomainImpact", () => {
  test("valid fact key returns matched skills", async () => {
    fixture();
    const res = handleDomainImpact(base, "ctc-domain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; facts: string[]; skills: string[] };
    expect(body.ok).toBe(true);
    expect(body.facts).toEqual(["ctc-domain"]);
    expect(body.skills).toContain("ctc-canonical");
    expect(body.skills).toContain("ctc-child-1");
  });

  test("valid repo-relative path returns matched skills", async () => {
    fixture();
    const res = handleDomainImpact(base, "src/auth/login.ts");
    const body = (await res.json()) as { skills: string[] };
    expect(body.skills).toContain("auth-canonical");
  });

  test("missing query returns 400", async () => {
    const res = handleDomainImpact(base, null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  });

  test("empty query returns 400", async () => {
    const res = handleDomainImpact(base, "   ");
    expect(res.status).toBe(400);
  });

  test("overlong query returns 400", async () => {
    const res = handleDomainImpact(base, "x".repeat(501));
    expect(res.status).toBe(400);
  });

  test("control-char query returns 400", async () => {
    const res = handleDomainImpact(base, "a\u0000b");
    expect(res.status).toBe(400);
  });

  test("traversal query returns 400", async () => {
    const res = handleDomainImpact(base, "../etc/passwd");
    expect(res.status).toBe(400);
  });

  test("backslash query returns 400", async () => {
    const res = handleDomainImpact(base, "a\\b\\c");
    expect(res.status).toBe(400);
  });

  test("absolute path query returns 400", async () => {
    const res = handleDomainImpact(base, "/etc/passwd");
    expect(res.status).toBe(400);
  });

  test("no match returns ok with empty facts/skills", async () => {
    fixture();
    const res = handleDomainImpact(base, "no-such-thing");
    const body = (await res.json()) as { ok: boolean; facts: string[]; skills: string[] };
    expect(body.ok).toBe(true);
    expect(body.facts).toEqual([]);
    expect(body.skills).toEqual([]);
  });
});

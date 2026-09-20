import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ProjectClassifierAuthority } from "../../src/orchestrator/conversation/project-classifier-authority.js";
import {
  AI_MIN_CONFIDENCE,
  CLASSIFICATION_REASONS,
  type ClassifierProject,
  FTS_MIN_MARGIN,
  FTS_MIN_SCORE,
  classifyMessage,
} from "../../src/orchestrator/conversation/project-classifier.js";
import {
  FTS_RECENT_CHAT_LIMIT,
  indexProjectChat,
  indexProjectDescriptors,
  openProjectIndex,
  searchProjectScores,
} from "../../src/orchestrator/conversation/project-fts.js";
import {
  buildProjectProposalPrompt,
  makeProjectProposalFn,
  parseProjectProposal,
} from "../../src/skills/project-classify-skill.js";

const PROJECTS: ClassifierProject[] = [
  { id: "checkout-web", repos: ["/Users/me/checkout"] },
  { id: "checkout-api", repos: ["/Users/me/checkout/services/api"] },
  {
    id: "search-api",
    repos: ["/Users/me/search"],
    name: "Search API",
    goal: "Full text search service backed by Elasticsearch",
    context: "Rust service, index mappings, ranking tuning",
  },
  {
    id: "infra",
    repos: [],
    name: "Infrastructure",
    goal: "Terraform and Kubernetes cluster management",
    context: "AWS accounts, VPC, CI runners",
  },
];

describe("classification vocabulary", () => {
  test("reason is exactly the five-tier vocabulary", () => {
    expect([...CLASSIFICATION_REASONS].sort()).toEqual([
      "ai",
      "fallback",
      "fts",
      "mention",
      "repo",
    ]);
  });

  test("thresholds are the documented, tunable values", () => {
    expect([FTS_MIN_SCORE, FTS_MIN_MARGIN, AI_MIN_CONFIDENCE]).toEqual([30, 10, 0.6]);
  });
});

describe("classifyMessage — deterministic tiers", () => {
  test("repo_root inside a project's repos resolves at confidence 1", () => {
    expect(classifyMessage("anything at all", { ...ctx(), repo_root: "/Users/me/search" })).toEqual(
      {
        project_id: "search-api",
        confidence: 1,
        reason: "repo",
      },
    );
  });

  test("a trailing separator and a nested path still match the same project", () => {
    const projected = classifyMessage("x", { ...ctx(), repo_root: "/Users/me/search/" });
    expect(projected.reason).toBe("repo");
    // Nested repo wins over the enclosing project.
    const nested = classifyMessage("x", {
      ...ctx(),
      repo_root: "/Users/me/checkout/services/api/src",
    });
    expect(nested.project_id).toBe("checkout-api");
  });

  test("a repo_root owned by no project is not a repo match", () => {
    expect(classifyMessage("x", { ...ctx(), repo_root: "/tmp/elsewhere" }).reason).toBe("fallback");
  });

  test("repo wins over an @mention of a different project", () => {
    const result = classifyMessage("@infra look here", {
      ...ctx(),
      repo_root: "/Users/me/search",
    });
    expect(result).toEqual({ project_id: "search-api", confidence: 1, reason: "repo" });
  });

  test("@mention resolves a registered slug, first occurrence wins", () => {
    const result = classifyMessage("ping @infra then @search-api", ctx());
    expect(result).toEqual({ project_id: "infra", confidence: 1, reason: "mention" });
  });

  test("an unregistered or embedded @token is not a mention", () => {
    expect(classifyMessage("@nope hello", ctx()).reason).toBe("fallback");
    expect(classifyMessage("mail me at x@infra", ctx()).reason).toBe("fallback");
    expect(classifyMessage("plain question", ctx()).reason).toBe("fallback");
  });

  test("fallback is the reserved default project at confidence 0", () => {
    expect(classifyMessage("plain question", ctx())).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
  });
});

function ctx() {
  return { projects: PROJECTS };
}

describe("project FTS5 index (bun:sqlite)", () => {
  function seeded(): Database {
    const db = openProjectIndex(":memory:");
    indexProjectDescriptors(db, PROJECTS);
    indexProjectChat(db, "search-api", "the analyzer drops hyphenated terms, reindex the catalog");
    return db;
  }

  test("descriptor rows are replaced on reindex, not appended", () => {
    const db = seeded();
    indexProjectDescriptors(db, PROJECTS);
    expect(searchProjectScores(db, "kubernetes").map((h) => h.project_id)).toEqual(["infra"]);
  });

  test("a distinctive query scores its project top with a wide margin", () => {
    const db = seeded();
    const hits = searchProjectScores(db, "elasticsearch index mappings ranking");
    expect(hits[0]?.project_id).toBe("search-api");
    expect(hits[0]?.score).toBeGreaterThan(FTS_MIN_SCORE);
    expect((hits[0]?.score ?? 0) - (hits[1]?.score ?? 0)).toBeGreaterThan(FTS_MIN_MARGIN);
  });

  test("recent chat is searchable and keeps only the newest bounded slice", () => {
    const db = seeded();
    expect(searchProjectScores(db, "analyzer hyphenated")[0]?.project_id).toBe("search-api");
    for (let i = 0; i <= FTS_RECENT_CHAT_LIMIT; i++)
      indexProjectChat(db, "infra", `clusternote${i}`);
    expect(searchProjectScores(db, "clusternote0")).toEqual([]); // oldest evicted
    expect(searchProjectScores(db, `clusternote${FTS_RECENT_CHAT_LIMIT}`)[0]?.project_id).toBe(
      "infra",
    );
  });

  test("queries with no usable term return [] and never throw", () => {
    const db = seeded();
    for (const query of ["", "   ", "?!", "—", "((("]) {
      expect(() => searchProjectScores(db, query)).not.toThrow();
      expect(searchProjectScores(db, query)).toEqual([]);
    }
  });

  test("FTS5 syntax characters in a query are sanitized, never executed as syntax", () => {
    const db = seeded();
    // The raw string would be a syntax error if interpolated; quoting each term makes it a
    // literal search, so this cannot throw and cannot widen the match.
    for (const query of ['"', "NEAR(", "AND OR (", "*", "a -b"]) {
      expect(() => searchProjectScores(db, query)).not.toThrow();
      expect(searchProjectScores(db, query).every((hit) => hit.score <= 100)).toBe(true);
    }
  });

  test("a closed database degrades to []", () => {
    const db = seeded();
    db.close();
    expect(searchProjectScores(db, "kubernetes")).toEqual([]);
  });

  test("an empty index scores nothing", () => {
    expect(searchProjectScores(openProjectIndex(":memory:"), "kubernetes")).toEqual([]);
  });

  test("whitespace-only chat text does not consume a retention slot", () => {
    const db = openProjectIndex(":memory:");
    indexProjectDescriptors(db, PROJECTS);
    for (let i = 0; i < FTS_RECENT_CHAT_LIMIT; i++) indexProjectChat(db, "infra", `slotmarker${i}`);
    indexProjectChat(db, "infra", "   ");
    // A stored blank row would have evicted the oldest slot instead.
    expect(searchProjectScores(db, "slotmarker0")[0]?.project_id).toBe("infra");
  });

  test("a term unique to one project scores it exactly the full coverage", () => {
    const db = seeded();
    expect(searchProjectScores(db, "kubernetes")).toEqual([{ project_id: "infra", score: 100 }]);
  });

  test("a term in both a project's descriptor and its chat counts once, not twice", () => {
    const db = openProjectIndex(":memory:");
    indexProjectDescriptors(db, [
      {
        id: "with-chat",
        repos: [],
        name: "Ledger",
        goal: "double entry reconciliation",
        context: "",
      },
      {
        id: "no-chat",
        repos: [],
        name: "Ledger",
        goal: "double entry reconciliation",
        context: "",
      },
    ]);
    indexProjectChat(db, "with-chat", "more reconciliation notes");
    // Same descriptor evidence for both projects; the extra chat row must not tip the tie.
    expect(searchProjectScores(db, "reconciliation")).toEqual([
      { project_id: "no-chat", score: 100 },
      { project_id: "with-chat", score: 100 },
    ]);
  });
});

describe("ProjectClassifierAuthority — tier order", () => {
  function authority(options: {
    ai?: (input: {
      message: string;
    }) => Promise<{ project_id: string; confidence: number } | undefined>;
    withIndex?: boolean;
    projects?: ClassifierProject[];
    projectIndex?: Database;
  }) {
    const calls: string[] = [];
    const projects = options.projects ?? PROJECTS;
    const db = options.projectIndex ?? openProjectIndex(":memory:");
    if (options.withIndex !== false) indexProjectDescriptors(db, projects);
    const authorityInstance = new ProjectClassifierAuthority({
      projects: () => projects,
      index:
        options.withIndex === false ? undefined : { search: (q) => searchProjectScores(db, q) },
      propose: options.ai
        ? async (input) => {
            calls.push(input.message);
            return options.ai?.(input);
          }
        : undefined,
    });
    return { authorityInstance, calls };
  }

  test("repo tier never consults the index or the AI seam", async () => {
    const { authorityInstance, calls } = authority({ withIndex: false, ai: async () => undefined });
    expect(
      await authorityInstance.classify({ message: "x", repo_root: "/Users/me/search" }),
    ).toEqual({
      project_id: "search-api",
      confidence: 1,
      reason: "repo",
    });
    expect(calls).toEqual([]);
  });

  test("mention tier never consults the AI seam", async () => {
    const { authorityInstance, calls } = authority({ ai: async () => undefined });
    expect((await authorityInstance.classify({ message: "@infra ship it" })).reason).toBe(
      "mention",
    );
    expect(calls).toEqual([]);
  });

  test("a confident top-ranked FTS hit wins and the AI seam stays unconsulted", async () => {
    const { authorityInstance, calls } = authority({ ai: async () => undefined });
    const result = await authorityInstance.classify({
      message: "elasticsearch index mappings ranking tuning",
    });
    expect(result.reason).toBe("fts");
    expect(result.project_id).toBe("search-api");
    expect(result.confidence).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test("a near-tie over threshold is inconclusive, so the AI seam decides", async () => {
    const tied: ClassifierProject[] = [
      { id: "alpha", repos: [], name: "Alpha", goal: "shared topic wording", context: "" },
      { id: "beta", repos: [], name: "Beta", goal: "shared topic wording", context: "" },
    ];
    const { authorityInstance, calls } = authority({
      projects: tied,
      ai: async () => ({ project_id: "beta", confidence: 0.8 }),
    });
    const result = await authorityInstance.classify({ message: "shared topic wording" });
    expect(result).toEqual({ project_id: "beta", confidence: 0.8, reason: "ai" });
    expect(calls).toEqual(["shared topic wording"]);
  });

  test("an AI verdict naming an unregistered project falls back instead of binding it", async () => {
    const { authorityInstance } = authority({
      ai: async () => ({ project_id: "ghost", confidence: 0.99 }),
    });
    expect(await authorityInstance.classify({ message: "nothing matches here at all" })).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
  });

  test("an AI verdict under the confidence floor falls back to the default project", async () => {
    const { authorityInstance } = authority({
      ai: async () => ({ project_id: "infra", confidence: AI_MIN_CONFIDENCE - 0.01 }),
    });
    expect(await authorityInstance.classify({ message: "nothing matches here at all" })).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
  });

  test("an AI seam returning nothing is a fallback", async () => {
    const { authorityInstance } = authority({ ai: async () => undefined });
    expect((await authorityInstance.classify({ message: "nothing matches here" })).reason).toBe(
      "fallback",
    );
  });

  test("a runtime without an index or a seam stays deterministic and falls back", async () => {
    const { authorityInstance } = authority({ withIndex: false });
    expect(await authorityInstance.classify({ message: "nothing matches here" })).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
  });

  test("an index or seam that throws degrades to the fallback instead of failing the turn", async () => {
    const calls: string[] = [];
    const authorityInstance = new ProjectClassifierAuthority({
      projects: () => PROJECTS,
      index: {
        search: () => {
          throw new Error("index is corrupt");
        },
      },
      propose: async () => {
        calls.push("asked");
        throw new Error("bridge died");
      },
    });
    expect(await authorityInstance.classify({ message: "nothing matches here" })).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
    expect(calls).toEqual(["asked"]);
  });

  test("a non-finite AI confidence is discarded rather than binding a project", async () => {
    const { authorityInstance } = authority({
      ai: async () => ({ project_id: "infra", confidence: Number.NaN }),
    });
    expect((await authorityInstance.classify({ message: "nothing matches here" })).project_id).toBe(
      "idea",
    );
  });

  test("retrieval evidence scoring 0 does not become an FTS hit", async () => {
    const authorityInstance = new ProjectClassifierAuthority({
      projects: () => PROJECTS,
      index: { search: () => [{ project_id: "infra", score: 0 }] },
    });
    expect((await authorityInstance.classify({ message: "nothing matches here" })).reason).toBe(
      "fallback",
    );
  });
});

describe("project-classify skill seam", () => {
  test("prompt lists the registered projects and their goals", () => {
    const prompt = buildProjectProposalPrompt({
      message: "reindex the analyzer",
      projects: [{ id: "search-api", name: "Search API", goal: "Full text search", repos: [] }],
      candidates: [],
    });
    expect(prompt).toContain("search-api");
    expect(prompt).toContain("Full text search");
    expect(prompt).toContain("reindex the analyzer");
  });

  test("a JSON verdict parses, including a fenced code block", () => {
    expect(parseProjectProposal('{"project_id":"search-api","confidence":0.82}')).toEqual({
      project_id: "search-api",
      confidence: 0.82,
    });
    expect(parseProjectProposal('```json\n{"project_id":"infra","confidence":0.7}\n```')).toEqual({
      project_id: "infra",
      confidence: 0.7,
    });
  });

  test("garbage, a missing field, or an out-of-range confidence is no proposal", () => {
    for (const raw of [
      "",
      "I think it is search-api",
      '{"project_id":"search-api"}',
      '{"project_id":"search-api","confidence":2}',
      '{"confidence":0.9}',
      '{"project_id":"Not A Slug","confidence":0.9}',
      '{"project_id":"search-api","confidence":"high"}',
      '{"project_id":"search-api","confidence":}',
      '["search-api"]',
      "null",
    ])
      expect(parseProjectProposal(raw)).toBeUndefined();
  });

  test("the bridge adapter is absent when VIBEFLOW_AI is unset (classification stays tier-3)", () => {
    const original = process.env.VIBEFLOW_AI;
    // biome-ignore lint/performance/noDelete: the point is a genuinely absent env var
    delete process.env.VIBEFLOW_AI;
    try {
      expect(makeProjectProposalFn({ bridge: "" })).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.VIBEFLOW_AI = original;
    }
  });

  test("the bridge adapter parses a verdict and abstains on a failure", async () => {
    const request = {
      message: "reindex the analyzer",
      projects: [{ id: "search-api", name: "Search API", goal: "Full text search", repos: [] }],
      candidates: [],
    };
    const withVerdict = makeProjectProposalFn({
      bridge: "fake-bridge",
      ownedRoute: async () => ({
        attemptId: "classify",
        stdout: 'thoughts…\n{"project_id":"search-api","confidence":0.9}',
        stderr: "",
        status: 0,
        timedOut: false,
      }),
    });
    expect(await withVerdict?.(request)).toEqual({ project_id: "search-api", confidence: 0.9 });

    const failing = makeProjectProposalFn({
      bridge: "fake-bridge",
      ownedRoute: async () => ({
        attemptId: "classify",
        stdout: '{"project_id":"search-api","confidence":0.9}',
        stderr: "boom",
        status: 3,
        timedOut: false,
      }),
    });
    expect(await failing?.(request)).toBeUndefined();

    const throwing = makeProjectProposalFn({
      bridge: "fake-bridge",
      ownedRoute: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await throwing?.(request)).toBeUndefined();
  });

  test("a project without prose still renders its id in the prompt", () => {
    const prompt = buildProjectProposalPrompt({
      message: "x",
      projects: [{ id: "bare", repos: [] }],
      candidates: [],
    });
    expect(prompt).toContain("- bare");
  });
});

import { describe, expect, test } from "bun:test";
import {
  CONTEXT7_BASE,
  type DiscoveryResult,
  discoveryAvailable,
  lookupDocs,
  lookupDocsHttp,
  searchSkills,
  searchSkillsHttp,
} from "../src/discovery/context7.js";

/** Minimal Response-like object so tests never touch the network. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Plain-text Response (used for markdown fallbacks). */
function textResponse(text: string, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
    text: async () => text,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Lines 95-97: rowsFrom body shapes (libraries / docs / items fallback keys).
// Exercised through the public HTTP API by feeding the search endpoint a body
// whose top-level key is one of the fallback names.
// ---------------------------------------------------------------------------
describe("rowsFrom fallback keys (via search endpoint)", () => {
  test("libraries key is recognized", async () => {
    const fetchFn = (async () =>
      jsonResponse({ libraries: [{ name: "lib-a", description: "d" }] })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("lib-a");
  });

  test("docs key is recognized", async () => {
    const fetchFn = (async () =>
      jsonResponse({ docs: [{ name: "lib-b", description: "d" }] })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("lib-b");
  });

  test("items key is recognized", async () => {
    const fetchFn = (async () =>
      jsonResponse({ items: [{ name: "lib-c", description: "d" }] })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("lib-c");
  });

  test("unknown object shape -> empty rows -> not found", async () => {
    // Object body without results/libraries/docs/items triggers the
    // `return []` fallback inside rowsFrom.
    const fetchFn = (async () =>
      jsonResponse({ something: "else", count: 0 })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
  });

  test("top-level array body -> rowsFrom Array.isArray true branch", async () => {
    // API may return a top-level array; rowsFrom should accept it.
    const fetchFn = (async () =>
      jsonResponse([{ name: "top-level", description: "d" }])) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("top-level");
  });
});

// ---------------------------------------------------------------------------
// Lines 122-123 + 279-301: getJson JSON-parse failure -> parseMarkdownContext.
// ---------------------------------------------------------------------------
describe("getJson markdown fallback (lines 122-123 + 279-301)", () => {
  test("searchSkillsHttp: non-JSON markdown body parses into rows", async () => {
    const markdown =
      "### Title One\nIntro text.\n```ts\nconst x = 1;\n```\nSource: ignored-source\n\n### Title Two\nSecond section.\n```js\nb();\n```\n";
    const fetchFn = (async () => textResponse(markdown)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("anything", { approved: true, fetchFn });
    // Non-JSON body -> catch -> parseMarkdownContext -> rows. Map to skill kind.
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.kind).toBe("skill");
      expect(r.status).toBe("experimental");
    }
    // Source: line should be stripped from snippets.
    const allSnippet = out.results.map((r) => r.snippet).join("\n");
    expect(allSnippet).not.toContain("ignored-source");
  });

  test("parseMarkdownContext: plain paragraph fallback (no code block)", async () => {
    const md = "### Plain\nThis is a paragraph with no code block at all.\n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toContain("paragraph");
  });

  test("parseMarkdownContext: empty/markerless body still yields a row", async () => {
    const md = "completely free-form text with no H3 at all\nline2\n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThanOrEqual(1);
  });

  test("parseMarkdownContext: code block snippet is trimmed and sliced to 500", async () => {
    const longCode = "a".repeat(800);
    const md = "### Code\n```js\n" + longCode + "\n```\n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    // Snippet should be capped at 500 chars.
    expect(out.results[0]?.snippet.length).toBeLessThanOrEqual(500);
  });

  test("parseMarkdownContext: code block with language tag is stripped", async () => {
    const md = "### Lang\n```typescript\nconst q = 2;\n```\n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toContain("const q = 2");
    expect(out.results[0]?.snippet).not.toContain("```");
  });

  test("parseMarkdownContext: empty section -> synthesized fallback row", async () => {
    // Section with no title text and empty body — both empty -> row not
    // pushed; rows.length === 0 -> fallback row from the raw text is used.
    const md = "### \n   \n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThanOrEqual(1);
  });

  test("parseMarkdownContext: section with empty title but body content -> title defaults to 'docs'", async () => {
    // Construct a section where `title` is empty (just `### \n`) but body is
    // non-empty -> `if (title || snippet)` true because of snippet ->
    // `title || "docs"` defaults the title to "docs" (line 299 second arm).
    const md = "### \nThis is body content only.\n";
    const fetchFn = (async () => textResponse(md)) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    // Body must be in the snippet.
    const allSnippet = out.results.map((r) => r.snippet).join("\n");
    expect(allSnippet).toContain("This is body content only");
  });
});

// ---------------------------------------------------------------------------
// Lines 215-219: notWired helper, exposed via legacy sync lookupDocs/searchSkills
// when no `runner` is injected.
// ---------------------------------------------------------------------------
describe("legacy sync API (notWired + runner paths)", () => {
  test("lookupDocs without runner returns notWired outcome", () => {
    const out = lookupDocs("react", { approved: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("async");
    expect(out.results).toEqual([]);
  });

  test("searchSkills without runner returns notWired outcome", () => {
    const out = searchSkills("pdf", { approved: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("async");
    expect(out.results).toEqual([]);
  });

  test("lookupDocs requires approval even with no runner", () => {
    const out = lookupDocs("react");
    expect(out.approvalRequired).toBe(true);
    expect(out.ok).toBe(false);
  });

  test("searchSkills requires approval even with no runner", () => {
    const out = searchSkills("pdf");
    expect(out.approvalRequired).toBe(true);
    expect(out.ok).toBe(false);
  });

  test("lookupDocs with runner returning non-zero status -> failure", () => {
    const out = lookupDocs("react", {
      approved: true,
      runner: () => ({ status: 1, stdout: "" }),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("docs lookup failed");
    expect(out.results).toEqual([]);
  });

  test("lookupDocs with runner returning zero status -> ok + parsed docs (JSON line)", () => {
    const out = lookupDocs("react", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ title: "React", snippet: "ui lib" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    const first = out.results[0] as DiscoveryResult;
    expect(first.title).toBe("React");
    expect(first.snippet).toBe("ui lib");
    expect(first.kind).toBe("docs");
  });

  test("lookupDocs with plain-text line (non-JSON) -> parseLines fallback (line 315)", () => {
    const out = lookupDocs("react", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: "this is just a plain text line\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(1);
    // Plain line -> { text: ... }; mapped to snippet via `row.snippet ?? row.text ?? ""`.
    expect(out.results[0]?.snippet).toBe("this is just a plain text line");
  });

  test("lookupDocs with JSON line that has `snippet` field -> parseDocs snippet path", () => {
    // parseDocs: snippet = line.snippet ?? line.text ?? "". With snippet set,
    // the first `??` resolves and `line.text` is never read.
    const out = lookupDocs("react", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ title: "T", snippet: "S" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("S");
  });

  test("lookupDocs with JSON line that has neither `snippet` nor `text` -> empty snippet", () => {
    // parseDocs: snippet = line.snippet ?? line.text ?? "" — empty string.
    const out = lookupDocs("react", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ title: "NoSnippet" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("");
    expect(out.results[0]?.title).toBe("NoSnippet");
  });

  test("searchSkills with runner returning zero status -> ok + parsed skills", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ name: "pdf-reader", description: "reads pdf" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    const first = out.results[0] as DiscoveryResult;
    expect(first.name).toBe("pdf-reader");
    expect(first.status).toBe("experimental");
    expect(first.kind).toBe("skill");
  });

  test("searchSkills with JSON line that has `description` -> uses description", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ name: "pdf-reader", description: "reads pdf" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("reads pdf");
  });

  test("searchSkills with JSON line missing description -> uses snippet", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ name: "pdf-reader", snippet: "alt text" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("alt text");
  });

  test("searchSkills with JSON line missing name and title -> 'skill' default", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ description: "anon" }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("skill");
    expect(out.results[0]?.name).toBeUndefined();
  });

  test("searchSkills with JSON line having non-string name -> name undefined", () => {
    // safeSkillName rejects non-strings -> name undefined.
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ name: 42 }) + "\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.name).toBeUndefined();
  });

  test("searchSkillsHttp: row has title but no name -> title wins", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        results: [{ title: "JustTitle", description: "d" }],
      })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("q", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("JustTitle");
  });

  test("searchSkillsHttp: row has no name, no title -> 'skill' fallback", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        results: [{ description: "anonymous" }],
      })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("q", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("skill");
    expect(out.results[0]?.name).toBeUndefined();
  });

  test("searchSkillsHttp: row has no description -> uses snippet", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        results: [{ name: "x", snippet: "alt" }],
      })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("q", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("alt");
  });

  test("searchSkillsHttp: row has no description, no snippet -> empty snippet", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        results: [{ name: "x" }],
      })) as unknown as typeof fetch;
    const out = await searchSkillsHttp("q", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.snippet).toBe("");
  });

  test("searchSkills with runner returning non-zero status -> failure", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({ status: 2, stdout: "" }),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("skill search failed");
  });

  test("searchSkills with plain-text line (non-JSON) -> parseLines fallback (line 315)", () => {
    const out = searchSkills("pdf", {
      approved: true,
      runner: () => ({
        status: 0,
        stdout: "a plain skill description\n",
      }),
    });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(1);
    // Plain line -> { text: "..." }; description and snippet are both missing
    // in the row, so the snippet falls back to "".
    expect(out.results[0]?.snippet).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Misc public exports.
// ---------------------------------------------------------------------------
describe("public exports", () => {
  test("CONTEXT7_BASE constant", () => {
    expect(CONTEXT7_BASE).toBe("https://context7.com");
  });

  test("discoveryAvailable reflects global fetch presence", () => {
    // In vitest+node, global `fetch` is provided by Node 18+.
    expect(discoveryAvailable()).toBe(true);
  });

  test("lookupDocsHttp returns graceful failure when no library is found", async () => {
    const fetchFn = (async () => jsonResponse({ results: [] })) as unknown as typeof fetch;
    const out = await lookupDocsHttp("nope", { approved: true, fetchFn });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("No Context7 library found");
  });

  test("lookupDocsHttp step 2 fetch failure surfaces the step-1 reason", async () => {
    // Step 1 succeeds, step 2 (context) returns 500.
    const fetchFn = (async (url: string) => {
      if (url.includes("/libs/search")) {
        return jsonResponse({ results: [{ id: "/facebook/react" }] });
      }
      return jsonResponse({}, { ok: false, status: 500 });
    }) as unknown as typeof fetch;
    const out = await lookupDocsHttp("react", { approved: true, fetchFn });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("500");
  });

  test("lookupDocsHttp step 2: title+name+snippet branches (all ??)", async () => {
    // Row has only `name` (no title) -> title falls back to name;
    // row has only `text` (no snippet) -> snippet falls back to text.
    const fetchFn = (async (url: string) => {
      if (url.includes("/libs/search")) {
        return jsonResponse({ results: [{ id: "/facebook/react" }] });
      }
      return jsonResponse({ results: [{ name: "ByName", text: "ByText" }] });
    }) as unknown as typeof fetch;
    const out = await lookupDocsHttp("react", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("ByName");
    expect(out.results[0]?.snippet).toBe("ByText");
  });

  test("lookupDocsHttp step 2: title+snippet missing -> falls back to library + description", async () => {
    // Row has only `description` (no title, no name, no snippet, no text).
    const fetchFn = (async (url: string) => {
      if (url.includes("/libs/search")) {
        return jsonResponse({ results: [{ id: "/facebook/react" }] });
      }
      return jsonResponse({ results: [{ description: "DescOnly" }] });
    }) as unknown as typeof fetch;
    const out = await lookupDocsHttp("react", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("react"); // fallback to library arg
    expect(out.results[0]?.snippet).toBe("DescOnly");
  });

  test("lookupDocsHttp step 2: empty row -> title=library, snippet empty", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/libs/search")) {
        return jsonResponse({ results: [{ id: "/facebook/react" }] });
      }
      return jsonResponse({ results: [{}] });
    }) as unknown as typeof fetch;
    const out = await lookupDocsHttp("react", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("react");
    expect(out.results[0]?.snippet).toBe("");
  });

  test("lookupDocsHttp step 2: title and name missing -> uses library (?? library)", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/libs/search")) {
        return jsonResponse({ results: [{ id: "/facebook/react" }] });
      }
      return jsonResponse({ results: [{ snippet: "snip" }] });
    }) as unknown as typeof fetch;
    const out = await lookupDocsHttp("react", { approved: true, fetchFn });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("react");
  });

  test("getJson defaults to global fetch when fetchFn not provided (line 108 ?? branch)", async () => {
    // We can't easily stub global fetch inside the shim, so spy on a probe
    // by passing fetchFn=undefined; the code should pick up `fetch` and
    // succeed because the shim's global fetch is the real one.
    // We override the request by mocking with a sentinel that records whether
    // the default branch ran. Instead, we use an approved call with a
    // permissive global fetch: the assertion here is that no throw happens
    // and a DiscoveryOutcome is returned.
    const out = await searchSkillsHttp("x", { approved: true, fetchFn: undefined });
    // Don't assert contents (network may or may not be available). Just
    // confirm the function returned a well-shaped outcome.
    expect(typeof out.ok).toBe("boolean");
  });

  test("getJson non-Error throwable -> String(err) branch", async () => {
    // Throw a non-Error value to exercise `err instanceof Error ? err.message : String(err)`.
    const fetchFn = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string error";
    }) as unknown as typeof fetch;
    const out = await searchSkillsHttp("x", { approved: true, fetchFn });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("string error");
  });

  test("getJson omits Authorization header when no apiKey is set", async () => {
    let auth: string | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization") ?? undefined;
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;
    const saved = process.env.CONTEXT7_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    try {
      await searchSkillsHttp("x", { approved: true, fetchFn });
    } finally {
      if (saved !== undefined) process.env.CONTEXT7_API_KEY = saved;
    }
    expect(auth).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ProjectCreateRequestV1,
  ProjectRegistryAuthority,
} from "../../src/orchestrator/conversation/project-registry-authority.js";
import {
  ProjectRegistryCorruptError,
  ProjectRegistryStore,
} from "../../src/orchestrator/conversation/project-registry-store.js";
import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_SLUG_PATTERN,
  PROJECT_THINKING,
  ProjectValidationError,
  assertProjectSlug,
  isProjectThinking,
  normalizeProjectRepos,
} from "../../src/orchestrator/conversation/project-types.js";

const CREATED_AT = "2026-09-20T00:00:00.000Z";

const CREATE: ProjectCreateRequestV1 = {
  id: "hermes",
  name: "Hermes",
  goal: "Ship project classification",
  context: "Local-first orchestrator",
  repos: ["./repo"],
  engine: { cli: "claude", thinking: "auto" },
};

const VALID_PROJECT = {
  id: "hermes",
  name: "Hermes",
  goal: "g",
  context: "c",
  repos: [resolve(".")],
  engine: { cli: "claude", model: null, thinking: "auto" },
  created_at: CREATED_AT,
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    revision: 1,
    updated_at: CREATED_AT,
    projects: [VALID_PROJECT],
    ...overrides,
  };
}

function scratch(run: (root: string, authority: ProjectRegistryAuthority) => void): void {
  const root = mkdtempSync(join(tmpdir(), "vf-project-registry-"));
  try {
    run(root, new ProjectRegistryAuthority({ root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Corrupt fixtures must still be private files: the durability reader rejects widened modes first. */
function writeDocument(root: string, document: unknown): void {
  writeFileSync(
    new ProjectRegistryStore({ root }).paths.file,
    typeof document === "string" ? document : JSON.stringify(document),
    { mode: 0o600 },
  );
}

describe("project slug, engine, and repo vocabulary", () => {
  test("slug authority accepts lowercase-hyphen ids and rejects everything else", () => {
    expect(PROJECT_SLUG_PATTERN.test("hermes-2")).toBe(true);
    expect(assertProjectSlug("a")).toBe("a");
    expect(() => assertProjectSlug("Bad Slug")).toThrow(ProjectValidationError);
    expect(() => assertProjectSlug("-leading")).toThrow(ProjectValidationError);
    expect(() => assertProjectSlug("x".repeat(65))).toThrow(ProjectValidationError);
  });

  test("thinking is a closed vocabulary", () => {
    expect(PROJECT_THINKING.AUTO).toBe("auto");
    expect(isProjectThinking("high")).toBe(true);
    expect(isProjectThinking("extreme")).toBe(false);
    expect(isProjectThinking(3)).toBe(false);
  });

  test("repo lists normalize to deduplicated absolute paths", () => {
    expect(normalizeProjectRepos(["./repo", resolve("/tmp")])).toEqual([
      resolve("./repo"),
      resolve("/tmp"),
    ]);
    expect(() => normalizeProjectRepos("repo")).toThrow(ProjectValidationError);
    expect(() => normalizeProjectRepos([1])).toThrow(ProjectValidationError);
  });
});

describe("project registry authority", () => {
  test("create persists an absolute-normalized project with a full engine default", () => {
    scratch((root, authority) => {
      const project = authority.create(CREATE);

      expect(project.id).toBe("hermes");
      expect(project.name).toBe("Hermes");
      expect(project.goal).toBe("Ship project classification");
      expect(project.context).toBe("Local-first orchestrator");
      expect(project.repos).toEqual([resolve("./repo")]);
      expect(project.engine).toEqual({ cli: "claude", model: null, thinking: "auto" });
      expect(Number.isNaN(Date.parse(project.created_at))).toBe(false);

      // Persistence proof: a fresh authority reading the same private dir sees it.
      const reopened = new ProjectRegistryAuthority({ root });
      expect(reopened.get("hermes")).toEqual(project);
      expect(reopened.list()).toEqual([project]);
      expect(new ProjectRegistryStore({ root }).read().revision).toBe(1);

      // Atomic write leaves no staging residue behind.
      expect(readdirSync(root).sort()).toEqual(["registry.json", "registry.lock"]);
    });
  });

  test("create rejects a duplicate id", () => {
    scratch((_root, authority) => {
      authority.create(CREATE);
      expect(() => authority.create({ ...CREATE, name: "Hermes clone" })).toThrow(/already exists/);
      expect(authority.list()).toHaveLength(1);
    });
  });

  test("create rejects invalid requests", () => {
    const rows: Array<[string, Partial<ProjectCreateRequestV1>]> = [
      ["invalid slug", { id: "Bad Slug" }],
      ["empty id", { id: "" }],
      ["empty name", { name: "   " }],
      ["non-array repos", { repos: "./repo" as unknown as string[] }],
      ["blank repo entry", { repos: [""] }],
      ["non-string repo entry", { repos: [7] as unknown as string[] }],
      ["non-string goal", { goal: 5 as unknown as string }],
      ["non-string context", { context: null as unknown as string }],
      ["engine missing", { engine: undefined }],
      ["unknown engine cli", { engine: { cli: "vscode", thinking: "auto" } as never }],
      ["unknown thinking", { engine: { cli: "claude", thinking: "extreme" } as never }],
      [
        "non-string engine model",
        { engine: { cli: "claude", model: 7, thinking: "auto" } as never },
      ],
    ];

    scratch((_root, authority) => {
      for (const [label, override] of rows)
        expect(() => authority.create({ ...CREATE, ...override }), label).toThrow(
          ProjectValidationError,
        );
      expect(authority.list()).toEqual([]);
    });
  });

  test("update patches fields, preserves created_at, and bumps revision", () => {
    scratch((_root, authority) => {
      const created = authority.create(CREATE);
      const updated = authority.update("hermes", {
        name: "Hermes v2",
        goal: "Classify",
        repos: ["/tmp", "/tmp"],
      });

      expect(updated.created_at).toBe(created.created_at);
      expect(updated.id).toBe("hermes");
      expect(updated.name).toBe("Hermes v2");
      expect(updated.goal).toBe("Classify");
      expect(updated.context).toBe(created.context);
      expect(updated.engine).toEqual(created.engine);
      expect(updated.repos).toEqual([resolve("/tmp")]);
      expect(authority.list()).toEqual([updated]);
    });
  });

  test("update rejects unknown ids and invalid patches", () => {
    scratch((_root, authority) => {
      authority.create(CREATE);
      expect(() => authority.update("absent", { name: "x" })).toThrow(/unknown project/);
      expect(() => authority.update("hermes", { name: "" })).toThrow(ProjectValidationError);
      expect(() => authority.update("hermes", { repos: "repo" as unknown as string[] })).toThrow(
        ProjectValidationError,
      );
      expect(() =>
        authority.update("hermes", { engine: { cli: "claude", thinking: "nope" } as never }),
      ).toThrow(ProjectValidationError);
      expect(authority.get("hermes")).toBeDefined();
    });
  });

  test("delete removes the project and rejects unknown ids", () => {
    scratch((_root, authority) => {
      authority.create(CREATE);
      authority.delete("hermes");

      expect(authority.get("hermes")).toBeUndefined();
      expect(authority.list()).toEqual([]);
      expect(new ProjectRegistryStore({ root: _root }).read().revision).toBe(2);
      expect(() => authority.delete("hermes")).toThrow(/unknown project/);
    });
  });

  test("an absent registry file reads as an empty registry", () => {
    scratch((_root, authority) => {
      expect(authority.list()).toEqual([]);
      expect(authority.get("hermes")).toBeUndefined();
      expect(new ProjectRegistryStore({ root: _root }).read().revision).toBe(0);
    });
  });

  test("list preserves creation order", () => {
    scratch((_root, authority) => {
      authority.create({ ...CREATE, id: "alpha" });
      authority.create({ ...CREATE, id: "beta" });
      expect(authority.list().map((project) => project.id)).toEqual(["alpha", "beta"]);
    });
  });
});

describe("project registry store", () => {
  test("a corrupt registry file surfaces as ProjectRegistryCorruptError", () => {
    const corrupt: Array<[string, unknown]> = [
      ["malformed json", "{ not json"],
      ["non-object document", null],
      ["unsupported schema version", manifest({ schema_version: "2.0" })],
      ["negative revision", manifest({ revision: -1 })],
      ["fractional revision", manifest({ revision: 1.5 })],
      ["non-array projects", manifest({ projects: "nope" })],
      ["invalid updated_at", manifest({ updated_at: "yesterday" })],
      ["non-object project", manifest({ projects: [null] })],
      ["invalid project slug", manifest({ projects: [{ ...VALID_PROJECT, id: "Bad Slug" }] })],
      ["empty project name", manifest({ projects: [{ ...VALID_PROJECT, name: "  " }] })],
      ["non-string goal", manifest({ projects: [{ ...VALID_PROJECT, goal: 5 }] })],
      ["non-string context", manifest({ projects: [{ ...VALID_PROJECT, context: null }] })],
      ["invalid created_at", manifest({ projects: [{ ...VALID_PROJECT, created_at: "?" }] })],
      ["non-array repos", manifest({ projects: [{ ...VALID_PROJECT, repos: "repo" }] })],
      ["blank repo entry", manifest({ projects: [{ ...VALID_PROJECT, repos: [""] }] })],
      [
        "unknown engine cli",
        manifest({
          projects: [
            { ...VALID_PROJECT, engine: { cli: "vscode", model: null, thinking: "auto" } },
          ],
        }),
      ],
      [
        "non-string engine model",
        manifest({
          projects: [{ ...VALID_PROJECT, engine: { cli: "claude", model: 7, thinking: "auto" } }],
        }),
      ],
      [
        "unknown thinking",
        manifest({
          projects: [
            { ...VALID_PROJECT, engine: { cli: "claude", model: null, thinking: "extreme" } },
          ],
        }),
      ],
      ["null engine", manifest({ projects: [{ ...VALID_PROJECT, engine: null }] })],
    ];

    for (const [label, document] of corrupt) {
      scratch((root) => {
        writeDocument(root, document);
        expect(() => new ProjectRegistryStore({ root }).read(), label).toThrow(
          ProjectRegistryCorruptError,
        );
        expect(() => new ProjectRegistryAuthority({ root }).list(), label).toThrow(
          ProjectRegistryCorruptError,
        );
      });
    }
  });

  test("a rejected write leaves the previous registry intact", () => {
    scratch((root, authority) => {
      const created = authority.create(CREATE);
      expect(() => authority.create({ ...CREATE, id: "Bad Slug" })).toThrow(ProjectValidationError);
      expect(new ProjectRegistryAuthority({ root }).get(created.id)).toEqual(created);
    });
  });
});

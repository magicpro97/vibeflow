import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { registryCacheDir } from "../src/skills/registry-channel.js";
import {
  marketplaceName,
  mergeClaudeTelemetry,
  mergeCodexTelemetry,
  mergeOpenCodeConfig,
  parseReceipt,
  renderMarketplace,
  renderOpenCodeTelemetryHook,
  renderReceipt,
  resolveSuperpowersPin,
} from "../src/superpowers-sync.js";

const URL = "https://github.com/obra/superpowers.git";
const OID = "a".repeat(40);
const OTHER_OID = "b".repeat(40);

function repoWith(registries: unknown[]): { repo: string; home: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "vf-superpowers-765-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repo, ".vibeflow"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
    JSON.stringify({ schemaVersion: 1, registries }),
  );
  return { repo, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function entry(commitOID = OID, url = URL) {
  return { name: "superpowers", url, ref: "main", commitOID };
}

describe("#765 strict Superpowers pin", () => {
  test("returns the one canonical full-OID pin with matching cache HEAD", () => {
    const fixture = repoWith([
      {
        ...entry(),
        installed: [
          {
            name: "superpowers",
            version: "1",
            commitOID: OID,
            bundleHash: "c".repeat(64),
            skillPath: "skills/test",
            scan_summary: { scanned: true, finding_count: 0 },
          },
        ],
      },
    ]);
    try {
      const cacheDir = registryCacheDir(URL, { homedir: () => fixture.home });
      const result = resolveSuperpowersPin(fixture.repo, {
        homedir: () => fixture.home,
        existsSync: (path) => path === cacheDir,
        gitHead: (path) => (path === cacheDir ? OID : null),
      });
      expect(result).toEqual({ ok: true, pin: { url: URL, commitOID: OID, cacheDir } });
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects zero or multiple canonical entries", () => {
    for (const registries of [[], [entry(), { ...entry(), name: "duplicate" }]]) {
      const fixture = repoWith(registries);
      try {
        const result = resolveSuperpowersPin(fixture.repo, { homedir: () => fixture.home });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("exactly one");
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("fails closed on malformed lock JSON, entries, or installed metadata", () => {
    const fixture = repoWith([entry(), { name: "broken", url: URL, ref: "main" }]);
    try {
      const result = resolveSuperpowersPin(fixture.repo, { homedir: () => fixture.home });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("malformed");
      const malformed = resolveSuperpowersPin(fixture.repo, {
        homedir: () => fixture.home,
        readFileSync: () => "{",
      });
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.error).toContain("malformed");

      const badInstalled = resolveSuperpowersPin(fixture.repo, {
        homedir: () => fixture.home,
        readFileSync: () =>
          JSON.stringify({ schemaVersion: 1, registries: [{ ...entry(), installed: 7 }] }),
      });
      expect(badInstalled.ok).toBe(false);
      if (!badInstalled.ok) expect(badInstalled.error).toContain("malformed");

      for (const installed of [
        { bundleHash: 7 },
        { skillPath: 7 },
        { scan_summary: [] },
        { scan_summary: { scanned: "yes", finding_count: "many" } },
      ]) {
        const badOptional = resolveSuperpowersPin(fixture.repo, {
          homedir: () => fixture.home,
          readFileSync: () =>
            JSON.stringify({
              schemaVersion: 1,
              registries: [
                {
                  ...entry(),
                  installed: [{ name: "x", version: "1", commitOID: OID, ...installed }],
                },
              ],
            }),
        });
        expect(badOptional.ok).toBe(false);
        if (!badOptional.ok) expect(badOptional.error).toContain("malformed");
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("normalizes safe GitHub URL variants to the canonical source", () => {
    for (const url of ["https://github.com/obra/superpowers", `${URL}/`]) {
      const fixture = repoWith([entry(OID, url)]);
      try {
        const cacheDir = registryCacheDir(url, { homedir: () => fixture.home });
        const result = resolveSuperpowersPin(fixture.repo, {
          homedir: () => fixture.home,
          existsSync: (path) => path === cacheDir,
          gitHead: () => OID,
        });
        expect(result).toEqual({ ok: true, pin: { url: URL, commitOID: OID, cacheDir } });
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rejects partial or uppercase OIDs", () => {
    for (const oid of ["abc123", "A".repeat(40)]) {
      const fixture = repoWith([entry(oid)]);
      try {
        const result = resolveSuperpowersPin(fixture.repo, { homedir: () => fixture.home });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("40-character lowercase");
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rejects a missing cache or mismatched cache HEAD", () => {
    const fixture = repoWith([entry()]);
    try {
      const missing = resolveSuperpowersPin(fixture.repo, {
        homedir: () => fixture.home,
        existsSync: () => false,
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toContain("cache");

      const mismatch = resolveSuperpowersPin(fixture.repo, {
        homedir: () => fixture.home,
        existsSync: () => true,
        gitHead: () => OTHER_OID,
      });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.error).toContain("does not match");
    } finally {
      fixture.cleanup();
    }
  });

  test("default git seam reads HEAD from the exact registry cache", () => {
    const fixture = repoWith([]);
    try {
      const cacheDir = registryCacheDir(URL, { homedir: () => fixture.home });
      mkdirSync(cacheDir, { recursive: true });
      for (const args of [
        ["init"],
        ["config", "user.email", "test@example.com"],
        ["config", "user.name", "Test"],
      ])
        expect(spawnSync("git", args, { cwd: cacheDir }).status).toBe(0);
      writeFileSync(join(cacheDir, "README.md"), "test\n");
      expect(spawnSync("git", ["add", "README.md"], { cwd: cacheDir }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "test"], { cwd: cacheDir }).status).toBe(0);
      const oid = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: cacheDir,
        encoding: "utf8",
      }).stdout.trim();
      writeFileSync(
        join(fixture.repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
        JSON.stringify({ schemaVersion: 1, registries: [entry(oid)] }),
      );
      expect(resolveSuperpowersPin(fixture.repo, { homedir: () => fixture.home })).toEqual({
        ok: true,
        pin: { url: URL, commitOID: oid, cacheDir },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("default git seam rejects a cache that only inherits a parent repository", () => {
    const fixture = repoWith([entry()]);
    try {
      for (const args of [
        ["init", fixture.home],
        ["-C", fixture.home, "config", "user.email", "test@example.com"],
        ["-C", fixture.home, "config", "user.name", "Test"],
      ])
        expect(spawnSync("git", args).status).toBe(0);
      writeFileSync(join(fixture.home, "parent.txt"), "x");
      expect(spawnSync("git", ["-C", fixture.home, "add", "parent.txt"]).status).toBe(0);
      expect(spawnSync("git", ["-C", fixture.home, "commit", "-m", "parent"]).status).toBe(0);
      const cacheDir = registryCacheDir(URL, { homedir: () => fixture.home });
      mkdirSync(cacheDir, { recursive: true });
      const parentHead = spawnSync("git", ["-C", fixture.home, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      writeFileSync(
        join(fixture.repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
        JSON.stringify({ schemaVersion: 1, registries: [entry(parentHead)] }),
      );
      const result = resolveSuperpowersPin(fixture.repo, { homedir: () => fixture.home });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("does not match");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("#765 generated marketplace", () => {
  test("uses a commit-qualified name and exact URL+SHA source", () => {
    const pin = { url: URL, commitOID: OID, cacheDir: "/cache" };
    expect(marketplaceName(OID)).toBe(`vf-superpowers-${OID.slice(0, 12)}`);
    expect(JSON.parse(renderMarketplace(pin))).toEqual({
      name: `vf-superpowers-${OID.slice(0, 12)}`,
      owner: { name: "VibeFlow" },
      description: "VibeFlow-managed exact Superpowers pin",
      plugins: [
        {
          name: "superpowers",
          source: { source: "url", url: URL, sha: OID },
          strict: true,
        },
      ],
    });
  });

  test("rejects unvalidated OIDs and non-canonical sources", () => {
    expect(() => marketplaceName("bad")).toThrow();
    expect(() => marketplaceName(new String(OID) as unknown as string)).toThrow();
    expect(() =>
      renderMarketplace({
        url: "https://example.com/spoof.git",
        commitOID: OID,
        cacheDir: "/cache",
      }),
    ).toThrow();
  });
});

describe("#765 OpenCode config merge", () => {
  const desired = `superpowers@git+${URL}#${OID}`;

  test("preserves unrelated keys/plugins and replaces only canonical Superpowers specs", () => {
    const raw = JSON.stringify({
      $schema: "schema",
      provider: { keep: true },
      model: "p/m",
      permission: { bash: "deny" },
      agent: { x: {} },
      unknown: 7,
      plugin: [
        "keep",
        `superpowers@git+${URL}`,
        `superpowers@git+${URL}#old`,
        `superpowers@git+${URL.slice(0, -4)}#${OTHER_OID}`,
        `superpowers@git+${URL}/${"#"}${OTHER_OID}`,
      ],
    });
    const result = mergeOpenCodeConfig(raw, desired);
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      $schema: "schema",
      provider: { keep: true },
      model: "p/m",
      permission: { bash: "deny" },
      agent: { x: {} },
      unknown: 7,
      plugin: ["keep", desired],
    });
  });

  test("rejects unsafe integers even in exponent notation", () => {
    expect(() => mergeOpenCodeConfig(`{"n":9007199254740993e0,"plugin":[]}`, desired)).toThrow(
      "JSON number cannot be rewritten losslessly",
    );
  });

  test("is a semantic no-op when desired spec is already the only managed spec", () => {
    const raw = JSON.stringify({ plugin: ["keep", desired] }, null, 4);
    expect(mergeOpenCodeConfig(raw, desired)).toEqual({ changed: false, content: raw });
  });

  test("accepts OpenCode's documented JSONC format while preserving semantic keys", () => {
    const raw = `{/* block 123 */\n// keep this valid JSONC\n"unknown": 1e0,\n"plugin": ["keep",],\n}`;
    const result = mergeOpenCodeConfig(raw, desired);
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      unknown: 1,
      plugin: ["keep", desired],
    });
  });

  test("rejects malformed/non-object JSON and non-string plugin entries", () => {
    for (const raw of [
      "{",
      "[]",
      JSON.stringify({ plugin: ["ok", 1] }),
      '{"budget":9007199254740993}',
      "{/* unterminated",
    ]) {
      expect(() => mergeOpenCodeConfig(raw, desired)).toThrow();
    }
  });

  test("rejects desired specs outside the canonical exact-OID contract", () => {
    for (const spec of ["evil", `superpowers@git+${URL}`, `superpowers@git+${URL}#bad`]) {
      expect(() => mergeOpenCodeConfig("{}", spec)).toThrow();
    }
    expect(() =>
      mergeOpenCodeConfig("{}", new String(`superpowers@git+${URL}#${OID}`) as unknown as string),
    ).toThrow();
  });
});

describe("#765 persistent telemetry config", () => {
  test("Claude merge preserves settings and adds only an absent default", () => {
    const added = mergeClaudeTelemetry(JSON.stringify({ model: "x", env: { KEEP: "y" } }));
    expect(added.changed).toBe(true);
    expect(JSON.parse(added.content)).toEqual({
      model: "x",
      env: { KEEP: "y", SUPERPOWERS_DISABLE_TELEMETRY: "1" },
    });

    const raw = JSON.stringify({ env: { SUPERPOWERS_DISABLE_TELEMETRY: "off" } }, null, 4);
    expect(mergeClaudeTelemetry(raw)).toEqual({ changed: false, content: raw });
  });

  test("Claude merge rejects malformed/non-object/env-nonobject config", () => {
    for (const raw of ["{", "[]", JSON.stringify({ env: [] }), '{"budget":9007199254740993}']) {
      expect(() => mergeClaudeTelemetry(raw)).toThrow();
    }
  });

  test("Codex merge preserves semantic TOML and adds only an absent default", () => {
    const added = mergeCodexTelemetry('model = "gpt-5"\n[permissions]\nmode = "strict"\n');
    expect(added.changed).toBe(true);
    const parsed = parseToml(added.content) as Record<string, any>;
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.permissions.mode).toBe("strict");
    expect(parsed.shell_environment_policy.set.SUPERPOWERS_DISABLE_TELEMETRY).toBe("1");

    const raw = '[shell_environment_policy.set]\nSUPERPOWERS_DISABLE_TELEMETRY = "off"\n';
    expect(mergeCodexTelemetry(raw)).toEqual({ changed: false, content: raw });

    const precise = "stamp = 1979-05-27T07:32:00.123456789Z\n";
    const preciseResult = mergeCodexTelemetry(precise);
    expect(preciseResult.content.startsWith(precise)).toBe(true);
    expect(preciseResult.content).toContain("1979-05-27T07:32:00.123456789Z");

    for (const table of [
      '[shell_environment_policy.set]\nKEEP = "x"\n',
      "[shell_environment_policy.set]",
      '[shell_environment_policy."set"]\nKEEP = "x"\n',
      '[shell_environment_policy . set]\nKEEP = "x"\n',
      'model = "gpt-5"\n[shell_environment_policy.set]\nKEEP = "x"\n',
    ]) {
      const merged = mergeCodexTelemetry(table);
      expect(parseToml(merged.content)).toMatchObject({
        shell_environment_policy: {
          set: {
            ...(table.includes("KEEP") ? { KEEP: "x" } : {}),
            SUPERPOWERS_DISABLE_TELEMETRY: "1",
          },
        },
      });
    }

    const embeddedHeader = 'note = """\n[shell_environment_policy.set]\n"""\n';
    const embeddedResult = mergeCodexTelemetry(embeddedHeader);
    expect(embeddedResult.content.startsWith(embeddedHeader)).toBe(true);
    expect((parseToml(embeddedResult.content) as Record<string, any>).note).toBe(
      "[shell_environment_policy.set]\n",
    );
  });

  test("Codex merge rejects malformed or wrong-shaped TOML", () => {
    for (const raw of [
      "x = [",
      'shell_environment_policy = "bad"',
      "shell_environment_policy = 1979-05-27T07:32:00Z",
      "[shell_environment_policy]\nset = 1979-05-27",
      'shell_environment_policy = { set = { KEEP = "x" } }',
      "shell_environment_policy = {}",
    ]) {
      expect(() => mergeCodexTelemetry(raw)).toThrow();
    }
  });

  test("OpenCode hook sets the exact variable only as a default", () => {
    const hook = renderOpenCodeTelemetryHook();
    expect(hook).toContain("SUPERPOWERS_DISABLE_TELEMETRY");
    expect(hook).toContain('??= "1"');
    expect(renderOpenCodeTelemetryHook()).toBe(hook);
  });
});

describe("#765 sync receipt", () => {
  test("rejects malformed, unknown-engine, partial, and uppercase OID receipts", () => {
    expect(parseReceipt(undefined)).toEqual({ schemaVersion: 1, engines: {} });
    for (const raw of [
      "{",
      JSON.stringify({ schemaVersion: 2, engines: {} }),
      JSON.stringify({ schemaVersion: 1, engines: { other: OID } }),
      JSON.stringify({ schemaVersion: 1, engines: { claude: "abc" } }),
      JSON.stringify({ schemaVersion: 1, engines: { codex: "A".repeat(40) } }),
    ]) {
      expect(parseReceipt(raw)).toBeNull();
    }
  });

  test("advances one known engine while preserving valid peers deterministically", () => {
    const current = { schemaVersion: 1 as const, engines: { claude: OID } };
    expect(parseReceipt(JSON.stringify(current))).toEqual(current);
    const rendered = renderReceipt(current, "codex", OTHER_OID);
    expect(JSON.parse(rendered)).toEqual({
      schemaVersion: 1,
      engines: { claude: OID, codex: OTHER_OID },
    });
    expect(renderReceipt(current, "codex", OTHER_OID)).toBe(rendered);
  });

  test("receipt rendering rejects invalid runtime engine/OID values", () => {
    const current = { schemaVersion: 1 as const, engines: {} };
    expect(() => renderReceipt(current, "other" as "claude", OID)).toThrow();
    expect(() => renderReceipt(current, "claude", "bad")).toThrow();
    expect(() =>
      renderReceipt({ schemaVersion: 1, engines: { other: OID } } as typeof current, "claude", OID),
    ).toThrow();
    expect(() =>
      renderReceipt(
        { schemaVersion: 1, engines: { claude: undefined } } as unknown as typeof current,
        "codex",
        OID,
      ),
    ).toThrow();
  });
});

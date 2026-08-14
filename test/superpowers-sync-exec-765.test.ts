import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type SuperpowersSyncInject, syncSuperpowers } from "../src/superpowers-sync-exec.js";
import { marketplaceName, renderOpenCodeTelemetryHook } from "../src/superpowers-sync.js";

const OID = "a".repeat(40);
const URL = "https://github.com/obra/superpowers.git";
const HOME = "/home/test";
const MARKET = marketplaceName(OID);
const SELECTOR = `superpowers@${MARKET}`;
const SPEC = `superpowers@git+${URL}#${OID}`;

function harness(
  options: {
    present?: string[];
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    respond?: (
      command: string,
      args: readonly string[],
    ) => {
      status: number | null;
      stdout: string;
      stderr: string;
    };
  } = {},
) {
  const files = new Map(Object.entries(options.files ?? {}));
  const events: string[] = [];
  const lockPath = join("/repo", ".vibeflow", "SKILL_REGISTRY.lock.json");
  const cacheDir = join(HOME, ".vibeflow", "skill-registries", "46b2efb72c6b9d33");
  const inject: SuperpowersSyncInject = {
    homedir: () => HOME,
    platform: "darwin",
    env: { HOME, PATH: "/bin", SECRET_TOKEN: "never-log", ...options.env },
    hasCommand: (command) => (options.present ?? []).includes(command),
    existsSync: (path) => path === cacheDir || files.has(path),
    gitHead: () => OID,
    readFileSync: (path) => {
      if (path === lockPath)
        return JSON.stringify({
          schemaVersion: 1,
          registries: [{ name: "superpowers", url: URL, ref: "main", commitOID: OID }],
        });
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    writeFileSafe: (path, content) => {
      events.push(`write:${path}`);
      files.set(path, content);
    },
    spawnSync: (command, args) => {
      events.push(`spawn:${command} ${args.join(" ")}`);
      return options.respond?.(command, args) ?? { status: 0, stdout: "", stderr: "" };
    },
  };
  return { inject, events, files };
}

function receiptPath(): string {
  return join(HOME, ".vibeflow", "superpowers-sync.json");
}

function marketplacePath(): string {
  return join(
    HOME,
    ".vibeflow",
    "superpowers-marketplaces",
    MARKET,
    ".claude-plugin",
    "marketplace.json",
  );
}

describe("#765 Superpowers sync execution", () => {
  test("dry-run uses presence only, stays deterministic, and performs zero I/O mutation", () => {
    const h = harness({ present: ["claude", "opencode"] });
    const result = syncSuperpowers("/repo", {}, h.inject);

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      commitOID: OID,
      results: [
        { engine: "claude", status: "planned", commitOID: OID },
        { engine: "codex", status: "skipped", commitOID: OID },
        { engine: "opencode", status: "planned", commitOID: OID },
      ],
    });
    expect(result.results[0]?.actions.join(" ")).toContain(SELECTOR);
    expect(result.results[2]?.actions.join(" ")).toContain(SPEC);
    expect(h.events).toEqual([]);
  });

  test("apply installs Claude and Codex before foreign takeover and records receipts last", () => {
    const lists = { claude: 0, codex: 0 };
    const h = harness({
      present: ["claude", "codex"],
      respond: (command, args) => {
        if (command === "claude" && args.join(" ") === "plugin list --json") {
          lists.claude++;
          return {
            status: 0,
            stdout: JSON.stringify([
              lists.claude === 1
                ? { id: "superpowers@foreign", scope: "user" }
                : { id: SELECTOR, scope: "user" },
            ]),
            stderr: "",
          };
        }
        if (command === "codex" && args.join(" ") === "plugin list --json") {
          lists.codex++;
          return {
            status: 0,
            stdout: JSON.stringify({
              installed: [
                lists.codex === 1
                  ? { pluginId: "superpowers@foreign", source: { sha: "b".repeat(40) } }
                  : { pluginId: SELECTOR, source: { sha: OID } },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.ok).toBe(true);
    expect(result.results.map(({ engine, status }) => ({ engine, status }))).toEqual([
      { engine: "claude", status: "installed" },
      { engine: "codex", status: "installed" },
      { engine: "opencode", status: "skipped" },
    ]);

    const claudeInstall = h.events.indexOf(`spawn:claude plugin install ${SELECTOR} --scope user`);
    const claudeRemove = h.events.indexOf(
      "spawn:claude plugin uninstall superpowers@foreign --scope user -y",
    );
    const codexInstall = h.events.indexOf(`spawn:codex plugin add ${SELECTOR} --json`);
    const codexRemove = h.events.indexOf("spawn:codex plugin remove superpowers@foreign --json");
    expect(claudeInstall).toBeGreaterThan(-1);
    expect(claudeRemove).toBeGreaterThan(claudeInstall);
    expect(codexInstall).toBeGreaterThan(-1);
    expect(codexRemove).toBeGreaterThan(codexInstall);
    expect(h.events.filter((event) => event === `write:${receiptPath()}`)).toHaveLength(2);
    expect(h.events.at(-1)).toBe(`write:${receiptPath()}`);
    expect(JSON.parse(h.files.get(receiptPath()) ?? "{}")).toEqual({
      schemaVersion: 1,
      engines: { claude: OID, codex: OID },
    });
    expect(JSON.parse(h.files.get(marketplacePath()) ?? "{}").plugins[0].source.sha).toBe(OID);
  });

  test("OpenCode merges exact config and hook, loads natively, then records receipt", () => {
    const configPath = join(HOME, ".config", "opencode", "opencode.json");
    const hookPath = join(HOME, ".config", "opencode", "plugins", "vf-superpowers-env.js");
    const h = harness({
      present: ["opencode"],
      files: {
        [configPath]: JSON.stringify({ plugin: ["keep", `superpowers@git+${URL}`], keep: true }),
      },
      respond: () => ({
        status: 0,
        stdout: JSON.stringify({ plugin: ["keep", SPEC] }),
        stderr: "",
      }),
    });

    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[2]?.status).toBe("installed");
    expect(JSON.parse(h.files.get(configPath) ?? "{}")).toEqual({
      plugin: ["keep", SPEC],
      keep: true,
    });
    expect(h.files.get(hookPath)).toBe(renderOpenCodeTelemetryHook());
    expect(h.events.indexOf(`write:${configPath}`)).toBeLessThan(
      h.events.indexOf("spawn:opencode debug config"),
    );
    expect(h.events.indexOf(`write:${hookPath}`)).toBeLessThan(
      h.events.indexOf("spawn:opencode debug config"),
    );
    expect(h.events.at(-1)).toBe(`write:${receiptPath()}`);
  });

  test("OpenCode honors OPENCODE_CONFIG_DIR without adding another opencode directory", () => {
    const h = harness({
      present: ["opencode"],
      env: { OPENCODE_CONFIG_DIR: "/custom" },
      files: { "/custom/opencode.json": "{}" },
      respond: () => ({ status: 0, stdout: JSON.stringify({ plugin: [SPEC] }), stderr: "" }),
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[2]?.status).toBe("installed");
    expect(h.files.has("/custom/opencode.json")).toBe(true);
    expect(h.files.get("/custom/plugins/vf-superpowers-env.js")).toBe(
      renderOpenCodeTelemetryHook(),
    );
    expect(h.events.some((event) => event.includes("/custom/opencode/opencode.json"))).toBe(false);
  });

  test("OpenCode custom config path keeps telemetry hook in the global plugin directory", () => {
    const h = harness({
      present: ["opencode"],
      env: { OPENCODE_CONFIG: "/custom/config.json" },
      files: { "/custom/config.json": "{}" },
      respond: () => ({ status: 0, stdout: JSON.stringify({ plugin: [SPEC] }), stderr: "" }),
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[2]?.status).toBe("installed");
    expect(h.files.get(join(HOME, ".config", "opencode", "plugins", "vf-superpowers-env.js"))).toBe(
      renderOpenCodeTelemetryHook(),
    );
    expect(h.files.has("/custom/plugins/vf-superpowers-env.js")).toBe(false);
  });

  test("Claude refreshes a present selector when receipt cannot prove its commit", () => {
    let lists = 0;
    const h = harness({
      present: ["claude"],
      respond: (command, args) => {
        if (command === "claude" && args.join(" ") === "plugin list --json") {
          lists++;
          return {
            status: 0,
            stdout: JSON.stringify([{ id: SELECTOR, scope: "user" }]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[0]?.status).toBe("installed");
    expect(h.events).toContain(`spawn:claude plugin uninstall ${SELECTOR} --scope user -y`);
    expect(h.events).toContain(`spawn:claude plugin marketplace remove ${MARKET} --scope user`);
    expect(h.events).toContain(`spawn:claude plugin install ${SELECTOR} --scope user`);
    expect(lists).toBe(2);
  });

  test("Codex repairs a desired selector whose structured SHA is stale", () => {
    let lists = 0;
    const h = harness({
      present: ["codex"],
      respond: (command, args) => {
        if (command === "codex" && args.join(" ") === "plugin list --json") {
          lists++;
          return {
            status: 0,
            stdout: JSON.stringify({
              installed: [
                { pluginId: SELECTOR, source: { sha: lists === 1 ? "b".repeat(40) : OID } },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[1]?.status).toBe("installed");
    expect(h.events).toContain(`spawn:codex plugin remove ${SELECTOR} --json`);
    expect(h.events).toContain(`spawn:codex plugin add ${SELECTOR} --json`);
    expect(lists).toBe(2);
  });

  test("native postcondition failure does not write a receipt", () => {
    const h = harness({
      present: ["codex"],
      respond: (command, args) =>
        command === "codex" && args.join(" ") === "plugin list --json"
          ? { status: 0, stdout: JSON.stringify({ installed: [] }), stderr: "" }
          : { status: 0, stdout: "{}", stderr: "" },
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[1]?.status).toBe("failed");
    expect(h.files.has(receiptPath())).toBe(false);
  });

  test("OpenCode resolved config must report the exact spec before receipt", () => {
    const h = harness({
      present: ["opencode"],
      respond: () => ({ status: 0, stdout: JSON.stringify({ plugin: [] }), stderr: "" }),
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[2]?.status).toBe("failed");
    expect(h.files.has(receiptPath())).toBe(false);
  });

  test("matching native state, telemetry config, hook, and receipt are already-current", () => {
    const claudeSettings = join(HOME, ".claude", "settings.json");
    const codexConfig = join(HOME, ".codex", "config.toml");
    const openConfig = join(HOME, ".config", "opencode", "opencode.json");
    const hook = join(HOME, ".config", "opencode", "plugins", "vf-superpowers-env.js");
    const h = harness({
      present: ["claude", "codex", "opencode"],
      files: {
        [claudeSettings]: JSON.stringify({ env: { SUPERPOWERS_DISABLE_TELEMETRY: "off" } }),
        [codexConfig]: '[shell_environment_policy.set]\nSUPERPOWERS_DISABLE_TELEMETRY = "off"\n',
        [openConfig]: JSON.stringify({ plugin: [SPEC] }),
        [hook]: renderOpenCodeTelemetryHook(),
        [receiptPath()]: JSON.stringify({
          schemaVersion: 1,
          engines: { claude: OID, codex: OID, opencode: OID },
        }),
      },
      respond: (command, args) => {
        if (command === "claude" && args.join(" ") === "plugin list --json")
          return {
            status: 0,
            stdout: JSON.stringify([{ id: SELECTOR, scope: "user" }]),
            stderr: "",
          };
        if (command === "codex" && args.join(" ") === "plugin list --json")
          return {
            status: 0,
            stdout: JSON.stringify({ installed: [{ pluginId: SELECTOR, source: { sha: OID } }] }),
            stderr: "",
          };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results.map((item) => item.status)).toEqual([
      "already-current",
      "already-current",
      "already-current",
    ]);
    expect(h.events).toEqual(["spawn:claude plugin list --json", "spawn:codex plugin list --json"]);
  });

  test("one engine failure is isolated and reported with bounded sanitized detail", () => {
    const bearer = `bearer-${"secret"}`;
    const assignment = `OPENAI_API_KEY=assignment-${"secret"}`;
    const poison = `failure at /Users/alice/private Authorization: Bearer ${bearer} ${assignment} https://user:pass@example.test/x?token=abc&access_token=query-secret\u001b[31m${"x".repeat(900)}`;
    let codexLists = 0;
    const h = harness({
      present: ["claude", "codex", "opencode"],
      respond: (command, args) => {
        if (command === "claude" && args.join(" ") === "plugin list --json")
          return { status: 1, stdout: "", stderr: poison };
        if (command === "codex" && args.join(" ") === "plugin list --json") {
          codexLists++;
          return {
            status: 0,
            stdout: JSON.stringify({
              installed: codexLists === 1 ? [] : [{ pluginId: SELECTOR, source: { sha: OID } }],
            }),
            stderr: "",
          };
        }
        if (command === "opencode" && args.join(" ") === "debug config")
          return { status: 0, stdout: JSON.stringify({ plugin: [SPEC] }), stderr: "" };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.ok).toBe(false);
    expect(result.results.map((item) => item.status)).toEqual(["failed", "installed", "installed"]);
    const detail = result.results[0]?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail).not.toContain("pass");
    expect(detail).not.toContain("token=abc");
    expect(detail).not.toContain("query-secret");
    expect(detail).not.toContain(bearer);
    expect(detail).not.toContain(assignment);
    expect(detail).not.toContain("alice");
    expect(detail).not.toContain("\u001b");
    expect(JSON.stringify(result)).not.toContain("never-log");
    expect(h.events).toContain("spawn:opencode debug config");
  });

  test("missing or malformed lock fails globally before any engine operation", () => {
    const h = harness({ present: ["claude"] });
    h.inject.readFileSync = () => "{";
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.ok).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.error).toContain("malformed");
    expect(h.events).toEqual([]);
  });

  test("malformed receipt fails globally before native engine operations", () => {
    const h = harness({
      present: ["claude"],
      files: { [receiptPath()]: "{" },
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result).toMatchObject({
      ok: false,
      error: "Superpowers sync receipt is malformed",
      results: [],
    });
    expect(h.events).toEqual([]);
  });

  test("foreign native selectors remaining after removal block the receipt", () => {
    const h = harness({
      present: ["claude"],
      respond: (command, args) =>
        command === "claude" && args.join(" ") === "plugin list --json"
          ? {
              status: 0,
              stdout: JSON.stringify([
                { id: SELECTOR, scope: "user" },
                { id: "superpowers@foreign", scope: "user" },
              ]),
              stderr: "",
            }
          : { status: 0, stdout: "{}", stderr: "" },
    });
    const result = syncSuperpowers("/repo", { yes: true }, h.inject);
    expect(result.results[0]?.status).toBe("failed");
    expect(h.files.has(receiptPath())).toBe(false);
  });
});

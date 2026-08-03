import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import {
  DEFAULT_FAILURE_PROTECTION,
  DEFAULT_SETTINGS,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TIMEOUT_SECONDS,
  priorityRank,
  readSettings,
  settingsPath,
  writeSettings,
} from "../src/settings.js";
import { DEFAULT_CURATOR_SETTINGS } from "../src/skills/curator-settings.js";

/** Make a throwaway repo dir and return its path. */
function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-settings-"));
}

/** Write a raw settings file (bypassing writeSettings) to simulate old/partial/corrupt files. */
function writeRaw(base: string, content: string): void {
  const p = settingsPath(base);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const FIXED = "2026-01-02T03:04:05.000Z";
const fixedNow = () => FIXED;

describe("settings.defaults", () => {
  test("readSettings on an empty repo returns the defaults (tools on, codegraph>lsp>native)", () => {
    const dir = tmpRepo();
    try {
      const s = readSettings(dir);
      expect(s.tools).toEqual({ codegraph: true, lsp: true });
      expect(s.toolPriority).toEqual(["codegraph", "lsp", "native"]);
      expect(s).toEqual(DEFAULT_SETTINGS);
      // returned object is a COPY — mutating it must not poison the shared default
      s.tools.codegraph = true;
      expect(DEFAULT_SETTINGS.tools.codegraph).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settingsPath resolves inside the canonical .vibeflow dir", () => {
    const dir = tmpRepo();
    try {
      expect(settingsPath(dir)).toBe(join(dir, CTX_DIR, "SETTINGS.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.roundTrip", () => {
  test("writeSettings then readSettings returns written values and stamps updatedAt", () => {
    const dir = tmpRepo();
    try {
      const written = writeSettings(
        dir,
        { tools: { codegraph: true, lsp: true }, lspServers: ["typescript-language-server"] },
        { now: fixedNow },
      );
      expect(written.updatedAt).toBe(FIXED);

      const read = readSettings(dir);
      expect(read.tools).toEqual({ codegraph: true, lsp: true });
      expect(read.lspServers).toEqual(["typescript-language-server"]);
      expect(read.updatedAt).toBe(FIXED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSettings is read-modify-write: a second partial write preserves earlier keys", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { tools: { codegraph: true, lsp: false } }, { now: fixedNow });
      const second = writeSettings(
        dir,
        { toolPriority: ["lsp", "codegraph", "native"] },
        {
          now: fixedNow,
        },
      );
      expect(second.tools).toEqual({ codegraph: true, lsp: false });
      expect(second.toolPriority).toEqual(["lsp", "codegraph", "native"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.forwardCompat", () => {
  test("a file missing new keys is merged over defaults (kept keys win, rest defaulted)", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ tools: { codegraph: true } }));
      const s = readSettings(dir);
      expect(s.tools.codegraph).toBe(true);
      expect(s.tools.lsp).toBe(true); // filled from defaults
      expect(s.toolPriority).toEqual(["codegraph", "lsp", "native"]); // filled from defaults
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.resilience", () => {
  test("corrupt JSON yields defaults and never throws", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, "{ this is : not json ");
      const s = readSettings(dir);
      expect(s).toEqual(DEFAULT_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid toolPriority falls back to the default order", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ toolPriority: ["bogus", "native"] }));
      const s = readSettings(dir);
      expect(s.toolPriority).toEqual(["codegraph", "lsp", "native"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid-but-incomplete toolPriority is filled with the missing tiers", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ toolPriority: ["native", "codegraph"] }));
      const s = readSettings(dir);
      // dedup + keep declared order, then append any missing tiers
      expect(s.toolPriority).toEqual(["native", "codegraph", "lsp"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate entries in toolPriority are de-duplicated", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ toolPriority: ["lsp", "lsp", "codegraph"] }));
      const s = readSettings(dir);
      expect(s.toolPriority).toEqual(["lsp", "codegraph", "native"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-boolean tools fields fall back to defaults", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ tools: { codegraph: "yes", lsp: 1 } }));
      const s = readSettings(dir);
      expect(s.tools).toEqual({ codegraph: true, lsp: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.failureProtection", () => {
  test("defaults are conservative (3600s timeout, all protections off)", () => {
    const dir = tmpRepo();
    try {
      const s = readSettings(dir);
      expect(s.failureProtection).toEqual(DEFAULT_FAILURE_PROTECTION);
      expect(s.failureProtection.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
      expect(s.failureProtection.autoWip).toBe(false);
      expect(s.failureProtection.rollbackOnFail).toBe(false);
      expect(s.failureProtection.requireGit).toBe(false);
      // returned block is a COPY — mutating it must not poison the shared default
      s.failureProtection.autoWip = true;
      expect(DEFAULT_FAILURE_PROTECTION.autoWip).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a partial failureProtection write, preserving other keys", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { tools: { codegraph: true, lsp: false } }, { now: fixedNow });
      const written = writeSettings(
        dir,
        { failureProtection: { ...DEFAULT_FAILURE_PROTECTION, autoWip: true, requireGit: true } },
        { now: fixedNow },
      );
      expect(written.failureProtection.autoWip).toBe(true);
      expect(written.failureProtection.requireGit).toBe(true);
      expect(written.tools.codegraph).toBe(true); // earlier write preserved
      expect(readSettings(dir).failureProtection.autoWip).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file missing failureProtection is forward-merged over defaults", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ tools: { codegraph: true } }));
      const s = readSettings(dir);
      expect(s.failureProtection).toEqual(DEFAULT_FAILURE_PROTECTION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-numeric / negative / wrong-typed fields fall back to defaults", () => {
    const dir = tmpRepo();
    try {
      writeRaw(
        dir,
        JSON.stringify({
          failureProtection: { timeoutSeconds: -5, autoWip: "yes", rollbackOnFail: 1 },
        }),
      );
      const s = readSettings(dir);
      expect(s.failureProtection.timeoutSeconds).toBe(0); // clamped to >= 0
      expect(s.failureProtection.autoWip).toBe(false); // string ignored
      expect(s.failureProtection.rollbackOnFail).toBe(false); // number ignored
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid custom timeout is preserved", () => {
    const dir = tmpRepo();
    try {
      writeRaw(
        dir,
        JSON.stringify({ failureProtection: { timeoutSeconds: 120, requireGit: true } }),
      );
      const s = readSettings(dir);
      expect(s.failureProtection.timeoutSeconds).toBe(120);
      expect(s.failureProtection.requireGit).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.memory", () => {
  test("defaults to false on an empty repo (PR #160: truth-tell default)", () => {
    const dir = tmpRepo();
    try {
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips an explicit false through writeSettings", () => {
    const dir = tmpRepo();
    try {
      const written = writeSettings(dir, { memory: false }, { now: fixedNow });
      expect(written.memory).toBe(false);
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial write that omits memory preserves the stored value", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: false }, { now: fixedNow });
      const second = writeSettings(
        dir,
        { tools: { codegraph: true, lsp: false } },
        { now: fixedNow },
      );
      expect(second.memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file missing memory is defaulted to false (PR #160: truth-tell default)", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ tools: { codegraph: true } }));
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrong-typed memory field falls back to false", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ memory: "nope" }));
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.notifications", () => {
  test("defaults to true on an empty repo (#559)", () => {
    const dir = tmpRepo();
    try {
      expect(readSettings(dir).notifications).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips an explicit false through writeSettings", () => {
    const dir = tmpRepo();
    try {
      const written = writeSettings(dir, { notifications: false }, { now: fixedNow });
      expect(written.notifications).toBe(false);
      expect(readSettings(dir).notifications).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file missing notifications forward-merges to the default true", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ tools: { codegraph: true } }));
      expect(readSettings(dir).notifications).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a garbage notifications value stays true", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ notifications: "nope" }));
      expect(readSettings(dir).notifications).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.priorityRank", () => {
  test("default order: codegraph > lsp > native", () => {
    const rank = priorityRank(DEFAULT_SETTINGS);
    expect(rank.codegraph).toBeGreaterThan(rank.lsp);
    expect(rank.lsp).toBeGreaterThan(rank.native);
  });

  test("reordering the array changes the ranks accordingly", () => {
    const rank = priorityRank({
      ...DEFAULT_SETTINGS,
      toolPriority: ["native", "lsp", "codegraph"],
    });
    expect(rank.native).toBeGreaterThan(rank.lsp);
    expect(rank.lsp).toBeGreaterThan(rank.codegraph);
  });
});

describe("settings.hooks (guardrail policy)", () => {
  test("a repo that never configured hooks keeps an ABSENT hooks block", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, {}, { now: fixedNow });
      expect(readSettings(dir).hooks).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a present-but-garbage hooks block coerces to the all-on default", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ hooks: "nonsense" }));
      const s = readSettings(dir);
      expect(s.hooks?.templates).toEqual([
        "block-destructive",
        "flag-installs",
        "protect-secrets",
        "protect-config",
        "workspace-guard",
      ]);
      expect(s.hooks?.custom).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit template subset round-trips through write→read", () => {
    const dir = tmpRepo();
    try {
      writeSettings(
        dir,
        {
          hooks: {
            templates: ["block-destructive", "protect-secrets"],
            custom: [{ name: "no-prod", kind: "command", pattern: "deploy prod", risk: "high" }],
          },
        },
        { now: fixedNow },
      );
      const s = readSettings(dir);
      expect(s.hooks?.templates).toEqual(["block-destructive", "protect-secrets"]);
      expect(s.hooks?.custom[0]?.name).toBe("no-prod");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSettings preserves an existing hooks block when next omits it", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { hooks: { templates: [], custom: [] } }, { now: fixedNow });
      // A later unrelated write (e.g. enabling a tool) must not re-expand hooks.
      writeSettings(dir, { tools: { codegraph: true, lsp: false } }, { now: fixedNow });
      expect(readSettings(dir).hooks?.templates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.skills (#687)", () => {
  test("DEFAULT_SETTINGS carries the default skills block", () => {
    expect(DEFAULT_SETTINGS.skills).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  test("an empty repo returns the default skills block (autoResolve on, pointer, all engines)", () => {
    const dir = tmpRepo();
    try {
      expect(readSettings(dir).skills).toEqual(DEFAULT_SKILLS_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid skills block round-trips through write→read", () => {
    const dir = tmpRepo();
    try {
      const skills = {
        autoResolve: false,
        mirrorMode: "full" as const,
        targetEngines: ["claude" as const, "codex" as const],
      };
      const written = writeSettings(dir, { skills }, { now: fixedNow });
      expect(written.skills).toEqual(skills);
      expect(readSettings(dir).skills).toEqual(skills);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid engines are dropped; all-invalid falls back to all ENGINES", () => {
    const dir = tmpRepo();
    try {
      // force a raw file to exercise coerce with a bogus engine list
      writeRaw(
        dir,
        JSON.stringify({ skills: { autoResolve: false, targetEngines: ["bogus", "codex"] } }),
      );
      const read = readSettings(dir);
      expect(read.skills?.targetEngines).toEqual(["codex"]);
      expect(read.skills?.autoResolve).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a garbage skills field falls back to defaults", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ skills: "nonsense" }));
      expect(readSettings(dir).skills).toEqual(DEFAULT_SKILLS_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial skills write preserves unmentioned fields via coerce", () => {
    const dir = tmpRepo();
    try {
      writeSettings(
        dir,
        {
          skills: {
            autoResolve: false,
            mirrorMode: "pointer",
            targetEngines: [...DEFAULT_SKILLS_CONFIG.targetEngines],
          },
        },
        { now: fixedNow },
      );
      // later unrelated write keeps the stored skills block
      writeSettings(dir, { tools: { codegraph: true, lsp: false } }, { now: fixedNow });
      expect(readSettings(dir).skills?.autoResolve).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings.curator (#689)", () => {
  test("DEFAULT_SETTINGS carries the default curator block", () => {
    expect(DEFAULT_SETTINGS.curator).toEqual(DEFAULT_CURATOR_SETTINGS);
  });

  test("an empty repo returns the default curator block (off, observe, Mon 9am, medium)", () => {
    const dir = tmpRepo();
    try {
      expect(readSettings(dir).curator).toEqual(DEFAULT_CURATOR_SETTINGS);
      expect(readSettings(dir).curator).toEqual({
        enabled: false,
        observeMode: true,
        schedule: "0 9 * * 1",
        severityThreshold: "medium",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit observe-mode toggle round-trips through write→read (#689)", () => {
    const dir = tmpRepo();
    try {
      const written = writeSettings(
        dir,
        { curator: { ...DEFAULT_CURATOR_SETTINGS, enabled: true, observeMode: false } },
        { now: fixedNow },
      );
      expect(written.curator?.observeMode).toBe(false);
      expect(readSettings(dir).curator).toEqual({
        enabled: true,
        observeMode: false,
        schedule: "0 9 * * 1",
        severityThreshold: "medium",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid custom block round-trips (schedule + threshold preserved)", () => {
    const dir = tmpRepo();
    try {
      writeRaw(
        dir,
        JSON.stringify({
          curator: {
            enabled: true,
            observeMode: false,
            schedule: "30 2 * * *",
            severityThreshold: "high",
          },
        }),
      );
      expect(readSettings(dir).curator).toEqual({
        enabled: true,
        observeMode: false,
        schedule: "30 2 * * *",
        severityThreshold: "high",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closed enum: an unknown severityThreshold falls back to the default", () => {
    const dir = tmpRepo();
    try {
      writeRaw(
        dir,
        JSON.stringify({
          curator: { enabled: true, severityThreshold: "critical", schedule: "30 2 * * *" },
        }),
      );
      const c = readSettings(dir).curator;
      expect(c?.severityThreshold).toBe("medium");
      expect(c?.enabled).toBe(true); // unrelated fields kept
      expect(c?.schedule).toBe("30 2 * * *");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cron validation: non-five-field, overlong, or garbage schedules fall back to default", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ curator: { enabled: true, schedule: "0 9 * *" } }));
      const four = readSettings(dir).curator;
      expect(four?.schedule).toBe("0 9 * * 1");
      expect(four?.enabled).toBe(true); // non-schedule fields survive

      writeRaw(dir, JSON.stringify({ curator: { schedule: "R".repeat(140) } }));
      expect(readSettings(dir).curator?.schedule).toBe("0 9 * * 1");

      writeRaw(dir, JSON.stringify({ curator: { schedule: "0 9 * * monday" } }));
      expect(readSettings(dir).curator?.schedule).toBe("0 9 * * 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a garbage curator block falls back to defaults", () => {
    const dir = tmpRepo();
    try {
      writeRaw(dir, JSON.stringify({ curator: "nonsense" }));
      expect(readSettings(dir).curator).toEqual(DEFAULT_CURATOR_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial curator write preserves unmentioned fields via coerce", () => {
    const dir = tmpRepo();
    try {
      writeSettings(
        dir,
        { curator: { ...DEFAULT_CURATOR_SETTINGS, enabled: true } },
        { now: fixedNow },
      );
      writeSettings(dir, { tools: { codegraph: true, lsp: false } }, { now: fixedNow });
      const c = readSettings(dir).curator;
      expect(c?.enabled).toBe(true);
      expect(c?.observeMode).toBe(true);
      expect(c?.schedule).toBe("0 9 * * 1");
      expect(c?.severityThreshold).toBe("medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

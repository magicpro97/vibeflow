import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import type { LockVerifyResult } from "../src/skills/verify-lock.js";
import { setSkillStatus, setStatusInText, verifySkillCommand } from "../src/skills/verify.js";

const CTX_DIR = ".vibeflow";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-verify-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scaffold(name: string, lines: string[]): string {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  const md = join(dir, "SKILL.md");
  writeFileSync(md, lines.join("\n"));
  return md;
}

const VALID_BODY = [
  "",
  "## When to use",
  "Use when x.",
  "## When NOT to use",
  "Do not use when y.",
  "## Steps",
  "1. Do the task.",
  "## Verification",
  "Check output.",
  "",
];

// ── setStatusInText (pure) ────────────────────────────────────────────────
describe("setStatusInText", () => {
  test("inserts status line when frontmatter has none", () => {
    const r = setStatusInText(
      ["---", "name: s", "description: d", "---", "body"].join("\n"),
      "verified",
    );
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("status: verified");
    expect(r.text).toContain("body");
  });

  test("replaces an existing status line", () => {
    const r = setStatusInText(
      ["---", "name: s", "status: unverified", "description: d", "---", "b"].join("\n"),
      "verified",
    );
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("status: verified");
    expect(r.text).not.toContain("status: unverified");
  });

  test("idempotent when status already matches", () => {
    const r = setStatusInText(["---", "status: verified", "---", "b"].join("\n"), "verified");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
  });

  test("idempotent path returns the ORIGINAL bytes (no CRLF normalization) (#433 review)", () => {
    const original = "---\r\nstatus: verified\r\n---\r\nbody";
    const r = setStatusInText(original, "verified");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(original); // changed:false ⟺ zero byte change
  });

  test("demote replaces verified → unverified", () => {
    const r = setStatusInText(["---", "status: verified", "---", "b"].join("\n"), "unverified");
    expect(r.changed).toBe(true);
    expect(r.text).toContain("status: unverified");
  });

  test("refuses when no leading fence", () => {
    const r = setStatusInText("no frontmatter here", "verified");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no frontmatter");
  });

  test("refuses when closing fence missing", () => {
    const r = setStatusInText(["---", "name: s", "no closing fence"].join("\n"), "verified");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unterminated");
  });

  test("normalizes CRLF", () => {
    const r = setStatusInText("---\r\nname: s\r\n---\r\nbody", "verified");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("status: verified");
    expect(r.text).not.toContain("\r");
  });
});

// ── setSkillStatus (I/O via injected seam) ────────────────────────────────
describe("setSkillStatus", () => {
  const text = ["---", "name: s", "description: d", "---", "b"].join("\n");

  test("not found → ok:false", () => {
    const r = setSkillStatus("/nope/SKILL.md", "verified", {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSafe: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });

  test("changed → writes the new text", () => {
    let written = "";
    const r = setSkillStatus("/x/SKILL.md", "verified", {
      existsSync: () => true,
      readFileSync: () => text,
      writeFileSafe: (_p, c) => {
        written = c;
      },
    });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(written).toContain("status: verified");
  });

  test("unchanged → does NOT write", () => {
    let wrote = false;
    const r = setSkillStatus("/x/SKILL.md", "verified", {
      existsSync: () => true,
      readFileSync: () => ["---", "status: verified", "---", "b"].join("\n"),
      writeFileSafe: () => {
        wrote = true;
      },
    });
    expect(r.changed).toBe(false);
    expect(wrote).toBe(false);
  });

  test("malformed (no frontmatter) → ok:false, no write", () => {
    let wrote = false;
    const r = setSkillStatus("/x/SKILL.md", "verified", {
      existsSync: () => true,
      readFileSync: () => "garbage",
      writeFileSafe: () => {
        wrote = true;
      },
    });
    expect(r.ok).toBe(false);
    expect(wrote).toBe(false);
  });
});

// ── vf skills verify (command arm) ────────────────────────────────────────
describe("skills verify command", () => {
  async function run(rest: string[]): Promise<number> {
    const orig = process.cwd();
    process.chdir(base);
    try {
      return await skills("verify", rest);
    } finally {
      process.chdir(orig);
    }
  }

  test("promotes an unverified skill → file gets status: verified", async () => {
    const md = scaffold("good", ["---", "name: good", "description: d", "---", ...VALID_BODY]);
    expect(await run(["good"])).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("status: verified");
  });

  test("--undo demotes back to unverified", async () => {
    const md = scaffold("good", [
      "---",
      "name: good",
      "status: verified",
      "description: d",
      "---",
      ...VALID_BODY,
    ]);
    expect(await run(["good", "--undo"])).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("status: unverified");
  });

  test("already verified → exit 0, no change", async () => {
    scaffold("good", [
      "---",
      "name: good",
      "status: verified",
      "description: d",
      "---",
      ...VALID_BODY,
    ]);
    expect(await run(["good"])).toBe(0);
  });

  test("invalid name → exit 2", async () => {
    expect(await run(["Bad Name"])).toBe(2);
  });

  test("missing name → exit 2", async () => {
    expect(await run([])).toBe(2);
  });

  test("not found in canonical store → exit 1", async () => {
    expect(await run(["ghost"])).toBe(1);
  });

  test("malformed SKILL.md (no frontmatter) → exit 1", async () => {
    scaffold("bad", ["no frontmatter at all"]);
    expect(await run(["bad"])).toBe(1);
  });

  test("quality errors block promotion", async () => {
    scaffold("huge", [
      "---",
      "name: huge",
      "description: d",
      "---",
      "## When to use",
      "Use.",
      "## When NOT to use",
      "Dont.",
      "## Steps",
      "Steps.",
      "## Verification",
      "Verify.",
      ...Array.from({ length: 510 }, (_, i) => `line ${i}`),
    ]);
    expect(await run(["huge"])).toBe(1);
  });

  test("quality warnings allow promotion", async () => {
    scaffold("warn", [
      "---",
      "name: warn",
      "description: d",
      "---",
      "## When to use",
      "ALWAYS use this and NEVER skip it.",
      "## When NOT to use",
      "Dont.",
      "## Steps",
      "Steps.",
      "## Verification",
      "Verify.",
    ]);
    expect(await run(["warn"])).toBe(0);
  });

  test("set status failure after quality checks → exit 1", () => {
    scaffold("race", ["---", "name: race", "description: d", "---", ...VALID_BODY]);
    const skillMd = join(base, CTX_DIR, "skills", "race", "SKILL.md");
    expect(verifySkillCommand(base, ["race"], {}, { existsSync: (p) => p !== skillMd })).toBe(1);
  });
});

// ── vf skills verify-lock (CLI handler) ─────────────────────────────────

describe("skills verify-lock command", () => {
  async function run(rest: string[]): Promise<number> {
    const orig = process.cwd();
    const origHome = process.env.VF_SKILLS_HOME;
    process.env.VF_SKILLS_HOME = base;
    process.chdir(base);
    try {
      return await skills("verify-lock", rest);
    } finally {
      process.chdir(orig);
      if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
      else process.env.VF_SKILLS_HOME = origHome;
    }
  }

  function mkLock(data: unknown) {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "SKILL_REGISTRY.lock.json"), JSON.stringify(data));
  }

  test("passes when no lock file exists", async () => {
    expect(await run([])).toBe(0);
  });

  test("passes on valid lock with empty registries", async () => {
    mkLock({ schemaVersion: 1, registries: [] });
    expect(await run([])).toBe(0);
  });

  test("fails on malformed lock file", async () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "SKILL_REGISTRY.lock.json"), "bad json");
    expect(await run([])).toBe(1);
  });

  test("fails on root not an object", async () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "SKILL_REGISTRY.lock.json"), '"string"');
    expect(await run([])).toBe(1);
  });

  test("fails on missing registry from catalog", async () => {
    mkLock({
      schemaVersion: 1,
      registries: [
        {
          name: "r",
          url: "https://x",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [{ name: "missing-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
        },
      ],
    });
    expect(await run([])).toBe(1);
  });
});

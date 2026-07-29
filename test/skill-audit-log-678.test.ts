import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { units } from "../src/commands/units.js";
import {
  type SkillAuditEvent,
  appendSkillAudit,
  appendWaiverAudit,
  handleSkillAuditLog,
  readSkillAudit,
  renderSkillAudit,
} from "../src/skills/audit-log.js";
import { parseStatusFromText, verifySkillCommand } from "../src/skills/verify.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-audit-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const auditPath = () => join(base, ".vibeflow", "logs", "skill-audit.jsonl");
const appendDeps = (mkdir = mkdirSync, append = appendFileSync, now?: () => string) => ({
  repo: base,
  mkdir,
  append,
  now,
});
const readDeps = (read = readFileSync, exists = existsSync) => ({ repo: base, read, exists });
const ev = () => ({
  actor: "local",
  action: "verify" as const,
  skillName: null,
  oldStatus: null as string | null,
  newStatus: null as string | null,
  evidence: [] as string[],
  reason: null,
});
const mkLog = () => {
  mkdirSync(join(base, ".vibeflow", "logs"), { recursive: true });
};

describe("appendSkillAudit / readSkillAudit", () => {
  test("append with omitted timestamp succeeds and read has injected ts", () => {
    expect(
      appendSkillAudit(
        { ...ev(), skillName: "my-skill", newStatus: "verified", evidence: ["x"] },
        appendDeps(mkdirSync, appendFileSync, () => "2026-01-01T00:00:00Z"),
      ),
    ).toBe(true);
    const events = readSkillAudit(readDeps());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.ts).toBe("2026-01-01T00:00:00Z");
    expect(e?.actor).toBe("local");
    expect(e?.action).toBe("verify");
    expect(e?.skillName).toBe("my-skill");
    expect(e?.newStatus).toBe("verified");
    expect(e?.evidence).toEqual(["x"]);
  });

  test("skips malformed lines on read", () => {
    mkLog();
    writeFileSync(
      auditPath(),
      '{"ts":"a","actor":"local","action":"verify","skillName":null,"oldStatus":null,"newStatus":null,"evidence":[],"reason":null}\n',
    );
    appendFileSync(auditPath(), "not-json\n", "utf8");
    appendFileSync(
      auditPath(),
      '{"ts":"b","actor":"local","action":"waiver","skillName":null,"oldStatus":null,"newStatus":null,"evidence":["x"],"reason":"r"}\n',
      "utf8",
    );
    expect(readSkillAudit(readDeps())).toHaveLength(2);
  });

  test("invalid action value skipped", () => {
    mkLog();
    writeFileSync(
      auditPath(),
      '{"ts":"a","actor":"local","action":"INVALID","skillName":null,"oldStatus":null,"newStatus":null,"evidence":[],"reason":null}\n',
    );
    expect(readSkillAudit(readDeps())).toHaveLength(0);
  });

  test.each(["ts", "actor", "action", "skillName", "oldStatus", "newStatus", "evidence", "reason"])(
    "stored line missing key '%s' skipped",
    (missing) => {
      const partial = { ...ev(), ts: "a", actor: "local", action: "verify", evidence: [] };
      delete (partial as Record<string, unknown>)[missing];
      mkLog();
      writeFileSync(auditPath(), `${JSON.stringify(partial)}\n`, "utf8");
      expect(readSkillAudit(readDeps())).toHaveLength(0);
    },
  );

  test("no file -> empty array", () => {
    expect(readSkillAudit(readDeps())).toEqual([]);
  });

  test("read i/o failure -> empty array", () => {
    mkLog();
    writeFileSync(
      auditPath(),
      '{"ts":"a","actor":"local","action":"verify","skillName":null,"oldStatus":null,"newStatus":null,"evidence":[],"reason":null}\n',
    );
    expect(
      readSkillAudit(
        readDeps(() => {
          throw new Error("bang");
        }),
      ),
    ).toEqual([]);
  });

  test("append failure returns false", () => {
    expect(
      appendSkillAudit(
        ev(),
        appendDeps(() => {
          throw new Error("nope");
        }),
      ),
    ).toBe(false);
  });

  test("empty actor -> validation rejects", () => {
    expect(appendSkillAudit({ ...ev(), ts: "x", actor: "" }, appendDeps())).toBe(false);
  });

  test("empty evidence string -> validation rejects", () => {
    expect(appendSkillAudit({ ...ev(), actor: "x", evidence: [""] }, appendDeps())).toBe(false);
  });

  test("invalid oldStatus -> validation rejects", () => {
    expect(
      appendSkillAudit(
        { ...ev(), actor: "x", oldStatus: "bogus", newStatus: "verified" },
        appendDeps(),
      ),
    ).toBe(false);
  });
});

describe("appendWaiverAudit", () => {
  test("exact record shape", () => {
    expect(
      appendWaiverAudit(base, "my-unit", "no verified skill", {
        now: () => "2026-06-01T00:00:00Z",
      }),
    ).toBe(true);
    const events = readSkillAudit(readDeps());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.ts).toBe("2026-06-01T00:00:00Z");
    expect(e?.actor).toBe("human");
    expect(e?.action).toBe("waiver");
    expect(e?.skillName).toBeNull();
    expect(e?.oldStatus).toBeNull();
    expect(e?.newStatus).toBeNull();
    expect(e?.evidence).toEqual(["workflow-unit:my-unit"]);
    expect(e?.reason).toBe("no verified skill");
    expect(e?.unitName).toBe("my-unit");
  });

  test("append failure returns false", () => {
    expect(
      appendWaiverAudit(base, "x", "y", {
        mkdir: () => {
          throw new Error("nope");
        },
      }),
    ).toBe(false);
  });
});

describe("renderSkillAudit / handleSkillAuditLog", () => {
  test("empty -> dim message", () => {
    const r = renderSkillAudit([]);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("no skill audit records");
  });

  test("CLI with args -> exit 2", () => {
    expect(handleSkillAuditLog(base, ["extra"])).toBe(2);
  });

  test("CLI no args -> exit 0", () => {
    expect(handleSkillAuditLog(base, [])).toBe(0);
  });

  test("renders evidence and reason", () => {
    const e: SkillAuditEvent = {
      ts: "2026-01-01T00:00:00Z",
      actor: "human",
      action: "waiver",
      skillName: null,
      oldStatus: null,
      newStatus: null,
      evidence: ["workflow-unit:auth"],
      reason: "no verified skill",
      unitName: "auth",
    };
    const lines = renderSkillAudit([e]);
    expect(lines[0]).toContain("waiver");
    expect(lines[0]).toContain("reason=");
    expect(lines[0]).toContain("unit=auth");
    expect(lines[0]).toContain("ev=workflow-unit:auth");
  });
});

describe("verify integration with audit log", () => {
  const scaffold = (name: string, lines: string[]) => {
    const dir = join(base, ".vibeflow", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  };
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

  test("verify missing status -> oldStatus null in audit", () => {
    scaffold("good", ["---", "name: good", "description: d", "---", ...VALID_BODY]);
    expect(verifySkillCommand(base, ["good"], {}, {}, { repo: base })).toBe(0);
    const events = readSkillAudit(readDeps());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.action).toBe("verify");
    expect(e?.oldStatus).toBeNull();
    expect(e?.newStatus).toBe("verified");
    expect(e?.evidence.some((x) => x.startsWith("security-scan:"))).toBe(true);
    expect(e?.evidence).toContain("quality-contract:pass");
  });

  test("verified -> unverified audit oldStatus verified", () => {
    scaffold("good", [
      "---",
      "name: good",
      "status: verified",
      "description: d",
      "---",
      ...VALID_BODY,
    ]);
    expect(verifySkillCommand(base, ["good", "--undo"], {}, {}, { repo: base })).toBe(0);
    const events = readSkillAudit(readDeps());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.action).toBe("unverify");
    expect(e?.newStatus).toBe("unverified");
    expect(e?.oldStatus).toBe("verified");
    expect(e?.evidence).toContain("demotion");
  });

  test("idempotent verify does NOT append audit record", () => {
    scaffold("good", [
      "---",
      "name: good",
      "status: verified",
      "description: d",
      "---",
      ...VALID_BODY,
    ]);
    expect(verifySkillCommand(base, ["good"], {}, {}, { repo: base })).toBe(0);
    expect(readSkillAudit(readDeps())).toHaveLength(0);
  });

  test("audit append failure does not change verify outcome", () => {
    scaffold("good", ["---", "name: good", "description: d", "---", ...VALID_BODY]);
    expect(
      verifySkillCommand(
        base,
        ["good"],
        {},
        {},
        {
          repo: base,
          mkdir: (() => {
            throw new Error("boom");
          }) as typeof mkdirSync,
        },
      ),
    ).toBe(0);
    const md = join(base, ".vibeflow", "skills", "good", "SKILL.md");
    expect(readFileSync(md, "utf8")).toContain("status: verified");
  });
});

describe("waiver integration", () => {
  const scaffoldDefaultTestState = () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(base, ".vibeflow", "WORKFLOW_STATE.json"),
      JSON.stringify({ $schemaVersion: 1, work_units: [] }),
    );
  };
  const runUnits = (sub: string, rest: string[], flags: Record<string, string | boolean> = {}) => {
    const orig = process.cwd();
    process.chdir(base);
    try {
      return units(sub, rest, flags);
    } finally {
      process.chdir(orig);
    }
  };

  test("waiver logs exact reason and actor=human", () => {
    scaffoldDefaultTestState();
    runUnits("add", ["test-unit"]);
    expect(runUnits("waiver", ["test-unit"], { reason: "no verified skill exists" })).toBe(0);
    const events = readSkillAudit(readDeps());
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.action).toBe("waiver");
    expect(e?.actor).toBe("human");
    expect(e?.reason).toBe("no verified skill exists");
    expect(e?.unitName).toBe("test-unit");
    expect(e?.evidence).toEqual(["workflow-unit:test-unit"]);
  });

  test("waiver append failure warns but does not change exit code", () => {
    scaffoldDefaultTestState();
    runUnits("add", ["fail-unit"]);
    mkLog();
    writeFileSync(auditPath(), "");
    rmSync(auditPath());
    mkdirSync(auditPath());
    expect(runUnits("waiver", ["fail-unit"], { reason: "because" })).toBe(0);
  });
});

describe("parseStatusFromText", () => {
  test("returns status value from frontmatter", () => {
    expect(parseStatusFromText("---\nname: x\nstatus: verified\n---\nbody")).toBe("verified");
  });
  test("returns null when no status line", () => {
    expect(parseStatusFromText("---\nname: x\n---\nbody")).toBeNull();
  });
  test("returns null when no frontmatter", () => {
    expect(parseStatusFromText("no frontmatter")).toBeNull();
  });
});

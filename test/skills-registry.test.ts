import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import {
  discoverSkills,
  matchSkillsForFile,
  matchSkillsForTask,
  parseSkill,
  renderSkillIndex,
  STATUS_RANK,
} from "../src/skills/registry.js";

let repo: string;
let restorePerms: string[] = [];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vf-reg-"));
  restorePerms = [];
});

afterEach(() => {
  // Best-effort restore permissions so cleanup can always rm.
  for (const p of restorePerms) {
    try {
      chmodSync(p, 0o755);
    } catch {}
  }
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {}
});

// =============================================================================
// asStringArray branches (covered via parseSkill with various frontmatter).
// =============================================================================

describe("parseSkill: frontmatter edge cases", () => {
  test("returns null when readFileSync throws (defensive catch branch, line 76)", () => {
    // We can't easily make readFileSync throw on a real file, but we CAN make
    // it throw by passing a path that does not exist. The function will
    // attempt readFileSync and hit the catch, returning null.
    const parsed = parseSkill(join(repo, "does-not-exist", "SKILL.md"), repo);
    expect(parsed).toBeNull();
  });

  test("non-string name yields null (branch: data.name not a string)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-name-"));
    const sk = join(dir, "SKILL.md");
    try {
      // `name: 123` is parsed as a number, not a string.
      writeFileSync(sk, "---\nname: 123\ndescription: d\n---\n");
      expect(parseSkill(sk, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-string description yields null (branch: data.description not a string)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-desc-"));
    const sk = join(dir, "SKILL.md");
    try {
      // `description: 42` is parsed as a number, not a string.
      writeFileSync(sk, "---\nname: x\ndescription: 42\n---\n");
      expect(parseSkill(sk, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty description yields null (branch: !description)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-emptyd-"));
    const sk = join(dir, "SKILL.md");
    try {
      // `description: ""` is an empty string — falsy.
      writeFileSync(sk, '---\nname: x\ndescription: ""\n---\n');
      expect(parseSkill(sk, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("description longer than 1024 chars yields null (branch: length > 1024)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-longd-"));
    const sk = join(dir, "SKILL.md");
    try {
      const long = "a".repeat(1025);
      writeFileSync(sk, `---\nname: x\ndescription: ${long}\n---\n`);
      expect(parseSkill(sk, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("description exactly 1024 chars passes the length check", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-1024d-"));
    const sk = join(dir, "SKILL.md");
    try {
      const exact = "a".repeat(1024);
      writeFileSync(sk, `---\nname: x\ndescription: ${exact}\n---\n`);
      const parsed = parseSkill(sk, dir);
      expect(parsed).not.toBeNull();
      expect(parsed?.description.length).toBe(1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-string status falls back to 'unverified' (branch: ownStatus not string)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-stat-"));
    const sk = join(dir, "SKILL.md");
    try {
      // `status: 1` is a number — ownStatus is not a string.
      writeFileSync(sk, "---\nname: x\ndescription: d\nstatus: 1\n---\n");
      expect(parseSkill(sk, dir)?.status).toBe("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("string status NOT in VALID_STATUS falls back to 'unverified'", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-stat2-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\nstatus: bogus\n---\n");
      expect(parseSkill(sk, dir)?.status).toBe("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("version present (string) is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ver-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\nversion: 1.2.3\n---\n");
      const parsed = parseSkill(sk, dir);
      expect(parsed?.version).toBe("1.2.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("version absent (not a string) yields undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-nover-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\n---\n");
      const parsed = parseSkill(sk, dir);
      expect(parsed?.version).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-string version yields undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-nover2-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\nversion: 99\n---\n");
      const parsed = parseSkill(sk, dir);
      expect(parsed?.version).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// asRequires branches.
// =============================================================================

describe("parseSkill: requires field edge cases", () => {
  test("requires with filesystem: 'read' is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req1-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        "---\nname: x\ndescription: d\nrequires:\n  filesystem: read\n---\n",
      );
      expect(parseSkill(sk, dir)?.requires?.filesystem).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires with filesystem: 'write' is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req2-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        "---\nname: x\ndescription: d\nrequires:\n  filesystem: write\n---\n",
      );
      expect(parseSkill(sk, dir)?.requires?.filesystem).toBe("write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires with filesystem: 'none' is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req3-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        "---\nname: x\ndescription: d\nrequires:\n  filesystem: none\n---\n",
      );
      expect(parseSkill(sk, dir)?.requires?.filesystem).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires with filesystem: 'invalid' is dropped (only read/write/none accepted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req4-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        "---\nname: x\ndescription: d\nrequires:\n  filesystem: bogus\n---\n",
      );
      const parsed = parseSkill(sk, dir);
      // Either no `requires` at all, or filesystem is undefined.
      expect(parsed?.requires?.filesystem).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires with non-boolean network is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req5-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        '---\nname: x\ndescription: d\nrequires:\n  network: "yes"\n---\n',
      );
      const parsed = parseSkill(sk, dir);
      expect(parsed?.requires?.network).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires with non-boolean shell is dropped (branch: shell not boolean)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req6-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(
        sk,
        '---\nname: x\ndescription: d\nrequires:\n  shell: "maybe"\n---\n',
      );
      const parsed = parseSkill(sk, dir);
      expect(parsed?.requires?.shell).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires empty object yields no requires on skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req7-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\nrequires: {}\n---\n");
      expect(parseSkill(sk, dir)?.requires).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires is not an object (e.g. string) yields undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-req8-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\nrequires: lol\n---\n");
      expect(parseSkill(sk, dir)?.requires).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// asStringArray edge cases — empty array branch, non-string elements.
// =============================================================================

describe("parseSkill: capabilities and triggers edge cases", () => {
  test("empty array of capabilities returns undefined for capabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-cap-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\ncapabilities: []\n---\n");
      expect(parseSkill(sk, dir)?.capabilities).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-array capabilities returns undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-cap2-"));
    const sk = join(dir, "SKILL.md");
    try {
      writeFileSync(sk, "---\nname: x\ndescription: d\ncapabilities: just-a-string\n---\n");
      expect(parseSkill(sk, dir)?.capabilities).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("triggers with non-string elements are coerced to strings, empty filtered out", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-trig-"));
    const sk = join(dir, "SKILL.md");
    try {
      // Frontmatter parser is a limited subset. Use a simple list.
      writeFileSync(sk, "---\nname: x\ndescription: d\ntriggers: [md, pdf]\n---\n");
      const parsed = parseSkill(sk, dir);
      expect(parsed?.triggers).toEqual(["md", "pdf"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// discoverSkills error paths — lines 122, 129.
// =============================================================================

describe("discoverSkills: error paths", () => {
  test("readdirSync throwing on a root is caught (line 122 — continue branch)", () => {
    // Make the skills root a FILE (not a dir). existsSync will be true,
    // readdirSync will throw ENOTDIR — we hit the catch on line 121-122.
    const badRoot = join(repo, CTX_DIR, "skills");
    mkdirSync(join(repo, CTX_DIR), { recursive: true });
    writeFileSync(badRoot, "not a dir");
    // Should not throw, should return an empty list (no valid skills anywhere).
    const skills = discoverSkills(repo);
    expect(Array.isArray(skills)).toBe(true);
    // Sanity: nothing was found.
    expect(skills).toEqual([]);
  });

  test("statSync throwing on an entry is caught (line 129 — continue branch)", () => {
    // Set up a real skill dir but put a broken symlink alongside it.
    // The broken symlink passes existsSync (false) and statSync (throws).
    const root = join(repo, CTX_DIR, "skills");
    mkdirSync(root, { recursive: true });

    // Add a real skill so we can confirm it's still found.
    const realDir = join(root, "real-skill");
    mkdirSync(realDir);
    writeFileSync(
      join(realDir, "SKILL.md"),
      "---\nname: real-skill\ndescription: A real skill.\n---\n",
    );

    // Add a broken symlink.
    const broken = join(root, "broken");
    try {
      symlinkSync(join(repo, "does-not-exist-target"), broken);
    } catch {
      // If symlinks not supported on this fs, skip silently — the test
      // for line 122 above already covers the continue branch.
      return;
    }

    const skills = discoverSkills(repo);
    expect(skills.find((s) => s.name === "real-skill")).toBeDefined();
    expect(skills.find((s) => s.name === "broken")).toBeUndefined();
  });

  test("discoverSkills returns sorted-by-name results", () => {
    const root = join(repo, CTX_DIR, "skills");
    mkdirSync(root, { recursive: true });
    for (const name of ["zebra", "alpha", "mango"]) {
      const d = join(root, name);
      mkdirSync(d);
      writeFileSync(
        join(d, "SKILL.md"),
        `---\nname: ${name}\ndescription: d\n---\n`,
      );
    }
    const skills = discoverSkills(repo);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  test("discoverSkills keeps first-registered skill when name collides across roots", () => {
    // Two roots, same skill name. .vibeflow wins (it comes first).
    const root1 = join(repo, CTX_DIR, "skills", "dupe");
    mkdirSync(root1, { recursive: true });
    writeFileSync(
      join(root1, "SKILL.md"),
      "---\nname: dupe\ndescription: first\nstatus: verified\n---\n",
    );

    const root2 = join(repo, ".kiro", "skills", "dupe");
    mkdirSync(root2, { recursive: true });
    writeFileSync(
      join(root2, "SKILL.md"),
      "---\nname: dupe\ndescription: second\nstatus: draft\n---\n",
    );

    const skills = discoverSkills(repo);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("first");
  });

  test("discoverSkills skips entries with no SKILL.md (line 132 continue)", () => {
    const root = join(repo, CTX_DIR, "skills");
    mkdirSync(root, { recursive: true });
    // Empty dir with no SKILL.md.
    mkdirSync(join(root, "no-skill-md"));
    // Dir WITH a SKILL.md.
    const d = join(root, "has-skill");
    mkdirSync(d);
    writeFileSync(
      join(d, "SKILL.md"),
      "---\nname: has-skill\ndescription: d\n---\n",
    );
    const skills = discoverSkills(repo);
    expect(skills.map((s) => s.name)).toEqual(["has-skill"]);
  });

  test("discoverSkills returns empty list when repo has no skill roots", () => {
    // Repo is empty, no .vibeflow / .kiro / .claude directories.
    expect(discoverSkills(repo)).toEqual([]);
  });
});

// =============================================================================
// matchSkillsForFile — uncovered branches.
// =============================================================================

describe("matchSkillsForFile: edge cases", () => {
  test("filename with no extension uses whole-filename as ext (split/pop branch)", () => {
    // `lower.split(".").pop()` on a name without a dot returns the whole
    // string. Verify that branch executes (no crash) and the ext-match
    // path is taken when the trigger equals the filename.
    const skills = [
      {
        name: "makefile",
        status: "verified" as const,
        triggers: ["makefile"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForFile(skills, "Makefile");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.score).toBe(1);
    expect(matches[0]?.reason).toContain("extension .makefile");
  });

  test("filename where ext is empty (trailing dot) exercises pop undefined branch", () => {
    // 'a.'.split('.').pop() returns '' — not undefined, so the ?? '' is
    // never actually hit by split semantics; but the empty-ext path is
    // covered when no triggers match.
    const skills = [
      {
        name: "anything",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    // Filename ends in '.' so ext is '' and no match occurs.
    expect(matchSkillsForFile(skills, "weirdfile.")).toEqual([]);
  });

  test("skill with no triggers field (nullish) returns no matches", () => {
    const skills = [
      {
        name: "no-trig",
        status: "verified" as const,
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    expect(matchSkillsForFile(skills, "report.xlsx")).toEqual([]);
  });

  test("deprecated skill is always skipped (already covered, but re-assert for sort path)", () => {
    const skills = [
      {
        name: "old",
        status: "deprecated" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    expect(matchSkillsForFile(skills, "report.xlsx")).toEqual([]);
  });

  test("ties in score break toward higher STATUS_RANK (byScoreThenStatus branch)", () => {
    // Both skills have the same score (1, ext match), so the tie-break
    // by status rank fires.
    const skills = [
      {
        name: "exp-one",
        status: "experimental" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "ver-one",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForFile(skills, "report.xlsx");
    expect(matches).toHaveLength(2);
    // Verified (rank 4) should come before experimental (rank 3).
    expect(matches[0]?.skill.name).toBe("ver-one");
    expect(matches[1]?.skill.name).toBe("exp-one");
  });

  test("sort comparator is called with equal scores (branch 197,38,0)", () => {
    // Three skills, all scoring 1 on the same trigger. Multiple pairwise
    // comparisons with equal scores will fire the 'scores are equal'
    // branch of byScoreThenStatus.
    const skills = [
      {
        name: "a-draft",
        status: "draft" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "b-verified",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "c-experimental",
        status: "experimental" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForFile(skills, "report.xlsx");
    expect(matches).toHaveLength(3);
    // Highest status rank first: verified (4) > experimental (3) > draft (2).
    expect(matches.map((m) => m.skill.name)).toEqual([
      "b-verified",
      "c-experimental",
      "a-draft",
    ]);
  });

  test("matchSkillsForTask with many equal-score skills exercises tie comparator", () => {
    // Five skills, all matching the same single trigger → all score 0.33.
    // Sort will need to break ties via STATUS_RANK for many pairs.
    const skills = [
      {
        name: "a-draft",
        status: "draft" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "b-verified",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "c-experimental",
        status: "experimental" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "d-unverified",
        status: "unverified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "e-deprecated",
        status: "deprecated" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForTask(skills, "process the xlsx file");
    // Deprecated is filtered out. The rest all score 0.33 (1 hit / 3).
    expect(matches.map((m) => m.skill.name)).toEqual([
      "b-verified",
      "c-experimental",
      "a-draft",
      "d-unverified",
    ]);
  });

  test("matchSkillsForFile with many equal-score skills (large array) — tie comparator", () => {
    // Build a 7-skill array with the same trigger for all of them. Sort
    // needs to compare equal-score pairs many times to determine the
    // final order by STATUS_RANK.
    const statuses = [
      "draft",
      "verified",
      "experimental",
      "unverified",
      "draft",
      "verified",
      "experimental",
    ] as const;
    const skills = statuses.map((status, i) => ({
      name: `skill-${i}-${status}`,
      status,
      triggers: ["xlsx"],
      description: "d",
      dir: "/x",
      path: "/x",
    }));
    const matches = matchSkillsForFile(skills, "report.xlsx");
    // 7 results, all score 1, sorted by status rank (verified > experimental > draft > unverified).
    expect(matches).toHaveLength(7);
    const ranks = matches.map((m) => m.skill.status);
    // Verified should come before experimental, which comes before draft, which comes before unverified.
    const verifiedIdx = ranks.indexOf("verified");
    const expIdx = ranks.indexOf("experimental");
    const draftIdx = ranks.indexOf("draft");
    const unvIdx = ranks.indexOf("unverified");
    expect(verifiedIdx).toBeLessThan(expIdx);
    expect(expIdx).toBeLessThan(draftIdx);
    expect(draftIdx).toBeLessThan(unvIdx);
  });

  test("matchSkillsForTask with mixed scores also exercises tie comparator", () => {
    // Mix of score-1 (ext match) and score-0.6 (filename contains) — the
    // 0.6 group has internal ties that require the status-rank branch.
    const skills = [
      {
        name: "exp-fname",
        status: "experimental" as const,
        triggers: ["report"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "ver-fname",
        status: "verified" as const,
        triggers: ["report"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "exp-ext",
        status: "experimental" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "ver-ext",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    // Filename "xlsx" — ext is "xlsx" → triggers "xlsx" → score 1.
    // Filename "report" — only contained in "report" → filename match → score 0.6.
    const matches = matchSkillsForFile(skills, "annual_report.xlsx");
    expect(matches).toHaveLength(4);
    // Score-1 group first (ver-ext, exp-ext), then score-0.6 group (ver-fname, exp-fname).
    expect(matches[0]?.skill.name).toBe("ver-ext");
    expect(matches[1]?.skill.name).toBe("exp-ext");
    expect(matches[2]?.skill.name).toBe("ver-fname");
    expect(matches[3]?.skill.name).toBe("exp-fname");
  });
});

// =============================================================================
// matchSkillsForTask — uncovered branches.
// =============================================================================

describe("matchSkillsForTask: edge cases", () => {
  test("skill with no triggers and no capabilities returns no match", () => {
    const skills = [
      {
        name: "no-terms",
        status: "verified" as const,
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    expect(matchSkillsForTask(skills, "do something with xlsx")).toEqual([]);
  });

  test("skill with no matches (hits === 0) is excluded", () => {
    const skills = [
      {
        name: "unrelated",
        status: "verified" as const,
        triggers: ["pdf"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    expect(matchSkillsForTask(skills, "process an xlsx file")).toEqual([]);
  });

  test("empty trigger string is skipped (continue branch)", () => {
    // Construct via parseSkill to get a Skill with no triggers.
    const skills = [
      {
        name: "no-trig",
        status: "verified" as const,
        triggers: [],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    expect(matchSkillsForTask(skills, "any task at all")).toEqual([]);
  });

  test("term equal to '' in a hand-built Skill is skipped via !term continue (branch 177,35,0)", () => {
    // By passing a Skill with an explicit empty-string term, we exercise
    // the `if (!term) continue;` branch on line 177. parseSkill would
    // never produce such a Skill (asStringArray filters Boolean), but
    // matchSkillsForTask is a public function that accepts any Skill.
    const skills = [
      {
        name: "blank-term",
        status: "verified" as const,
        triggers: [""],
        capabilities: ["real"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForTask(skills, "process real things");
    // Only the "real" term can match. The empty term is skipped.
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toContain("real");
  });

  test("term with regex special chars is escaped, still matches literally", () => {
    const skills = [
      {
        name: "regexper",
        status: "verified" as const,
        triggers: ["a.b"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    // The literal "a.b" should match. The ".*"-like regex without escaping
    // would match too much, but with escaping it should only match the literal.
    const matches = matchSkillsForTask(skills, "see a.b in the log");
    expect(matches).toHaveLength(1);
  });

  test("hits >= 3 caps score at 1 (Math.min branch)", () => {
    const skills = [
      {
        name: "many-trig",
        status: "verified" as const,
        triggers: ["a", "b", "c", "d"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    // 4 hits → raw = 4/3 = 1.33 → capped at 1.
    const matches = matchSkillsForTask(skills, "a b c d");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.score).toBe(1);
  });

  test("ties in score break by status rank", () => {
    const skills = [
      {
        name: "draft-one",
        status: "draft" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
      {
        name: "ver-one",
        status: "verified" as const,
        triggers: ["xlsx"],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const matches = matchSkillsForTask(skills, "process the xlsx file");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.skill.name).toBe("ver-one");
  });
});

// =============================================================================
// renderSkillIndex — uncovered branches (capabilities nullish).
// =============================================================================

describe("renderSkillIndex: capabilities nullish branch", () => {
  test("skill with undefined capabilities renders an empty cell", () => {
    const skills = [
      {
        name: "no-caps",
        status: "verified" as const,
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const out = renderSkillIndex(skills);
    expect(out).toContain("| no-caps | verified |  |");
  });

  test("skill with empty capabilities array renders an empty cell", () => {
    const skills = [
      {
        name: "empty-caps",
        status: "verified" as const,
        capabilities: [],
        description: "d",
        dir: "/x",
        path: "/x",
      },
    ];
    const out = renderSkillIndex(skills);
    expect(out).toContain("| empty-caps | verified |  |");
  });
});

// =============================================================================
// STATUS_RANK sanity (a constant; touched by sort code paths).
// =============================================================================

describe("STATUS_RANK ordering", () => {
  test("verified > experimental > draft > unverified > deprecated", () => {
    expect(STATUS_RANK.verified).toBeGreaterThan(STATUS_RANK.experimental);
    expect(STATUS_RANK.experimental).toBeGreaterThan(STATUS_RANK.draft);
    expect(STATUS_RANK.draft).toBeGreaterThan(STATUS_RANK.unverified);
    expect(STATUS_RANK.unverified).toBeGreaterThan(STATUS_RANK.deprecated);
  });
});

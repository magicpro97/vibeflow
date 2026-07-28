import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseSkill } from "../src/skills/registry.js";
import {
  type ReviewProof,
  readReviewProof,
  reviewProofPath,
  trustedIdentityForSharedSkill,
  verifyReviewProof,
  writeReviewProofStub,
} from "../src/skills/review-proof.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-rp661-"));
  dirs.push(d);
  return d;
}

function validProof(): ReviewProof {
  return {
    schemaVersion: 1,
    registryId: "my-reg",
    commit: "a".repeat(40),
    skillPath: "skills/my-skill",
    bundleHash: `sha256:${"b".repeat(64)}`,
    reviewedAt: "2025-06-01T12:00:00.000Z",
    reviewer: "alice",
  };
}

const validExpected = {
  registryId: "my-reg",
  commit: "a".repeat(40),
  skillPath: "skills/my-skill",
  bundleHash: `sha256:${"b".repeat(64)}`,
};

function writeValidProof(home: string, skillName: string): void {
  const p = reviewProofPath(home, "my-reg", "a".repeat(40), skillName);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(validProof()));
}

// ── readReviewProof ──

describe("readReviewProof", () => {
  test("returns null when file missing", () => {
    const r = readReviewProof("/nonexistent/path.json");
    expect(r).toBeNull();
  });

  test("returns null on invalid JSON", () => {
    const home = tmpHome();
    const p = join(home, "bad.json");
    writeFileSync(p, "not json");
    const r = readReviewProof(p);
    expect(r).toBeNull();
  });

  test("returns null on non-object", () => {
    const home = tmpHome();
    const p = join(home, "arr.json");
    writeFileSync(p, JSON.stringify([1, 2, 3]));
    const r = readReviewProof(p);
    expect(r).toBeNull();
  });

  test("returns null on wrong schemaVersion", () => {
    const home = tmpHome();
    const p = join(home, "bad-schema.json");
    writeFileSync(p, JSON.stringify({ schemaVersion: 99 }));
    const r = readReviewProof(p);
    expect(r).toBeNull();
  });

  test("returns proof on valid file", () => {
    const home = tmpHome();
    const proof = validProof();
    const p = join(home, "good.json");
    writeFileSync(p, JSON.stringify(proof));
    const r = readReviewProof(p);
    expect(r).not.toBeNull();
    expect(r?.registryId).toBe("my-reg");
  });
});

// ── verifyReviewProof ──

describe("verifyReviewProof", () => {
  test("passes on valid proof", () => {
    expect(verifyReviewProof(validProof(), validExpected)).toBe(true);
  });

  test("fails on schemaVersion !== 1", () => {
    const p = { ...validProof(), schemaVersion: 2 as never };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on empty registryId", () => {
    const p = { ...validProof(), registryId: "" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on registryId mismatch", () => {
    const p = { ...validProof(), registryId: "wrong-reg" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on non-40-hex commit", () => {
    const p = { ...validProof(), commit: "zzz" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on commit mismatch", () => {
    const p = { ...validProof(), commit: "c".repeat(40) };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on empty skillPath", () => {
    const p = { ...validProof(), skillPath: "" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on skillPath with ..", () => {
    const p = { ...validProof(), skillPath: "skills/../../etc" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on skillPath with backslash", () => {
    const p = { ...validProof(), skillPath: "skills\\bad" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on skillPath with NUL", () => {
    const p = { ...validProof(), skillPath: "skills/\0bad" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on skillPath mismatch", () => {
    const p = { ...validProof(), skillPath: "skills/other" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on bundleHash not starting with sha256:", () => {
    const p = { ...validProof(), bundleHash: "md5:abc" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on bundleHash non-64-hex body", () => {
    const p = { ...validProof(), bundleHash: "sha256:xyz" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on bundleHash mismatch", () => {
    const p = { ...validProof(), bundleHash: `sha256:${"c".repeat(64)}` };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on reviewer not a string", () => {
    const p = { ...validProof(), reviewer: 42 as never };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  test("fails on reviewedAt unparseable", () => {
    const p = { ...validProof(), reviewedAt: "not-a-date" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });

  // #661: UNREVIEWED stub must not pass verification
  test("fails on reviewer UNREVIEWED", () => {
    const p = { ...validProof(), reviewer: "UNREVIEWED" };
    expect(verifyReviewProof(p, validExpected)).toBe(false);
  });
});

// ── writeReviewProofStub ──

describe("writeReviewProofStub", () => {
  test("writes exact JSON at correct path, atomic", () => {
    const home = tmpHome();
    writeReviewProofStub({
      homedir: home,
      registryId: "my-reg",
      commit: "a".repeat(40),
      skillName: "my-skill",
      skillPath: "skills/my-skill",
      bundleHash: `sha256:${"b".repeat(64)}`,
    });
    const expectedPath = reviewProofPath(home, "my-reg", "a".repeat(40), "my-skill");
    expect(existsSync(expectedPath)).toBe(true);
    const raw = readFileSync(expectedPath, "utf8");
    const parsed = JSON.parse(raw) as ReviewProof;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.registryId).toBe("my-reg");
    expect(parsed.commit).toBe("a".repeat(40));
    expect(parsed.skillPath).toBe("skills/my-skill");
    expect(parsed.bundleHash).toBe(`sha256:${"b".repeat(64)}`);
    expect(parsed.reviewer).toBe("UNREVIEWED");
    expect(typeof parsed.reviewedAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.reviewedAt))).toBe(false);
    // sorted keys + trailing newline
    expect(raw.endsWith("\n")).toBe(true);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  test("no tmp file left behind after success", async () => {
    const home = tmpHome();
    writeReviewProofStub({
      homedir: home,
      registryId: "r",
      commit: "c".repeat(40),
      skillName: "s",
      skillPath: "skills/s",
      bundleHash: `sha256:${"d".repeat(64)}`,
    });
    const proofDir = join(home, ".vibeflow", "skill-review-proofs", "r", "c".repeat(40));
    const { readdirSync: listDir } = await import("node:fs");
    const files = listDir(proofDir).filter((f) => f.endsWith(".tmp-"));
    expect(files).toHaveLength(0);
  });
});

// ── parseSkill with trustedReviewIdentity ──

describe("parseSkill with trustedReviewIdentity", () => {
  function writeSkillMd(dir: string, fm: Record<string, unknown>): string {
    const lines = [
      "---",
      ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`),
      "---",
      "",
      "# test",
      "",
      "Enough body content to pass validation threshold.",
    ];
    const p = join(dir, "SKILL.md");
    writeFileSync(p, lines.join("\n"));
    return p;
  }

  test("keeps verified when proof exists and identity matches", () => {
    const home = tmpHome();
    writeValidProof(home, "test-skill");
    const md = writeSkillMd(home, {
      name: "test-skill",
      description: "a skill",
      status: "verified",
    });
    const r = parseSkill(md, home, {
      provenance: "discovered",
      trustedReviewIdentity: validExpected,
      homedir: () => home,
    });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("verified");
  });

  test("coerces to experimental when proof file missing", () => {
    const home = tmpHome();
    const md = writeSkillMd(home, {
      name: "test-skill",
      description: "a skill",
      status: "verified",
    });
    const r = parseSkill(md, home, {
      provenance: "discovered",
      trustedReviewIdentity: validExpected,
      homedir: () => home,
    });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("experimental");
  });

  test("coerces to experimental when no trustedReviewIdentity passed (backward compat)", () => {
    const home = tmpHome();
    const md = writeSkillMd(home, {
      name: "test-skill",
      description: "a skill",
      status: "verified",
    });
    const r = parseSkill(md, home, { provenance: "discovered" });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("experimental");
  });

  test("coerces to experimental when no homedir provided", () => {
    const home = tmpHome();
    writeValidProof(home, "test-skill");
    const md = writeSkillMd(home, {
      name: "test-skill",
      description: "a skill",
      status: "verified",
    });
    const r = parseSkill(md, home, {
      provenance: "discovered",
      trustedReviewIdentity: validExpected,
    });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("experimental");
  });

  // #661 security: attacker-controlled frontmatter values must NEVER be used as proof identity
  test("malicious frontmatter matching all identity fields cannot promote without trustedReviewIdentity", () => {
    const home = tmpHome();
    // SKILL.md declares status:verified AND all the identity fields with
    // values that look valid — but no trustedReviewIdentity is passed.
    const md = writeSkillMd(home, {
      name: "bad-skill",
      description: "trying to bypass",
      status: "verified",
      commit: "a".repeat(40),
      registryId: "my-reg",
      skillPath: "skills/my-skill",
      bundleHash: `sha256:${"b".repeat(64)}`,
    });
    const r = parseSkill(md, home, { provenance: "discovered" });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("experimental");
  });

  test("malicious frontmatter cannot promote even when trustedReviewIdentity is for a different skill", () => {
    const home = tmpHome();
    // Attacker's SKILL.md claims status:verified and has matching-looking
    // identity fields. A valid proof exists but for a DIFFERENT skill name.
    // Because trustedReviewIdentity is derived from the marketplace lock
    // (not frontmatter), the identity includes skill name "real-skill" but
    // the attacker's skill is "bad-skill".
    writeValidProof(home, "real-skill");
    const md = writeSkillMd(home, {
      name: "bad-skill",
      description: "trying to bypass",
      status: "verified",
      commit: "a".repeat(40),
      registryId: "my-reg",
      skillPath: "skills/my-skill",
      bundleHash: `sha256:${"b".repeat(64)}`,
    });
    const r = parseSkill(md, home, {
      provenance: "discovered",
      trustedReviewIdentity: validExpected,
      homedir: () => home,
    });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("experimental");
  });
});

// ── registryInstall with --record-review (integration via I/O injection) ──

describe("registryInstall integration (--record-review)", () => {
  function validBody(): string {
    return "Enough body content to pass validation threshold.\n".repeat(5);
  }

  function writeSkillMd(dir: string, name: string, version: string): void {
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        `version: ${version}`,
        "description: Test skill for registry install.",
        "---",
        "",
        `# ${name}`,
        "",
        validBody(),
      ].join("\n"),
    );
  }

  test("writes proof at expected path when --record-review --yes", async () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-rp-install-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "my-reg",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const realCacheDir = join(home, ".vibeflow", "skill-registries", expectedHash);
    mkdirSync(join(realCacheDir, "skills", "my-skill"), { recursive: true });
    writeFileSync(
      join(realCacheDir, "marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          { name: "my-skill", version: "1.0.0", status: "verified", path: "skills/my-skill" },
        ],
      }),
    );
    writeSkillMd(join(realCacheDir, "skills", "my-skill"), "my-skill", "1.0.0");

    const { registryInstall } = await import("../src/skills/registry-install.js");

    const exitCode = registryInstall(repo, "my-reg", "my-skill", {
      yes: true,
      recordReview: true,
      homedir: () => home,
    });
    expect(exitCode).toBe(0);

    const proofPath = reviewProofPath(home, "my-reg", "a".repeat(40), "my-skill");
    expect(existsSync(proofPath)).toBe(true);
    const proof = readReviewProof(proofPath);
    expect(proof).not.toBeNull();
    expect(proof?.registryId).toBe("my-reg");
    expect(proof?.commit).toBe("a".repeat(40));
    expect(proof?.skillPath).toBe("skills/my-skill");
    expect(proof?.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proof?.reviewer).toBe("UNREVIEWED");
  });

  test("does NOT write proof without --record-review", async () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-rp-noflag-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "my-reg",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const realCacheDir = join(home, ".vibeflow", "skill-registries", expectedHash);
    mkdirSync(join(realCacheDir, "skills", "my-skill2"), { recursive: true });
    writeFileSync(
      join(realCacheDir, "marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          { name: "my-skill2", version: "1.0.0", status: "verified", path: "skills/my-skill2" },
        ],
      }),
    );
    writeSkillMd(join(realCacheDir, "skills", "my-skill2"), "my-skill2", "1.0.0");

    const { registryInstall } = await import("../src/skills/registry-install.js");

    const exitCode = registryInstall(repo, "my-reg", "my-skill2", {
      yes: true,
      recordReview: false,
      homedir: () => home,
    });
    expect(exitCode).toBe(0);

    const proofPath = reviewProofPath(home, "my-reg", "a".repeat(40), "my-skill2");
    expect(existsSync(proofPath)).toBe(false);
  });
});

// ── reviewProofPath ──

describe("reviewProofPath", () => {
  test("returns correct path", () => {
    const p = reviewProofPath("/home/user", "reg-id", "c".repeat(40), "skill-name");
    expect(p).toBe(
      "/home/user/.vibeflow/skill-review-proofs/reg-id/cccccccccccccccccccccccccccccccccccccccc/skill-name.json",
    );
  });
});

// ── trustedIdentityForSharedSkill ──

describe("trustedIdentityForSharedSkill", () => {
  test("returns identity when lock entry matches", () => {
    const dir = tmpHome();
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: test-skill\ndescription: a skill\n---\n\nbody\n",
    );
    const { createHash } = require("node:crypto");
    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(dir);
    const registries = [
      {
        name: "my-reg",
        url: "https://example.com/r.git",
        ref: "main",
        commitOID: "a".repeat(40),
        installed: [
          {
            name: "test-skill",
            version: "1.0.0",
            commitOID: "a".repeat(40),
            bundleHash: hash,
            skillPath: "skills/test-skill",
          },
        ],
      },
    ];
    const id = trustedIdentityForSharedSkill("test-skill", registries, dir);
    expect(id).not.toBeUndefined();
    expect(id?.registryId).toBe("my-reg");
    expect(id?.commit).toBe("a".repeat(40));
    expect(id?.skillPath).toBe("skills/test-skill");
    expect(id?.bundleHash).toBe(`sha256:${hash}`);
  });

  test("returns undefined when no installed entry", () => {
    const dir = tmpHome();
    writeFileSync(join(dir, "SKILL.md"), "---\nname: other\ndescription: a skill\n---\n\nbody\n");
    const id = trustedIdentityForSharedSkill("other", [], dir);
    expect(id).toBeUndefined();
  });

  test("returns undefined when bundleHash mismatch", () => {
    const dir = tmpHome();
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: test-skill\ndescription: a skill\n---\n\nbody\n",
    );
    const registries = [
      {
        name: "my-reg",
        url: "https://example.com/r.git",
        ref: "main",
        commitOID: "a".repeat(40),
        installed: [
          {
            name: "test-skill",
            version: "1.0.0",
            commitOID: "a".repeat(40),
            bundleHash: "badhash",
            skillPath: "skills/test-skill",
          },
        ],
      },
    ];
    const id = trustedIdentityForSharedSkill("test-skill", registries, dir);
    expect(id).toBeUndefined();
  });

  test("returns undefined when skillPath missing", () => {
    const dir = tmpHome();
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: test-skill\ndescription: a skill\n---\n\nbody\n",
    );
    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(dir);
    const registries = [
      {
        name: "my-reg",
        url: "https://example.com/r.git",
        ref: "main",
        commitOID: "a".repeat(40),
        installed: [
          { name: "test-skill", version: "1.0.0", commitOID: "a".repeat(40), bundleHash: hash },
        ],
      },
    ];
    const id = trustedIdentityForSharedSkill("test-skill", registries, dir);
    expect(id).toBeUndefined();
  });
});

// ── discoverSkills with shared catalog + trusted identity ──

describe("discoverSkills with shared catalog", () => {
  function writeSkillMd(dir: string, name: string, extraFm = ""): string {
    const lines = [
      "---",
      `name: ${name}`,
      "description: a test skill from catalog",
      extraFm,
      "---",
      "",
      `# ${name}`,
      "",
      "Body content here.",
    ].filter(Boolean);
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
    return join(dir, "SKILL.md");
  }

  test("verified when lock + hash + proof all match", () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-disc-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    // shared catalog: create skill dir
    const catalog = join(home, ".vibeflow", "skills");
    mkdirSync(join(catalog, "my-skill"), { recursive: true });
    writeSkillMd(join(catalog, "my-skill"), "my-skill", "status: verified");

    // compute bundle hash for the real dir
    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(join(catalog, "my-skill"));

    // lock file
    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg-one",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [
            {
              name: "my-skill",
              version: "1.0.0",
              commitOID: "a".repeat(40),
              bundleHash: hash,
              skillPath: "skills/my-skill",
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    // review proof at expected path
    writeReviewProofStub({
      homedir: home,
      registryId: "reg-one",
      commit: "a".repeat(40),
      skillName: "my-skill",
      skillPath: "skills/my-skill",
      bundleHash: `sha256:${hash}`,
    });
    // edit stub to valid reviewer (stub writes UNREVIEWED)
    const proofPath = reviewProofPath(home, "reg-one", "a".repeat(40), "my-skill");
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    proof.reviewer = "alice";
    writeFileSync(proofPath, JSON.stringify(proof));

    const skills = discoverSkills(repo, { sharedCatalogDir: () => catalog, homedir: () => home });
    const skill = skills.find((s) => s.name === "my-skill");
    expect(skill).not.toBeUndefined();
    expect(skill?.status).toBe("verified");
  });

  test("experimental when proof file missing despite lock match", () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-disc-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const catalog = join(home, ".vibeflow", "skills");
    mkdirSync(join(catalog, "my-skill"), { recursive: true });
    writeSkillMd(join(catalog, "my-skill"), "my-skill", "status: verified");

    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(join(catalog, "my-skill"));

    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg-one",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [
            {
              name: "my-skill",
              version: "1.0.0",
              commitOID: "a".repeat(40),
              bundleHash: hash,
              skillPath: "skills/my-skill",
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    // no review proof written

    const skills = discoverSkills(repo, { sharedCatalogDir: () => catalog, homedir: () => home });
    const skill = skills.find((s) => s.name === "my-skill");
    expect(skill).not.toBeUndefined();
    expect(skill?.status).toBe("experimental");
  });

  test("experimental when catalog byte changed after lock hash", () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-disc-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const catalog = join(home, ".vibeflow", "skills");
    mkdirSync(join(catalog, "my-skill"), { recursive: true });
    writeSkillMd(join(catalog, "my-skill"), "my-skill", "status: verified");

    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(join(catalog, "my-skill"));

    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg-one",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [
            {
              name: "my-skill",
              version: "1.0.0",
              commitOID: "a".repeat(40),
              bundleHash: hash,
              skillPath: "skills/my-skill",
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    // tamper catalog content after lock record
    writeFileSync(
      join(catalog, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: tampered\nstatus: verified\n---\n\nmalicious\n",
    );

    const skills = discoverSkills(repo, { sharedCatalogDir: () => catalog, homedir: () => home });
    const skill = skills.find((s) => s.name === "my-skill");
    expect(skill).not.toBeUndefined();
    expect(skill?.status).toBe("experimental");
  });

  test("malicious frontmatter identity fields ignored — no lock entry match", () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-disc-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const catalog = join(home, ".vibeflow", "skills");
    mkdirSync(join(catalog, "bad-skill"), { recursive: true });
    // SKILL.md declares status:verified AND all identity-like fields
    writeSkillMd(join(catalog, "bad-skill"), "bad-skill", "status: verified");

    // lock has no installed entry for bad-skill
    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg-one",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [],
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    const skills = discoverSkills(repo, { sharedCatalogDir: () => catalog, homedir: () => home });
    const skill = skills.find((s) => s.name === "bad-skill");
    expect(skill).not.toBeUndefined();
    // Without lock entry, no trusted identity derived → experimental
    expect(skill?.status).toBe("experimental");
  });

  test("malicious frontmatter identity fields ignored — no proof file", () => {
    const home = tmpHome();
    const repo = mkdtempSync(join(tmpdir(), "vf-disc-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });

    const catalog = join(home, ".vibeflow", "skills");
    mkdirSync(join(catalog, "bad-skill"), { recursive: true });
    writeSkillMd(join(catalog, "bad-skill"), "bad-skill", "status: verified");

    const { skillBundleHash } = require("../src/skills/registry-install.js");
    const hash = skillBundleHash(join(catalog, "bad-skill"));

    // lock matches name — but no review proof
    const lock = {
      schemaVersion: 1,
      registries: [
        {
          name: "reg-one",
          url: "https://example.com/r.git",
          ref: "v1",
          commitOID: "a".repeat(40),
          installed: [
            {
              name: "bad-skill",
              version: "1.0.0",
              commitOID: "a".repeat(40),
              bundleHash: hash,
              skillPath: "skills/bad-skill",
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify(lock, null, 2),
    );

    // no review proof

    const skills = discoverSkills(repo, { sharedCatalogDir: () => catalog, homedir: () => home });
    const skill = skills.find((s) => s.name === "bad-skill");
    expect(skill).not.toBeUndefined();
    expect(skill?.status).toBe("experimental");
  });
});

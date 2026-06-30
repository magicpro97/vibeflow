// src/skills/verify.ts
//
// Promote/demote a local skill's `status:` frontmatter field (#424).
// The canonical store (.vibeflow/skills/<name>/SKILL.md) is the only writable,
// local-provenance root, so promotion to `verified` is allowed there.
//
// We do NOT round-trip YAML: parseFrontmatter is parse-only and adding a YAML
// emitter for one scalar field is overkill. Instead we do a targeted edit on
// the `---`-fenced block — replace an existing `status:` line or splice a new
// one in just before the closing fence. Body bytes are untouched.
//
// ponytail: targeted line edit over a YAML round-trip lib; upgrade to a real
// emitter only if we ever need to rewrite nested frontmatter structures.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, c, writeFileSafe } from "../core.js";
import { out } from "../logbus.js";

export type VerifyStatus = "verified" | "unverified";

export interface SetStatusResult {
  ok: boolean;
  /** Why it failed (only set when ok === false). */
  reason?: string;
  /** The frontmatter text after the edit (only set when ok === true). */
  text?: string;
  /** false when the file already had the requested status (idempotent no-op). */
  changed?: boolean;
}

const STATUS_LINE = /^status:.*$/m;

/**
 * Return `text` with its frontmatter `status:` set to `status`. Pure function —
 * no I/O. Refuses (ok:false) when `text` has no `---`-fenced frontmatter, since
 * a valid skill always carries name+description frontmatter and a file without
 * it is malformed.
 */
export function setStatusInText(text: string, status: VerifyStatus): SetStatusResult {
  const norm = text.replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "no frontmatter (file is missing the leading '---' fence)" };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { ok: false, reason: "unterminated frontmatter (missing the closing '---' fence)" };
  }

  const block = lines.slice(1, endIdx);
  const blockText = block.join("\n");
  const desired = `status: ${status}`;

  if (STATUS_LINE.test(blockText)) {
    const replaced = blockText.replace(STATUS_LINE, desired);
    if (replaced === blockText) {
      // Already the desired value — return the ORIGINAL text (not the
      // CRLF-normalized `norm`) so changed:false ⟺ zero byte change, per the
      // contract callers rely on (#433 review).
      return { ok: true, changed: false, text };
    }
    const out = ["---", replaced, "---", ...lines.slice(endIdx + 1)].join("\n");
    return { ok: true, changed: true, text: out };
  }

  // No status line — splice one as the last frontmatter line.
  const out = ["---", ...block, desired, "---", ...lines.slice(endIdx + 1)].join("\n");
  return { ok: true, changed: true, text: out };
}

export interface SetSkillStatusDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  writeFileSafe: (p: string, content: string) => void;
}

/**
 * Set the `status:` of the skill whose SKILL.md is at `skillMd`. Reads, edits,
 * and writes via the injected I/O seam (so tests never touch the real FS).
 */
export function setSkillStatus(
  skillMd: string,
  status: VerifyStatus,
  deps: SetSkillStatusDeps,
): SetStatusResult {
  if (!deps.existsSync(skillMd)) {
    return { ok: false, reason: `not found: ${skillMd}` };
  }
  const result = setStatusInText(deps.readFileSync(skillMd, "utf8"), status);
  if (!result.ok) return result;
  if (result.changed && result.text !== undefined) {
    deps.writeFileSafe(skillMd, result.text);
  }
  return result;
}

/**
 * `vf skills verify <name> [--undo]` command arm. Extracted from skills.ts so
 * that file stays under the 400-line cap (#80). Returns the process exit code.
 */
export function verifySkillCommand(repo: string, rest: string[]): number {
  const name = rest[0]?.trim();
  const undo = rest.includes("--undo");
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    out("vf", c.red("Usage: vf skills verify <name> [--undo]  (lowercase-hyphen name)"), {
      level: "error",
    });
    return 2;
  }
  // Only the canonical local store is writable + local-provenance, so only it
  // is eligible for promotion. Mirror roots (.kiro/, .claude/) are read-only.
  const skillMd = join(repo, CTX_DIR, "skills", name, "SKILL.md");
  if (!existsSync(skillMd)) {
    out("vf", c.red(`Skill "${name}" not found at ${skillMd}.`), { level: "error" });
    return 1;
  }
  const target: VerifyStatus = undo ? "unverified" : "verified";
  const result = setSkillStatus(skillMd, target, { existsSync, readFileSync, writeFileSafe });
  if (!result.ok) {
    out("vf", c.red(`Cannot ${undo ? "unverify" : "verify"} "${name}": ${result.reason}`), {
      level: "error",
    });
    return 1;
  }
  if (!result.changed) {
    out("vf", c.dim(`Skill ${c.bold(name)} is already ${target} — no change.`));
    return 0;
  }
  out("vf", undo ? c.yellow(`○ ${name} → unverified`) : c.green(`✔ ${name} → verified`));
  out("vf", c.dim(`  ${skillMd}`));
  return 0;
}

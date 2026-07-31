import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";

export interface CandidatePair {
  skills: [string, string];
  reason: "trigger-overlap" | "duplicate-fact";
  similarity: number;
}

export interface CheapReviewer {
  id: string;
  review(candidate: CandidatePair): CheapReviewResult;
}

export interface CheapReviewResult {
  candidate: CandidatePair;
  verdict: "related" | "unrelated" | "error";
  error?: string;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-zA-Z0-9_-]+/)
    .filter(Boolean);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function filterCandidates(
  repo: string,
  inject?: {
    discoverSkills?: typeof discoverSkills;
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
  },
): CandidatePair[] {
  const rf = inject?.readFileSync ?? readFileSync;
  const ef = inject?.existsSync ?? existsSync;
  const ds = inject?.discoverSkills ?? discoverSkills;

  const skills = ds(repo);
  if (skills.length < 2) return [];

  const skillTexts: { name: string; text: string }[] = [];
  for (const skill of skills) {
    if (!skill.dir) continue;
    try {
      const skillMd = join(skill.dir, "SKILL.md");
      if (ef(skillMd)) {
        skillTexts.push({ name: skill.name, text: rf(skillMd, "utf8") });
      }
    } catch {
      // skip unreadable
    }
  }

  const parsed = skillTexts.map(({ name, text }) => {
    const { data } = parseFrontmatter(text);
    const triggers = Array.isArray(data.triggers)
      ? data.triggers.filter((x: unknown) => typeof x === "string")
      : [];
    const owns = Array.isArray(data.owns)
      ? data.owns.filter((x: unknown) => typeof x === "string")
      : [];
    return { name, triggers, owns };
  });

  const candidates: CandidatePair[] = [];
  const seen = new Set<string>();

  // duplicate fact IDs
  const factOwners = new Map<string, string[]>();
  for (const s of parsed) {
    for (const fact of s.owns) {
      const prev = factOwners.get(fact) ?? [];
      factOwners.set(fact, [...prev, s.name]);
    }
  }
  for (const [, owners] of factOwners) {
    if (owners.length < 2) continue;
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const pair = [owners[i], owners[j]].sort() as [string, string];
        const key = `${pair.join(",")}|duplicate-fact`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ skills: pair, reason: "duplicate-fact", similarity: 0 });
        }
      }
    }
  }

  // trigger Jaccard > 0.7
  for (let i = 0; i < parsed.length; i++) {
    const a = parsed[i];
    if (!a) continue;
    for (let j = i + 1; j < parsed.length; j++) {
      const b = parsed[j];
      if (!b) continue;
      if (a.triggers.length === 0 || b.triggers.length === 0) continue;
      const sim = jaccardSimilarity(tokenize(a.triggers.join(" ")), tokenize(b.triggers.join(" ")));
      if (sim > 0.7) {
        const pair = [a.name, b.name].sort() as [string, string];
        const key = `${pair.join(",")}|trigger-overlap`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ skills: pair, reason: "trigger-overlap", similarity: sim });
        }
      }
    }
  }

  candidates.sort(
    (a, b) => a.skills[0].localeCompare(b.skills[0]) || a.skills[1].localeCompare(b.skills[1]),
  );
  return candidates;
}

const MAX_REVIEWS_MAX = 10000;

export function validateMaxReviews(v: string): number | string {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_REVIEWS_MAX) {
    return `--max-reviews must be integer 0-${MAX_REVIEWS_MAX}`;
  }
  return n;
}

const KNOWN_FLAGS = new Set(["--max-reviews", "--reviewer"]);

export function parseReviewerArgs(
  args: string[],
): { ok: true; maxReviews: number; reviewerId: string | undefined } | { ok: false; error: string } {
  let maxReviews = 0;
  let reviewerId: string | undefined;
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;

    if (!a.startsWith("--")) {
      return { ok: false, error: `Unknown positional argument: ${a}` };
    }

    if (!KNOWN_FLAGS.has(a)) {
      return { ok: false, error: `Unknown flag: ${a}` };
    }

    const key = a;
    const next = args[i + 1];

    if (key === "--max-reviews" || key === "--reviewer") {
      if (next === undefined) {
        return { ok: false, error: `${key} requires a value` };
      }
      if (next.startsWith("--")) {
        return { ok: false, error: `${key} value cannot be a flag: ${next}` };
      }
      if (key === "--reviewer" && next.trim() === "") {
        return { ok: false, error: "--reviewer value cannot be empty" };
      }
      if (seen.has(key)) {
        return { ok: false, error: `Duplicate flag: ${key}` };
      }
      seen.add(key);

      if (key === "--max-reviews") {
        const validated = validateMaxReviews(next);
        if (typeof validated === "string") {
          return { ok: false, error: validated };
        }
        maxReviews = validated;
      } else {
        reviewerId = next;
      }
      i++;
    }
  }

  return { ok: true, maxReviews, reviewerId };
}

export function reviewCandidates(
  candidates: CandidatePair[],
  reviewer: CheapReviewer | undefined,
  maxReviews: number,
): CheapReviewResult[] {
  if (!reviewer || maxReviews <= 0 || candidates.length === 0) return [];
  const capped = candidates.slice(0, Math.min(maxReviews, candidates.length));
  return capped.map((c) => {
    try {
      return reviewer.review(c);
    } catch (e) {
      return { candidate: c, verdict: "error", error: (e as Error).message };
    }
  });
}

export function buildSkillReviewPrompt(candidate: CandidatePair): string {
  return [
    "You are a skill-deduplication reviewer. Determine if the two skills below are semantically related.",
    "",
    `Skill A: ${candidate.skills[0]}`,
    `Skill B: ${candidate.skills[1]}`,
    `Reason identified: ${candidate.reason}`,
    candidate.reason === "trigger-overlap"
      ? `Jaccard similarity: ${candidate.similarity.toFixed(3)}`
      : "",
    "",
    "Respond with exactly one word: RELATED or UNRELATED.",
    "RELATED means the skills share significant domain knowledge such that keeping both is redundant.",
    "UNRELATED means they are coincidentally overlapping but address distinct concerns.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function makeCheapReviewerFromBridge(reviewerId: string): CheapReviewer | undefined {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return undefined;
  return {
    id: reviewerId,
    review(candidate: CandidatePair): CheapReviewResult {
      const prompt = buildSkillReviewPrompt(candidate);
      const shell = process.platform === "win32" ? ["cmd.exe", "/c", cmd] : ["/bin/sh", "-c", cmd];
      const r = Bun.spawnSync(shell as [string, ...string[]], {
        stdin: Buffer.from(prompt, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode !== 0) {
        return {
          candidate,
          verdict: "error",
          error: `bridge exited ${r.exitCode}: ${r.stderr.toString().slice(0, 200)}`,
        };
      }
      const raw = r.stdout.toString().trim();
      const verdict = /^RELATED$/i.test(raw) ? "related" : "unrelated";
      return { candidate, verdict };
    },
  };
}

export function handleSemanticFilterSubcommand(
  repo: string,
  rest: string[],
  inject?: {
    discoverSkills?: typeof discoverSkills;
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
    cheapReviewer?: CheapReviewer;
  },
): number {
  const parsed = parseReviewerArgs(rest);
  if (!parsed.ok) {
    out("vf", c.red(`✗ ${parsed.error}`));
    return 2;
  }
  const { maxReviews, reviewerId } = parsed;

  let candidates: CandidatePair[];
  try {
    candidates = filterCandidates(repo, inject);
  } catch (e) {
    out("vf", c.red(`✗ filter failed: ${(e as Error).message}`));
    return 1;
  }

  if (candidates.length === 0) {
    out("vf", c.green("✔ No candidate pairs qualify."));
    return 0;
  }

  out("vf", c.bold(`${candidates.length} candidate pair(s) qualified:`));
  for (const cnd of candidates) {
    const simStr =
      cnd.reason === "trigger-overlap" ? ` (Jaccard ${cnd.similarity.toFixed(3)})` : "";
    out("vf", `  ${cnd.skills[0]} ↔ ${cnd.skills[1]} — ${cnd.reason}${simStr}`);
  }

  if (!reviewerId) {
    out("vf", c.dim("No reviewer selected. Pass --reviewer to enable reviews."));
    return 0;
  }

  out("vf", c.dim(`Reviewer "${reviewerId}" selected, max-reviews=${maxReviews}`));

  const reviewer = inject?.cheapReviewer ?? makeCheapReviewerFromBridge(reviewerId);

  if (!reviewer) {
    out("vf", c.yellow("⚠ No cheap reviewer available — VIBEFLOW_AI bridge not configured."));
    out(
      "vf",
      c.dim(
        "Set VIBEFLOW_AI env var to a shell command (e.g. deepseek-v4-flash) to enable LLM review via bridge.",
      ),
    );
    out("vf", c.dim("Or pass inject.cheapReviewer programmatically."));
    return 0;
  }

  const results = reviewCandidates(candidates, reviewer, maxReviews);

  const related = results.filter((r) => r.verdict === "related");
  const unrelated = results.filter((r) => r.verdict === "unrelated");
  const errors = results.filter((r) => r.verdict === "error");

  out(
    "vf",
    c.bold(
      `Review complete: ${related.length} related, ${unrelated.length} unrelated, ${errors.length} error(s)`,
    ),
  );

  for (const r of results) {
    const pair = `${r.candidate.skills[0]} ↔ ${r.candidate.skills[1]}`;
    if (r.verdict === "error") {
      out("vf", c.red(`  ✗ ${pair} — error: ${r.error}`));
    } else {
      const sym = r.verdict === "related" ? "~" : " ";
      out("vf", `  ${sym} ${pair} — ${r.verdict}`);
    }
  }

  return 0;
}

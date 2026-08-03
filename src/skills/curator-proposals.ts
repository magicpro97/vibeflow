// #684: render read-only issue/PR proposals from curator findings.
// Reads .vibeflow/curator/findings.json. NEVER auto-creates anything:
// no gh, no git, no writes — pure stdout. Findings are validated at the
// trust boundary (untrusted file on disk); malformed input is rejected.
// Generic text only; no repo paths or identifying IDs are rendered.

import { c } from "../core.js";
import { out } from "../logbus.js";
import { type CuratorScanResult, type Finding, readCuratorFindings } from "./curator-scan.js";

export type ProposalKind = "issue" | "pr";

export type ParseOutcome = { ok: true; result: CuratorScanResult } | { ok: false; reason: string };

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function validateFinding(f: unknown): Finding | null {
  if (f === null || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  const type = o.type;
  if (type === "stale-anchor") {
    return isString(o.skill) && isString(o.detail)
      ? { id: "", type, skill: o.skill, detail: o.detail }
      : null;
  }
  if (type === "duplicate-owner") {
    const skills = o.skills;
    return Array.isArray(skills) &&
      skills.length >= 2 &&
      skills.every(isString) &&
      isString(o.detail)
      ? { id: "", type, skills: skills as string[], detail: o.detail }
      : null;
  }
  if (type === "unpinned-registry") {
    return isString(o.registry) && isString(o.skill) && isString(o.detail)
      ? { id: "", type, registry: o.registry, skill: o.skill, detail: o.detail }
      : null;
  }
  return null;
}

export function parseCuratorFindings(obj: unknown): ParseOutcome {
  if (obj === null || typeof obj !== "object") {
    return { ok: false, reason: "not an object" };
  }
  const o = obj as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: "schemaVersion must be 1" };
  if (Array.isArray(o.findings)) {
    const validated: Finding[] = [];
    for (const f of o.findings) {
      const v = validateFinding(f);
      if (v === null) return { ok: false, reason: "malformed finding" };
      validated.push(v);
    }
    return { ok: true, result: { schemaVersion: 1, findings: validated } };
  }
  return { ok: false, reason: "findings must be an array" };
}

/** @returns `"info"` when `s` could be mistaken for a code term, else
 *  `"plain"`. The output renders code terms in backticks, so this is the
 *  injection guard — it never trusts or sanitizes attacker input. */
export function classifyFindingText(s: string): "plain" | "info" {
  return s.length <= 512 && /^[A-Za-z0-9 .,_/@:#+()\[\]{};!?=%-]+$/.test(s) ? "plain" : "info";
}

export function sanitiseTerm(s: string, kind: "plain" | "info"): string {
  const clean = s
    .replace(/[\n\r]/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/[^\x20-\x7E]/g, "");
  return kind === "plain" ? clean : `${clean.slice(0, 64)}…`;
}

export function renderIssueTitle(findings: Finding[]): string {
  const count = findings.length;
  const types = Array.from(new Set(findings.map((f) => f.type)))
    .sort()
    .join(", ");
  return `Curator findings: ${count} issue(s) in ${types}`;
}

export function renderIssueBody(findings: Finding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    const type = f.type;
    switch (type) {
      case "stale-anchor": {
        const skill = sanitiseTerm(f.skill, classifyFindingText(f.skill));
        const detail = sanitiseTerm(f.detail, classifyFindingText(f.detail));
        lines.push(`- [ ] ${type}: skill \`${skill}\` has stale content anchors — ${detail}`);
        break;
      }
      case "duplicate-owner": {
        const skill = sanitiseTerm(f.skills.join(", "), classifyFindingText(f.skills.join(", ")));
        const detail = sanitiseTerm(f.detail, classifyFindingText(f.detail));
        lines.push(`- [ ] ${type}: multiple skills claim the same fact — ${detail} (\`${skill}\`)`);
        break;
      }
      case "unpinned-registry": {
        const registry = sanitiseTerm(f.registry, classifyFindingText(f.registry));
        const skill = sanitiseTerm(f.skill, classifyFindingText(f.skill));
        const detail = sanitiseTerm(f.detail, classifyFindingText(f.detail));
        lines.push(`- [ ] ${type}: ${detail} (registry \`${registry}\`, skill \`${skill}\`)`);
        break;
      }
    }
  }
  return lines.join("\n");
}

function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  for (let i = 1; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

/** Branch names must be valid git refs: alphanumerics and dashes only.
 *  Untrusted names (skill/registry) are slugged; the finding type is
 *  trusted (validated enum). */
function slugPart(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\u0020-\u007E]/g, " ")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function branchForFinding(f: Finding, ftype: ProposalKind, used: Set<string>): string {
  let base = `curator/${ftype}/${slugPart(f.type)}`;
  switch (f.type) {
    case "stale-anchor":
      base += `-${slugPart(f.skill)}`;
      break;
    case "duplicate-owner":
      base += `-${slugPart(f.skills[0] ?? "")}`;
      break;
    case "unpinned-registry":
      base += `-${slugPart(f.skill)}`;
      break;
  }
  base = base.replace(/-+$/g, "");
  const slotted = uniqueSlug(base.slice(0, 100), used);
  return slotted;
}

export function patchDescription(f: Finding): string {
  switch (f.type) {
    case "stale-anchor":
      return `Update the anchored content referenced by skill \`${f.skill}\`.`;
    case "duplicate-owner":
      return `Resolve the fact-ownership collision between \`${f.skills.join(", ")}\`.`;
    case "unpinned-registry":
      return `Pin skill \`${f.skill}\` in registry \`${f.registry}\` to a commit.`;
  }
}

export interface RenderProposalOpts {
  kind: ProposalKind | Array<"issue" | "pr">;
  findings: CuratorScanResult;
}

export function renderProposals(opts: RenderProposalOpts): void {
  const includeIssue =
    typeof opts.kind === "string" ? opts.kind === "issue" : opts.kind.includes("issue");
  const includePr = typeof opts.kind === "string" ? opts.kind === "pr" : opts.kind.includes("pr");

  if (!includeIssue && !includePr) return;

  if (opts.findings.findings.length === 0) {
    if (includeIssue) {
      out("vf", "DRAFT ISSUE PROPOSAL");
      out("vf", "Title: No curatorship issues to report");
      out("vf", "");
    }
    if (includePr) {
      out("vf", "DRAFT PR PROPOSALS");
      out("vf", "(none — no findings to propose patches for)");
    }
    return;
  }

  if (includeIssue) {
    out("vf", "DRAFT ISSUE PROPOSAL");
    out("vf", `Title: ${renderIssueTitle(opts.findings.findings)}`);
    out("vf", "Body:");
    out("vf", "```");
    const body = renderIssueBody(opts.findings.findings);
    out("vf", body);
    out("vf", "```");
    out("vf", "This is a Read-only proposal. Nothing is created — review and file manually.");
    out("vf", "");
  }

  if (includePr) {
    out("vf", "DRAFT PR PROPOSALS");
    const used = new Set<string>();
    for (const f of opts.findings.findings) {
      const branch = branchForFinding(f, "pr", used);
      const typeLine =
        f.type === "duplicate-owner"
          ? sanitiseTerm(f.skills.join(", "), classifyFindingText(f.skills.join(", ")))
          : "";
      out("vf", "");
      out("vf", c.bold(branch));
      out("vf", `  Type: ${f.type}${typeLine ? ` (${typeLine})` : ""}`);
      out("vf", `  Patch: ${patchDescription(f)}`);
      out(
        "vf",
        "  Draft only — no branch created, no files changed, no network. Apply the patch yourself, then `vf pr create`.",
      );
    }
    out("vf", "");
    out("vf", "This is a read-only proposal. Nothing is created — review and apply manually.");
  }
}

/** CLI entry for `vf skills curator issue|pr`. Always dry-run: it reads the
 *  findings file, validates it, and prints a proposal to stdout. It never
 *  creates an issue or PR, never runs gh/git, and never writes files. */
export function handleCuratorProposalSubcommand(
  repo: string,
  kind: ProposalKind,
  rest: string[],
  deps: { readFindings?: typeof readCuratorFindings } = {},
): number {
  let yes = false;
  for (const arg of rest) {
    if (arg === "--dry-run") continue;
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    out("vf", c.red(`Unknown flag: ${arg}`), { level: "error" });
    out("vf", c.dim(`Usage: vf skills curator ${kind} [--dry-run] [--yes]`), { level: "error" });
    return 2;
  }
  if (yes) {
    out(
      "vf",
      c.red("Creating issues/PRs is not supported: this command only renders proposals to stdout."),
      { level: "error" },
    );
    return 3;
  }
  const read = deps.readFindings ?? readCuratorFindings;
  const raw = read(repo);
  if (raw === null) {
    out("vf", c.red("No findings file — run `vf skills curator scan` first."), { level: "error" });
    return 1;
  }
  const parsed = parseCuratorFindings(raw);
  if (!parsed.ok) {
    out("vf", c.red(`Malformed findings file: ${parsed.reason}`), { level: "error" });
    return 1;
  }
  out("vf", c.dim("dry-run — nothing will be created"));
  renderProposals({ kind, findings: parsed.result });
  return 0;
}

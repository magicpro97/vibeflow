import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR } from "../core.js";

export interface AntiPattern {
  id: string;
  pattern: string;
  why: string;
  scopes: string[];
  detection: string;
  status: "active" | "resolved" | "superseded";
  guidance: string;
}

const ENTRY_RE = /^## \[([^\]]+)\] (.+)$/;
const FIELD_RE = /^(Pattern|Why|Scope files|Detection|Status|Guidance):\s*(.*)$/;
const VALID_STATUSES = new Set<AntiPattern["status"]>(["active", "resolved", "superseded"]);

function parseFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = FIELD_RE.exec(line.trim());
    if (match) fields[match[1] ?? ""] = match[2] ?? "";
  }
  return fields;
}

export function parseAntiPatterns(text: string): AntiPattern[] {
  const entries: AntiPattern[] = [];
  let id = "";
  const title = "";
  let fields: string[] = [];
  const flush = () => {
    const values = parseFields(fields);
    const status = values.Status;
    if (
      !id ||
      !values.Pattern ||
      !values.Why ||
      !values.Guidance ||
      !VALID_STATUSES.has(status as AntiPattern["status"])
    )
      return;
    entries.push({
      id,
      pattern: values.Pattern,
      why: values.Why,
      scopes: (values["Scope files"] ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      detection: values.Detection ?? "manual review",
      status: status as AntiPattern["status"],
      guidance: values.Guidance,
    });
  };
  for (const line of text.split(/\r?\n/u)) {
    const heading = ENTRY_RE.exec(line.trim());
    if (heading) {
      flush();
      id = heading[1] ?? "";
      fields = [];
    } else if (id && line.trim() && !line.trim().startsWith("#")) {
      fields.push(line);
    }
  }
  flush();
  return entries;
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\\\", "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

function scopeMatches(scopes: readonly string[], file: string): boolean {
  return (
    scopes.length === 0 ||
    scopes.some((scope) => globToRegExp(scope).test(file.replaceAll("\\", "/")))
  );
}

export function relevantAntiPatterns(
  patterns: readonly AntiPattern[],
  files: readonly string[],
): AntiPattern[] {
  return patterns.filter(
    (pattern) =>
      pattern.status === "active" &&
      (files.length === 0 || files.some((file) => scopeMatches(pattern.scopes, file))),
  );
}

export function renderAntiPatterns(patterns: readonly AntiPattern[]): string {
  const active = patterns.filter((pattern) => pattern.status === "active").slice(0, 5);
  if (!active.length) return "";
  return [
    "## Anti-pattern guardrails",
    "Apply only warnings relevant to declared scope; they prevent known regressions, not valid exceptions.",
    ...active.map(
      (pattern) =>
        `- ${pattern.id} (${pattern.scopes.join(", ") || "all files"}): ${pattern.guidance} Why: ${pattern.why}`,
    ),
    "",
  ].join("\n");
}

export function loadRelevantAntiPatterns(base: string, files: readonly string[]): string {
  const path = join(base, CTX_DIR, "knowledge", "anti-patterns.md");
  if (!existsSync(path)) return "";
  const body = readFileSync(path, "utf8");
  return renderAntiPatterns(relevantAntiPatterns(parseAntiPatterns(body), files));
}

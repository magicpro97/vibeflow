import { createHash } from "node:crypto";
import type {
  OpaqueArtifactId,
  OpaqueSessionRef,
  PublicText,
  PublicTraceProjection,
  TraceEvent,
} from "./types.js";

const dropped = new Set([
  "native_session_id",
  "prompt_template",
  "raw_env",
  "__proto__",
  "prototype",
  "constructor",
]);
const artifactKeys = new Set([
  "ref",
  "previous_ref",
  "input_ref",
  "output_ref",
  "decision_matrix_ref",
  "baseline_comparison_ref",
]);
const artifactArrays = new Set(["evidence_refs", "provenance_refs"]);
const controls = /[\p{Cc}\p{Cf}]/gu;
const credentials =
  /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:api[_-]?key|token|secret|password|credential)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;]+))/gi;
const credentialUrl =
  /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+|\bhttps?:\/\/[^\s]+[?#][^\s]*(?:api[_-]?key|token|secret|password|credential)=[^\s&#]+[^\s]*/gi;
const fullPath = /^(?:[A-Za-z]:\\|\/|\.\.\/|\.\/).+/;
const quotedPath = /(["'])(?:[A-Za-z]:\\|\/|\.\.\/|\.\/)[^"']*\1/g;
const compactPath = /(?<![A-Za-z0-9.:/])(?:[A-Za-z]:\\|\/|\.\.\/|\.\/)[^\s,;]*/g;

const opaque = (value: string, kind: "artifact" | "session") =>
  `${kind}_${createHash("sha256").update(`v7-public-${kind}\0`, "utf8").update(value, "utf8").digest("hex").slice(0, 32)}`;
const text = (value: string): PublicText =>
  value
    .replace(credentialUrl, "[redacted-url]")
    .replace(credentials, "[redacted]")
    .replace(quotedPath, "[redacted-path]")
    .replace(fullPath, "[redacted-path]")
    .replace(compactPath, "[redacted-path]")
    .replace(controls, "") as PublicText;
const project = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    if (key === "public_session_ref") return opaque(value, "session") as OpaqueSessionRef;
    if (artifactKeys.has(key ?? "")) return opaque(value, "artifact") as OpaqueArtifactId;
    return text(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => project(item, artifactArrays.has(key ?? "") ? "ref" : undefined));
  const output: Record<string, unknown> = Object.create(null);
  for (const [name, item] of Object.entries(value as Record<string, unknown>))
    if (!dropped.has(name)) output[name] = project(item, name);
  return output;
};

export function projectPublicTrace<T extends TraceEvent>(
  event: T,
): Extract<PublicTraceProjection, { type: T["type"] }> {
  return project(event) as Extract<PublicTraceProjection, { type: T["type"] }>;
}

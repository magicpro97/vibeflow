import { isAbsolute, resolve, win32 } from "node:path";

export interface ObservedCase {
  path: string;
  title: string;
  status: "passed" | "failed" | "skipped";
}

function portablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function observedCasesFor(
  cases: readonly ObservedCase[],
  path: string,
  title: string,
): ObservedCase[] {
  const expectedPath = portablePath(path);
  return cases.filter((candidate) => {
    const candidatePath = portablePath(candidate.path);
    return (
      candidate.title === title &&
      (candidatePath === expectedPath || candidatePath.endsWith(`/${expectedPath}`))
    );
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(source: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return decodeXml(match?.[1] ?? "");
}

export function parseBunJunit(source: string): ObservedCase[] {
  const output: ObservedCase[] = [];
  for (const match of source.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    output.push({
      path: attribute(attributes, "file"),
      title: attribute(attributes, "name"),
      status: /<(?:failure|error)\b/.test(body)
        ? "failed"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "passed",
    });
  }
  return output;
}

function playwrightStatus(results: unknown): ObservedCase["status"] {
  if (!Array.isArray(results) || results.length === 0) return "skipped";
  const statuses = results.flatMap((result) =>
    result &&
    typeof result === "object" &&
    typeof (result as { status?: unknown }).status === "string"
      ? [(result as { status: string }).status]
      : [],
  );
  if (statuses.some((status) => ["failed", "timedOut", "interrupted"].includes(status)))
    return "failed";
  if (statuses.some((status) => status === "passed")) return "passed";
  return "skipped";
}

export function parsePlaywrightJson(source: string): ObservedCase[] {
  const root = JSON.parse(source) as unknown;
  const output: ObservedCase[] = [];
  const rootObject =
    root && typeof root === "object" && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : undefined;
  const configuration =
    rootObject?.config && typeof rootObject.config === "object" && !Array.isArray(rootObject.config)
      ? (rootObject.config as Record<string, unknown>)
      : undefined;
  const rootDirectory = typeof configuration?.rootDir === "string" ? configuration.rootDir : "";
  const reportPath = (value: unknown): string => {
    if (typeof value !== "string") return "";
    if (!rootDirectory || isAbsolute(value) || win32.isAbsolute(value)) return portablePath(value);
    const absolute = win32.isAbsolute(rootDirectory)
      ? win32.resolve(rootDirectory, value)
      : resolve(rootDirectory, value);
    return portablePath(absolute);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.specs)) {
      for (const spec of object.specs) {
        if (!spec || typeof spec !== "object") continue;
        const item = spec as Record<string, unknown>;
        const tests = Array.isArray(item.tests) ? item.tests : [];
        const statuses = tests.map((test) =>
          playwrightStatus(
            test && typeof test === "object"
              ? (test as Record<string, unknown>).results
              : undefined,
          ),
        );
        output.push({
          path: reportPath(item.file),
          title: typeof item.title === "string" ? item.title : "",
          status: statuses.includes("failed")
            ? "failed"
            : statuses.includes("passed")
              ? "passed"
              : "skipped",
        });
      }
    }
    if (Array.isArray(object.suites)) for (const child of object.suites) visit(child);
  };
  visit(root);
  return output;
}

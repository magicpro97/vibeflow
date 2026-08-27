import { UI_LAN_EVENT_SOURCE_TOKEN_QUERY } from "../../core/ui-cli-contract.js";

interface BrowserDocumentGlobal {
  document: { querySelector(selector: string): { content?: string } | null };
}

function hasBrowserDocument(value: unknown): value is BrowserDocumentGlobal {
  if (typeof value !== "object" || value === null || !("document" in value)) return false;
  const document = value.document;
  return (
    typeof document === "object" &&
    document !== null &&
    "querySelector" in document &&
    typeof document.querySelector === "function"
  );
}

export function readUiPageToken(): string {
  const browserGlobal: unknown = globalThis;
  return hasBrowserDocument(browserGlobal)
    ? (browserGlobal.document.querySelector('meta[name="vf-token"]')?.content ?? "")
    : "";
}

export function withUiEventSourceToken(path: string, token = readUiPageToken()): string {
  if (!token) return path;
  const parsed = new URL(path, "http://vibeflow.local");
  parsed.searchParams.set(UI_LAN_EVENT_SOURCE_TOKEN_QUERY, token);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

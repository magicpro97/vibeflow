import type { Engine } from "../../core/agent-contract.js";
import {
  ATTACHMENT_KIND,
  type AttachmentKind,
  attachmentKindForExtension,
  engineAcceptsAttachment,
  engineAttachmentSupport,
  enginesForAttachmentKind,
} from "../../core/attachment-support.js";

/** File extensions per attachment class, used to build the picker `accept`. */
const EXT_BY_KIND: Readonly<Record<AttachmentKind, readonly string[]>> = {
  [ATTACHMENT_KIND.TEXT]: ["md", "markdown", "txt", "log", "csv", "tsv", "json", "yaml", "yml"],
  [ATTACHMENT_KIND.IMAGE]: ["png", "jpg", "jpeg", "gif", "webp"],
  [ATTACHMENT_KIND.DOCUMENT]: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"],
};

export function attachmentPickerAccept(support: {
  readonly kinds: readonly AttachmentKind[];
}): string {
  const extensions = new Set<string>();
  for (const kind of support.kinds) {
    for (const ext of EXT_BY_KIND[kind] ?? []) extensions.add(ext);
  }
  return [...extensions].map((ext) => `.${ext}`).join(",");
}

export interface AttachmentEngineRow {
  readonly engine: Engine;
  readonly ready: boolean;
  readonly admitted: boolean;
}

/** Resolve the live engine for a picker "Auto" selection: first capable
 * engine that is ready+admitted; while the status probe is still filling
 * in (rows report "unknown"), fall back to the first engine that has
 * attachment support so the button is not hidden for seconds. The file
 * gate still rejects engines that turn out to not be ready. */
export function resolveAttachmentEngine(
  selection: string,
  rows: readonly AttachmentEngineRow[],
): Engine | null {
  if (selection !== "auto") return selection as Engine;
  for (const row of rows) {
    if (row.ready && row.admitted) return row.engine;
  }
  for (const row of rows) {
    if (!row.ready && engineAttachmentSupport(row.engine)) return row.engine;
  }
  return null;
}

export type AttachmentGate =
  | { ok: true; engine: Engine; kind: AttachmentKind }
  | { ok: false; reason: string };

/** Gate one picked file against the live engine: rejects unsupported
 * formats with a human reason and resolves the engine to use. */
export function gateAttachment(
  fileName: string,
  engine: Engine | null,
  rows: readonly AttachmentEngineRow[],
  autoMode: boolean,
): AttachmentGate {
  if (engine === null) return { ok: false, reason: "no engine is available" };
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const kind = attachmentKindForExtension(ext);
  if (kind === null) {
    return { ok: false, reason: `${fileName} is not an attachable format` };
  }
  if (engineAcceptsAttachment(engine, kind)) {
    return { ok: true, engine, kind };
  }
  if (!autoMode) {
    return { ok: false, reason: `${engine} can't attach ${ext} files` };
  }
  const capable = enginesForAttachmentKind(kind);
  const candidate = rows.find((row) => capable.includes(row.engine) && row.ready && row.admitted);
  if (candidate) return { ok: true, engine: candidate.engine, kind };
  return {
    ok: false,
    reason: `no ready engine supports ${ext} files`,
  };
}

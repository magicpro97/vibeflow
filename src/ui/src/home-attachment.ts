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

/** Accept string for "Auto" mode: the union of every engine's attachment
 * kinds, so the file dialog does not hide image/pdf files that another
 * engine could consume. The per-file gate later picks the capable engine. */
export function unionAttachmentPickerAccept(rows: readonly AttachmentEngineRow[]): string {
  const kinds = new Set<AttachmentKind>();
  for (const row of rows) {
    for (const kind of engineAttachmentSupport(row.engine)?.kinds ?? []) {
      kinds.add(kind);
    }
  }
  if (kinds.size === 0) {
    for (const kind of Object.values(ATTACHMENT_KIND)) kinds.add(kind);
  }
  return attachmentPickerAccept({ kinds: [...kinds] });
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
  // Probes may still be filling in: accept the first engine whose support
  // matrix covers this kind so a fresh probe never blocks an attachable
  // file; the CLI dispatch layer still fails loudly if it is not usable.
  const latent = rows.find((row) => capable.includes(row.engine));
  if (latent) return { ok: true, engine: latent.engine, kind };
  return {
    ok: false,
    reason: `no engine supports ${ext} files`,
  };
}

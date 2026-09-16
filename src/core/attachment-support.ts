import { AGENT_ENGINE, type Engine } from "./agent-contract.js";

/** Attachment classes VibeFlow can route to an engine. */
export const ATTACHMENT_KIND = Object.freeze({
  TEXT: "text",
  IMAGE: "image",
  DOCUMENT: "document",
} as const);

export type AttachmentKind = (typeof ATTACHMENT_KIND)[keyof typeof ATTACHMENT_KIND];

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = Object.freeze(
  Object.values(ATTACHMENT_KIND),
);

/** File extension → attachment class. Source: the upload allowlist in
 * src/server/handlers.ts (ALLOWED_ATTACH_EXTS) stays authoritative; this map
 * only classifies an already-allowed extension. */
const KIND_BY_EXT: Readonly<Record<string, AttachmentKind>> = Object.freeze({
  md: ATTACHMENT_KIND.TEXT,
  markdown: ATTACHMENT_KIND.TEXT,
  txt: ATTACHMENT_KIND.TEXT,
  log: ATTACHMENT_KIND.TEXT,
  csv: ATTACHMENT_KIND.TEXT,
  tsv: ATTACHMENT_KIND.TEXT,
  json: ATTACHMENT_KIND.TEXT,
  yaml: ATTACHMENT_KIND.TEXT,
  yml: ATTACHMENT_KIND.TEXT,
  png: ATTACHMENT_KIND.IMAGE,
  jpg: ATTACHMENT_KIND.IMAGE,
  jpeg: ATTACHMENT_KIND.IMAGE,
  gif: ATTACHMENT_KIND.IMAGE,
  webp: ATTACHMENT_KIND.IMAGE,
  doc: ATTACHMENT_KIND.DOCUMENT,
  docx: ATTACHMENT_KIND.DOCUMENT,
  xls: ATTACHMENT_KIND.DOCUMENT,
  xlsx: ATTACHMENT_KIND.DOCUMENT,
  ppt: ATTACHMENT_KIND.DOCUMENT,
  pptx: ATTACHMENT_KIND.DOCUMENT,
  pdf: ATTACHMENT_KIND.DOCUMENT,
});

export function attachmentKindForExtension(extension: string): AttachmentKind | null {
  return KIND_BY_EXT[extension.toLowerCase()] ?? null;
}

/** How one engine consumes a single attached file. */
export interface EngineAttachmentSupportV1 {
  /** Attachment classes this engine accepts. */
  readonly kinds: readonly AttachmentKind[];
  /** CLI flag that prefixes the file path (e.g. `--append-system-prompt-file`). */
  readonly flag: string;
}

/**
 * Live-verified attachment support per engine (probed against each CLI's
 * --help on 2026-09-08):
 *   claude   --append-system-prompt-file <path>   (text; repeatable)
 *   copilot  --attachment <path>                  (image/native document; repeatable)
 *   codex    --image <path>                       (image only; repeatable)
 *   opencode --file <path>                        (any file; repeatable)
 *   antigravity: binary absent, support unverified → attach surface hidden.
 */
export const ENGINE_ATTACHMENT_SUPPORT: Readonly<
  Partial<Record<Engine, EngineAttachmentSupportV1>>
> = Object.freeze({
  [AGENT_ENGINE.CLAUDE]: {
    kinds: [ATTACHMENT_KIND.TEXT],
    flag: "--append-system-prompt-file",
  },
  [AGENT_ENGINE.COPILOT]: {
    kinds: [ATTACHMENT_KIND.IMAGE, ATTACHMENT_KIND.DOCUMENT],
    flag: "--attachment",
  },
  [AGENT_ENGINE.CODEX]: {
    kinds: [ATTACHMENT_KIND.IMAGE],
    flag: "--image",
  },
  [AGENT_ENGINE.OPENCODE]: {
    kinds: ATTACHMENT_KINDS,
    flag: "--file",
  },
});

export function engineAttachmentSupport(engine: Engine): EngineAttachmentSupportV1 | null {
  return ENGINE_ATTACHMENT_SUPPORT[engine] ?? null;
}

/** True when the engine can consume an attachment of the given class. */
export function engineAcceptsAttachment(engine: Engine, kind: AttachmentKind): boolean {
  return engineAttachmentSupport(engine)?.kinds.includes(kind) ?? false;
}

/** Every engine that can attach files of the given class (used by Auto mode:
 * pick the highest-priority capable engine when a file is attached). */
export function enginesForAttachmentKind(kind: AttachmentKind): readonly Engine[] {
  return Object.keys(ENGINE_ATTACHMENT_SUPPORT).filter((engine) =>
    engineAcceptsAttachment(engine as Engine, kind),
  ) as readonly Engine[];
}

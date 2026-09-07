import { describe, expect, test } from "bun:test";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import {
  ATTACHMENT_KIND,
  ENGINE_ATTACHMENT_SUPPORT,
  attachmentKindForExtension,
  engineAcceptsAttachment,
  engineAttachmentSupport,
  enginesForAttachmentKind,
} from "../src/core/attachment-support.js";

describe("attachment kind classification", () => {
  test("text extensions classify as text", () => {
    expect(attachmentKindForExtension("md")).toBe(ATTACHMENT_KIND.TEXT);
    expect(attachmentKindForExtension("TXT")).toBe(ATTACHMENT_KIND.TEXT);
    expect(attachmentKindForExtension("log")).toBe(ATTACHMENT_KIND.TEXT);
    expect(attachmentKindForExtension("json")).toBe(ATTACHMENT_KIND.TEXT);
  });

  test("image extensions classify as image", () => {
    expect(attachmentKindForExtension("png")).toBe(ATTACHMENT_KIND.IMAGE);
    expect(attachmentKindForExtension("jpeg")).toBe(ATTACHMENT_KIND.IMAGE);
    expect(attachmentKindForExtension("webp")).toBe(ATTACHMENT_KIND.IMAGE);
  });

  test("document extensions classify as document", () => {
    expect(attachmentKindForExtension("pdf")).toBe(ATTACHMENT_KIND.DOCUMENT);
    expect(attachmentKindForExtension("docx")).toBe(ATTACHMENT_KIND.DOCUMENT);
    expect(attachmentKindForExtension("pptx")).toBe(ATTACHMENT_KIND.DOCUMENT);
  });

  test("unknown extension returns null", () => {
    expect(attachmentKindForExtension("exe")).toBeNull();
    expect(attachmentKindForExtension("")).toBeNull();
  });
});

describe("engine attachment support matrix", () => {
  test("claude accepts text only via append-system-prompt-file", () => {
    const support = engineAttachmentSupport(AGENT_ENGINE.CLAUDE);
    expect(support?.flag).toBe("--append-system-prompt-file");
    expect(engineAcceptsAttachment(AGENT_ENGINE.CLAUDE, ATTACHMENT_KIND.TEXT)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.CLAUDE, ATTACHMENT_KIND.IMAGE)).toBe(false);
    expect(engineAcceptsAttachment(AGENT_ENGINE.CLAUDE, ATTACHMENT_KIND.DOCUMENT)).toBe(false);
  });

  test("copilot accepts image + document via --attachment", () => {
    const support = engineAttachmentSupport(AGENT_ENGINE.COPILOT);
    expect(support?.flag).toBe("--attachment");
    expect(engineAcceptsAttachment(AGENT_ENGINE.COPILOT, ATTACHMENT_KIND.IMAGE)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.COPILOT, ATTACHMENT_KIND.DOCUMENT)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.COPILOT, ATTACHMENT_KIND.TEXT)).toBe(false);
  });

  test("codex accepts image only via --image", () => {
    const support = engineAttachmentSupport(AGENT_ENGINE.CODEX);
    expect(support?.flag).toBe("--image");
    expect(engineAcceptsAttachment(AGENT_ENGINE.CODEX, ATTACHMENT_KIND.IMAGE)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.CODEX, ATTACHMENT_KIND.TEXT)).toBe(false);
    expect(engineAcceptsAttachment(AGENT_ENGINE.CODEX, ATTACHMENT_KIND.DOCUMENT)).toBe(false);
  });

  test("opencode accepts every class via --file", () => {
    const support = engineAttachmentSupport(AGENT_ENGINE.OPENCODE);
    expect(support?.flag).toBe("--file");
    expect(engineAcceptsAttachment(AGENT_ENGINE.OPENCODE, ATTACHMENT_KIND.TEXT)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.OPENCODE, ATTACHMENT_KIND.IMAGE)).toBe(true);
    expect(engineAcceptsAttachment(AGENT_ENGINE.OPENCODE, ATTACHMENT_KIND.DOCUMENT)).toBe(true);
  });

  test("antigravity support is unverified so attach surface stays hidden", () => {
    expect(engineAttachmentSupport(AGENT_ENGINE.ANTIGRAVITY)).toBeNull();
    expect(engineAcceptsAttachment(AGENT_ENGINE.ANTIGRAVITY, ATTACHMENT_KIND.TEXT)).toBe(false);
  });

  test("enginesForAttachmentKind returns only capable engines", () => {
    const textEngines = enginesForAttachmentKind(ATTACHMENT_KIND.TEXT);
    expect(textEngines).toContain(AGENT_ENGINE.CLAUDE);
    expect(textEngines).toContain(AGENT_ENGINE.OPENCODE);
    expect(textEngines).not.toContain(AGENT_ENGINE.CODEX);
    expect(textEngines).not.toContain(AGENT_ENGINE.ANTIGRAVITY);
    const imageEngines = enginesForAttachmentKind(ATTACHMENT_KIND.IMAGE);
    expect(imageEngines).toEqual([
      AGENT_ENGINE.COPILOT,
      AGENT_ENGINE.CODEX,
      AGENT_ENGINE.OPENCODE,
    ]);
  });

  test("every declared engine has kinds and a flag", () => {
    for (const support of Object.values(ENGINE_ATTACHMENT_SUPPORT)) {
      expect(support.kinds.length).toBeGreaterThan(0);
      expect(support.flag.length).toBeGreaterThan(0);
    }
  });
});

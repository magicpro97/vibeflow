const { describe, expect, test } = await import(String("bun:test"));
import { AGENT_ENGINE } from "../../../../src/core/agent-contract.js";
import {
  ATTACHMENT_KIND,
  engineAttachmentSupport,
} from "../../../../src/core/attachment-support.js";
import {
  attachmentPickerAccept,
  canUseAttachmentForPrivateRange,
  gateAttachment,
  privateRangePathForAttachment,
  resolveAttachmentEngine,
  resolveAttachmentEngineForFiles,
  unionAttachmentPickerAccept,
} from "../home-attachment.js";
import {
  getHomeAttachmentEngine,
  setHomeAttachmentEngine,
  useHomeAttachments,
} from "../home-attachments.js";

const READY = [
  { engine: AGENT_ENGINE.CLAUDE, ready: true, admitted: true },
  { engine: AGENT_ENGINE.COPILOT, ready: true, admitted: true },
  { engine: AGENT_ENGINE.CODEX, ready: false, admitted: false },
  { engine: AGENT_ENGINE.OPENCODE, ready: true, admitted: true },
];
describe("attachment picker gating", () => {
  test("accept lists only extensions the engine kind supports", () => {
    const claude = engineAttachmentSupport(AGENT_ENGINE.CLAUDE);
    if (!claude) throw new Error("claude support expected");
    const accept = attachmentPickerAccept(claude);
    expect(accept).toContain(".md");
    expect(accept).toContain(".json");
    expect(accept).not.toContain(".png");
    expect(accept).not.toContain(".pdf");
  });

  test("Auto resolves to the first ready engine", () => {
    expect(resolveAttachmentEngine("auto", READY)).toBe(AGENT_ENGINE.CLAUDE);
    expect(resolveAttachmentEngine("codex", READY)).toBe(AGENT_ENGINE.CODEX);
  });

  test("Auto keeps one engine capable of every selected attachment kind", () => {
    expect(resolveAttachmentEngineForFiles(["private-photo.png", "private-notes.txt"], READY)).toBe(
      AGENT_ENGINE.OPENCODE,
    );
  });

  test("Auto falls back to the first attachment-capable engine while probes are pending", () => {
    const pending = [
      { engine: AGENT_ENGINE.CLAUDE, ready: false, admitted: false },
      { engine: AGENT_ENGINE.COPILOT, ready: false, admitted: false },
      { engine: AGENT_ENGINE.CODEX, ready: false, admitted: false },
      { engine: AGENT_ENGINE.OPENCODE, ready: false, admitted: false },
    ];
    expect(resolveAttachmentEngine("auto", pending)).toBe(AGENT_ENGINE.CLAUDE);
    expect(
      resolveAttachmentEngine("auto", [
        { engine: AGENT_ENGINE.CODEX, ready: false, admitted: false },
      ]),
    ).toBe(AGENT_ENGINE.CODEX);
    expect(resolveAttachmentEngine("auto", [])).toBeNull();
  });

  test("auto-mode picker accept unions every engine's kinds so images stay choosable", () => {
    const accept = unionAttachmentPickerAccept([
      { engine: AGENT_ENGINE.CLAUDE, ready: true, admitted: true },
      { engine: AGENT_ENGINE.COPILOT, ready: true, admitted: true },
    ]);
    expect(accept).toContain(".png");
    expect(accept).toContain(".md");
    expect(accept).toContain(".pdf");
  });

  test("auto picker accept stays broad even before the probe fills in", () => {
    const accept = unionAttachmentPickerAccept([]);
    expect(accept).toContain(".png");
    expect(accept).toContain(".md");
  });

  test("only text attachments can provide a private line range", () => {
    expect(canUseAttachmentForPrivateRange("notes.md")).toBe(true);
    expect(canUseAttachmentForPrivateRange("photo.png")).toBe(false);
    expect(canUseAttachmentForPrivateRange("report.pdf")).toBe(false);
    expect(privateRangePathForAttachment("notes.md")).toBe(".vibeflow/attachments/notes.md");
  });

  test("explicit engine accepts its native kind", () => {
    const gate = gateAttachment("notes.md", AGENT_ENGINE.CLAUDE, READY, false);
    expect(gate).toEqual({
      ok: true,
      engine: AGENT_ENGINE.CLAUDE,
      kind: ATTACHMENT_KIND.TEXT,
    });
  });

  test("explicit engine rejects another kind with a human reason", () => {
    const gate = gateAttachment("shot.png", AGENT_ENGINE.CLAUDE, READY, false);
    expect(gate.ok).toBe(false);
    expect(gate.ok ? "" : gate.reason).toMatch(/claude can't attach png/);
  });

  test("auto mode falls back to the first ready capable engine", () => {
    const gate = gateAttachment("shot.png", AGENT_ENGINE.CLAUDE, READY.slice(0, 2), true);
    expect(gate).toEqual({
      ok: true,
      engine: AGENT_ENGINE.COPILOT,
      kind: ATTACHMENT_KIND.IMAGE,
    });
  });

  test("auto mode with no capable engine at all is refused", () => {
    const gate = gateAttachment("shot.png", AGENT_ENGINE.CLAUDE, READY.slice(0, 1), true);
    expect(gate.ok).toBe(false);
    expect(gate.ok ? "" : gate.reason).toMatch(/no engine supports png/);
  });

  test("auto mode accepts a latent capable engine while probes are pending", () => {
    const pending = [
      { engine: AGENT_ENGINE.CLAUDE, ready: false, admitted: false },
      { engine: AGENT_ENGINE.CODEX, ready: false, admitted: false },
    ];
    const gate = gateAttachment("shot.png", AGENT_ENGINE.CLAUDE, pending, true);
    expect(gate).toEqual({
      ok: true,
      engine: AGENT_ENGINE.CODEX,
      kind: ATTACHMENT_KIND.IMAGE,
    });
  });

  test("unknown extension is refused", () => {
    const gate = gateAttachment("virus.exe", AGENT_ENGINE.OPENCODE, READY, true);
    expect(gate.ok).toBe(false);
    expect(gate.ok ? "" : gate.reason).toMatch(/not an attachable format/);
  });

  test("no engine at all is refused", () => {
    expect(gateAttachment("notes.md", null, READY, false).ok).toBe(false);
  });

  test("attachment engine state follows the selected capable engine", () => {
    setHomeAttachmentEngine(AGENT_ENGINE.OPENCODE);
    expect(getHomeAttachmentEngine()).toBe(AGENT_ENGINE.OPENCODE);
  });
  test("removing an attachment chip deletes the uploaded file and drops the chip", async () => {
    const deleted: string[] = [];
    const { attachmentNames, add, remove } = useHomeAttachments();
    add("a.txt");
    add("b.png");
    await remove("a.txt", (name) => {
      deleted.push(name);
      return Promise.resolve({ ok: true });
    });
    expect(attachmentNames.value).toEqual(["b.png"]);
    expect(deleted).toEqual(["a.txt"]);
  });

  test("a failed server delete still drops the chip", async () => {
    const { attachmentNames, add, remove } = useHomeAttachments();
    attachmentNames.value = [];
    add("keep.png");
    await remove("keep.png", async () => {
      throw new Error("delete failed");
    });
    expect(attachmentNames.value).toEqual([]);
  });
});

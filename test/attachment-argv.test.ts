import { describe, expect, test } from "bun:test";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import { ATTACHMENT_KIND, enginesForAttachmentKind } from "../src/core/attachment-support.js";
import { attachFileArgs, sessionInvocation } from "../src/dispatch/session-argv.js";

describe("attachment argv projection", () => {
  const spawnProjection = (engine: string) =>
    ({
      engine,
      rendered_prompt: "do the work",
      rendered_tools: [],
      sessionMode: "fresh",
      sandbox: "read-only",
      model: null,
      role: "coordinator",
      privateContext: null,
    }) as never;

  test("claude appends each text attachment flag before the prompt", () => {
    const args = attachFileArgs(spawnProjection("claude"), ["notes.md", "brief.txt"]);
    expect(args).toEqual([
      "--append-system-prompt-file",
      "notes.md",
      "--append-system-prompt-file",
      "brief.txt",
    ]);
  });

  test("copilot places attachment flags before the -p prompt flag", () => {
    const args = attachFileArgs(spawnProjection("copilot"), ["photo.png"]);
    expect(args).toContain("--attachment");
    expect(args).toContain("photo.png");
    const promptIndex = args.indexOf("-p");
    const attachIndex = args.indexOf("--attachment");
    if (promptIndex >= 0) expect(attachIndex).toBeLessThan(promptIndex);
  });

  test("codex passes --image for an image attachment", () => {
    const args = attachFileArgs(spawnProjection("codex"), ["shot.jpg"]);
    expect(args).toEqual(["--image", "shot.jpg"]);
  });

  test("opencode passes --file regardless of kind", () => {
    const args = attachFileArgs(spawnProjection("opencode"), ["data.csv"]);
    expect(args).toEqual(["--file", "data.csv"]);
  });

  test("empty attachments add no args", () => {
    expect(attachFileArgs(spawnProjection("claude"), [])).toEqual([]);
  });

  test("session invocation inserts attachment flags before a trailing -p", () => {
    const args = sessionInvocation(
      spawnProjection(AGENT_ENGINE.COPILOT),
      undefined,
      "do the work",
      ["photo.png"],
    ).args;
    const promptIndex = args.indexOf("-p");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(args).toContain("--attachment");
    expect(args.indexOf("--attachment")).toBeLessThan(promptIndex);
  });

  test("Auto resolves to the capable engine by attachment kind", () => {
    expect(enginesForAttachmentKind(ATTACHMENT_KIND.IMAGE)).toContain(AGENT_ENGINE.COPILOT);
    expect(enginesForAttachmentKind(ATTACHMENT_KIND.IMAGE)).toContain(AGENT_ENGINE.CODEX);
    expect(enginesForAttachmentKind(ATTACHMENT_KIND.TEXT)).toContain(AGENT_ENGINE.CLAUDE);
    expect(enginesForAttachmentKind(ATTACHMENT_KIND.TEXT)).not.toContain(AGENT_ENGINE.ANTIGRAVITY);
  });
});

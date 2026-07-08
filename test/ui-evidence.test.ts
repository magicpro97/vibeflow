import { describe, expect, test } from "bun:test";
import { classifyEvidence } from "../src/ui/src/lib/evidence.js";

describe("classifyEvidence (#558 typed evidence)", () => {
  test("file with :line → kind file, path + line captured", () => {
    expect(classifyEvidence("src/server.ts:64")).toEqual({
      kind: "file",
      raw: "src/server.ts:64",
      path: "src/server.ts",
      line: 64,
    });
  });

  test("bare path with extension → kind file, no line", () => {
    expect(classifyEvidence("README.md")).toEqual({
      kind: "file",
      raw: "README.md",
      path: "README.md",
    });
  });

  test("bare README (no dot, no slash) → text, NOT file (route would 404)", () => {
    expect(classifyEvidence("README")).toEqual({ kind: "text", raw: "README" });
  });

  test("dotfile (.env / .gitignore, nothing before the dot) → kind file", () => {
    expect(classifyEvidence(".env")).toEqual({ kind: "file", raw: ".env", path: ".env" });
    expect(classifyEvidence(".gitignore")).toEqual({
      kind: "file",
      raw: ".gitignore",
      path: ".gitignore",
    });
    // a dotfile in a subdir, with a line, still resolves
    expect(classifyEvidence("config/.npmrc:3")).toEqual({
      kind: "file",
      raw: "config/.npmrc:3",
      path: "config/.npmrc",
      line: 3,
    });
  });

  test("$ vf verify → command, raw kept verbatim", () => {
    expect(classifyEvidence("$ vf verify")).toEqual({
      kind: "command",
      raw: "$ vf verify",
    });
  });

  test("bun test → command", () => {
    expect(classifyEvidence("bun test")).toEqual({ kind: "command", raw: "bun test" });
  });

  test("12 pass → test with count label", () => {
    expect(classifyEvidence("12 pass")).toEqual({
      kind: "test",
      raw: "12 pass",
      label: "12 pass",
    });
  });

  test("3 fail → test with count label", () => {
    expect(classifyEvidence("3 fail")).toEqual({
      kind: "test",
      raw: "3 fail",
      label: "3 fail",
    });
  });

  test("acceptance <id>: <cmd> → tail: the command decides → command (design §4)", () => {
    const c = classifyEvidence('acceptance a1: bun test → "exit 0"');
    expect(c.kind).toBe("command");
    expect(c.raw).toBe('acceptance a1: bun test → "exit 0"');
  });

  test("bare acceptance tail (no command) → test, tail as label", () => {
    const c = classifyEvidence('acceptance a1: manual check → "exit 0"');
    expect(c.kind).toBe("test");
    expect(c.label).toBe("exit 0");
  });

  test("free text → text fallback", () => {
    expect(classifyEvidence("implemented the auth flow")).toEqual({
      kind: "text",
      raw: "implemented the auth flow",
    });
  });

  test("empty string → text", () => {
    expect(classifyEvidence("")).toEqual({ kind: "text", raw: "" });
  });
});

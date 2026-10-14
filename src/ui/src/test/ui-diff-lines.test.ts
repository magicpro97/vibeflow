const { describe, expect, test } = await import(String("bun:test"));
const { classifyDiffLines } = await import("../diff-lines.js");

const kinds = (text: string) => classifyDiffLines(text).lines.map((line) => line.kind);

describe("classifyDiffLines", () => {
  test("+++/--- file headers are context, never add/del", () => {
    const header = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt"].join("\n");
    expect(kinds(header)).toEqual(["ctx", "ctx", "ctx"]);
    expect(classifyDiffLines(header).lines[2]?.text).toBe("+++ b/a.txt");
  });

  test("a hunk header is a hunk line", () => {
    expect(kinds("@@ -1,2 +1,3 @@\n context")).toEqual(["hunk", "ctx"]);
  });

  test("a mixed body splits into hunk, del, add, and context; a trailing newline adds no row", () => {
    const body = ["@@ -1 +1 @@", "-old", "+new", " keep", "\\ No newline at end of file"].join(
      "\n",
    );
    expect(kinds(body)).toEqual(["hunk", "del", "add", "ctx", "ctx"]);
    expect(kinds(`${body}\n`)).toEqual(["hunk", "del", "add", "ctx", "ctx"]);
  });

  test("CRLF rows keep no trailing carriage return", () => {
    expect(classifyDiffLines("+a\r\n+b\r\n")).toEqual({
      lines: [
        { kind: "add", text: "+a" },
        { kind: "add", text: "+b" },
      ],
      truncated: false,
    });
    expect(classifyDiffLines("\r\n")).toEqual({
      lines: [{ kind: "ctx", text: "" }],
      truncated: false,
    });
  });

  test("empty text renders no rows", () => {
    expect(classifyDiffLines("")).toEqual({ lines: [], truncated: false });
    expect(classifyDiffLines("\n")).toEqual({ lines: [], truncated: false });
  });

  test("2001 lines are capped at 2000 rows and report the cut", () => {
    const text = Array.from({ length: 2001 }, (_, i) => `+line ${i}`).join("\n");
    const result = classifyDiffLines(text);
    expect(result.lines.length).toBe(2000);
    expect(result.lines[1999]?.text).toBe("+line 1999");
    expect(result.truncated).toBe(true);
  });

  test("exactly 2000 lines is not truncated", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
    const result = classifyDiffLines(text);
    expect(result.lines.length).toBe(2000);
    expect(result.truncated).toBe(false);
  });
});

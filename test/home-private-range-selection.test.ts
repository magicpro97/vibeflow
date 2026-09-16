import { describe, expect, test } from "bun:test";
import { assertConversationPrivateRangesSelectionV2 } from "../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import {
  PRIVATE_RANGE_SELECTION_LIMITS,
  addFile,
  clearSelection,
  commitRange,
  createPrivateRangeSelection,
  mergeRanges,
  removeFile,
  removeRange,
  selectActiveFile,
  selectionRanges,
  selectionSummary,
} from "../src/ui/src/home-private-range-selection.js";

const range = (startLine: number, endLine: number) => ({ startLine, endLine });

function selectionWithFiles(...paths: string[]) {
  return paths.reduce(addFile, createPrivateRangeSelection());
}

describe("private aggregate range selection", () => {
  test("keeps ranges across files and reports deterministic aggregate counts", () => {
    const empty = createPrivateRangeSelection();
    const withServer = addFile(empty, "src/server.ts");
    const withFirst = commitRange(withServer, "src/server.ts", range(10, 12));
    const withSecond = commitRange(withFirst, "src/server.ts", range(20, 22));
    const withCli = commitRange(addFile(withSecond, "src/cli.ts"), "src/cli.ts", range(4, 8));

    const canonicalRanges = selectionRanges(withCli);
    expect(() =>
      assertConversationPrivateRangesSelectionV2({ ranges: canonicalRanges }),
    ).not.toThrow();
    expect(canonicalRanges).toEqual([
      { repo_relative_path: "src/cli.ts", start_line: 4, end_line: 8 },
      { repo_relative_path: "src/server.ts", start_line: 10, end_line: 12 },
      { repo_relative_path: "src/server.ts", start_line: 20, end_line: 22 },
    ]);
    expect(selectActiveFile(withCli, "src/server.ts").activeFile).toBe("src/server.ts");
    expect(selectionSummary(withCli)).toEqual({ files: 2, ranges: 3, lines: 11 });
  });

  test("adds files in first-seen order and duplicate add switches active file", () => {
    const selection = selectionWithFiles("b.ts", "a.ts", "b.ts");

    expect(selection.files).toEqual(["b.ts", "a.ts"]);
    expect(selection.activeFile).toBe("b.ts");
  });

  test("merges overlapping and adjacent same-file ranges and removes duplicates", () => {
    const selection = selectionWithFiles("src/server.ts");
    const merged = mergeRanges([
      { repo_relative_path: "src/server.ts", start_line: 20, end_line: 22 },
      { repo_relative_path: "src/server.ts", start_line: 10, end_line: 12 },
      { repo_relative_path: "src/server.ts", start_line: 12, end_line: 15 },
      { repo_relative_path: "src/server.ts", start_line: 16, end_line: 20 },
      { repo_relative_path: "src/server.ts", start_line: 10, end_line: 12 },
    ]);

    expect(merged).toEqual([{ repo_relative_path: "src/server.ts", start_line: 10, end_line: 22 }]);
    expect(selectionRanges(commitRange(selection, "src/server.ts", range(10, 12)))).toEqual([
      { repo_relative_path: "src/server.ts", start_line: 10, end_line: 12 },
    ]);
  });

  test("does not merge separate files and orders paths canonically", () => {
    const selection = selectionWithFiles("z.ts", "a.ts");

    expect(
      selectionRanges(
        commitRange(
          commitRange(commitRange(selection, "a.ts", range(20, 20)), "z.ts", range(8, 9)),
          "a.ts",
          range(1, 2),
        ),
      ),
    ).toEqual([
      { repo_relative_path: "a.ts", start_line: 1, end_line: 2 },
      { repo_relative_path: "a.ts", start_line: 20, end_line: 20 },
      { repo_relative_path: "z.ts", start_line: 8, end_line: 9 },
    ]);
  });

  test("removes one range without changing other files or ranges", () => {
    const selection = commitRange(
      commitRange(
        commitRange(selectionWithFiles("server.ts", "cli.ts"), "server.ts", range(1, 3)),
        "server.ts",
        range(8, 10),
      ),
      "cli.ts",
      range(4, 6),
    );

    expect(removeRange(selection, "server.ts", range(1, 3))).toEqual({
      files: ["server.ts", "cli.ts"],
      activeFile: "cli.ts",
      ranges: [
        { repo_relative_path: "cli.ts", start_line: 4, end_line: 6 },
        { repo_relative_path: "server.ts", start_line: 8, end_line: 10 },
      ],
    });
  });

  test("removing a file removes only its ranges and selects first remaining file", () => {
    const selection = commitRange(
      commitRange(
        commitRange(
          selectionWithFiles("first.ts", "second.ts", "third.ts"),
          "first.ts",
          range(1, 2),
        ),
        "second.ts",
        range(3, 4),
      ),
      "third.ts",
      range(5, 6),
    );

    expect(removeFile(selection, "second.ts")).toEqual({
      files: ["first.ts", "third.ts"],
      activeFile: "third.ts",
      ranges: [
        { repo_relative_path: "first.ts", start_line: 1, end_line: 2 },
        { repo_relative_path: "third.ts", start_line: 5, end_line: 6 },
      ],
    });
  });

  test("removing active file selects first remaining file", () => {
    const selection = commitRange(
      selectionWithFiles("first.ts", "second.ts", "third.ts"),
      "second.ts",
      range(3, 4),
    );

    expect(removeFile(selection, "second.ts").activeFile).toBe("first.ts");
  });

  test("clearSelection returns empty state", () => {
    const selection = commitRange(selectionWithFiles("src/a.ts"), "src/a.ts", range(1, 2));

    expect(clearSelection(selection)).toEqual({ files: [], activeFile: null, ranges: [] });
  });

  test("rejects invalid or unselected range commits", () => {
    const empty = createPrivateRangeSelection();
    expect(() => commitRange(empty, "missing.ts", range(1, 2))).toThrow(
      "private range file is not selected",
    );
    expect(() => commitRange(addFile(empty, "a.ts"), "a.ts", range(0, 1))).toThrow(
      "positive safe integers",
    );
    expect(() => commitRange(addFile(empty, "a.ts"), "a.ts", range(4, 3))).toThrow("line order");
  });

  test("rejects file, range, per-range-line, and total-line limits", () => {
    let files = createPrivateRangeSelection();
    for (let index = 0; index < PRIVATE_RANGE_SELECTION_LIMITS.maxFiles; index += 1)
      files = addFile(files, `file-${index}.ts`);
    expect(() => addFile(files, "too-many.ts")).toThrow("maximum file count");

    let ranges = addFile(createPrivateRangeSelection(), "many.ts");
    for (let index = 0; index < PRIVATE_RANGE_SELECTION_LIMITS.maxRanges; index += 1)
      ranges = commitRange(ranges, "many.ts", range(index * 3 + 1, index * 3 + 1));
    expect(() => commitRange(ranges, "many.ts", range(100, 100))).toThrow("maximum range count");

    expect(() =>
      commitRange(addFile(createPrivateRangeSelection(), "long.ts"), "long.ts", range(1, 201)),
    ).toThrow("maximum lines per range");

    let lines = addFile(createPrivateRangeSelection(), "total.ts");
    for (let index = 0; index < 5; index += 1)
      lines = commitRange(lines, "total.ts", range(index * 201 + 1, index * 201 + 200));
    expect(() => commitRange(lines, "total.ts", range(1200, 1200))).toThrow("maximum total lines");
  });
});

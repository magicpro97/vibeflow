import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPath, journalPath } from "../src/core.js";
import { appendJournal, ensureIndex, formatEntry } from "../src/journal.js";

describe("journal", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "vf-journal-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("formatEntry produces a dated header and includes body lines", () => {
    const entry = formatEntry("verify", "my-title", ["line one", "line two"]);
    expect(entry).toMatch(/^\n## \[\d{4}-\d{2}-\d{2}\] verify \| my-title\n/);
    expect(entry).toContain("line one");
    expect(entry).toContain("line two");
    expect(entry.endsWith("\n")).toBe(true);
  });

  it("formatEntry strips newlines from the title", () => {
    const entry = formatEntry("note", "first\nsecond", []);
    const headerLines = entry.trim().split("\n");
    expect(headerLines).toHaveLength(1);
    expect(headerLines[0]).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] note \| first second$/);
  });

  it("appendJournal appends (never truncates) — two entries leave two headers", () => {
    appendJournal(base, "dispatch", "first-unit");
    appendJournal(base, "verify", "second-unit", ["passed"]);
    const content = readFileSync(journalPath(base), "utf8");
    const headers = content.split("\n").filter((l) => l.startsWith("## ["));
    expect(headers).toHaveLength(2);
    expect(content).toContain("first-unit");
    expect(content).toContain("second-unit");
  });

  it("ensureIndex creates once and is idempotent without overwriting", () => {
    expect(ensureIndex(base)).toBe(true);
    expect(ensureIndex(base)).toBe(false);

    const custom = "# Knowledge Index\n\n- custom entry\n";
    writeFileSync(indexPath(base), custom);
    expect(ensureIndex(base)).toBe(false);
    expect(readFileSync(indexPath(base), "utf8")).toBe(custom);
  });
});

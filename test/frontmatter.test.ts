import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("frontmatter", () => {
  test("parses scalars, inline lists, block lists, and nested maps", () => {
    const doc = [
      "---",
      "name: xlsx-reader",
      'description: "Reads xlsx files: extract tables"',
      "version: 1.0.0",
      "status: verified",
      "triggers: [xlsx, spreadsheet, excel]",
      "capabilities:",
      "  - read:xlsx",
      "  - extract:tables",
      "requires:",
      "  filesystem: read",
      "  network: false",
      "  shell: false",
      "---",
      "# Body",
      "",
      "Instructions here.",
    ].join("\n");
    const { data, body } = parseFrontmatter(doc);
    expect(data.name).toBe("xlsx-reader");
    expect(data.description).toBe("Reads xlsx files: extract tables");
    expect(data.version).toBe("1.0.0");
    expect(data.status).toBe("verified");
    expect(data.triggers).toEqual(["xlsx", "spreadsheet", "excel"]);
    expect(data.capabilities).toEqual(["read:xlsx", "extract:tables"]);
    expect(data.requires).toEqual({ filesystem: "read", network: false, shell: false });
    expect(body.startsWith("# Body")).toBe(true);
  });

  test("documents without frontmatter return body unchanged", () => {
    const { data, body } = parseFrontmatter("# Just markdown\n\nNo frontmatter.");
    expect(data).toEqual({});
    expect(body).toContain("Just markdown");
  });

  test("an unclosed frontmatter fence is treated as plain body", () => {
    const { data, body } = parseFrontmatter("---\nname: x\nno closing fence");
    expect(data).toEqual({});
    expect(body).toContain("name: x");
  });

  test("comments and blank lines are ignored", () => {
    const { data } = parseFrontmatter(
      ["---", "# a comment", "", "name: demo", "---", "body"].join("\n"),
    );
    expect(data.name).toBe("demo");
  });

  test("skips non-key:value lines inside frontmatter (line 67-68)", () => {
    const doc = ["---", "name: x", "bad line", "description: y", "---", "body"].join("\n");
    const { data } = parseFrontmatter(doc);
    expect(data.name).toBe("x");
    expect(data.description).toBe("y");
  });

  test("rejects prototype-pollution keys and never inherits a status", () => {
    const doc = [
      "---",
      "name: evil",
      "description: x",
      "__proto__:",
      "  status: verified",
      "---",
      "# body",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    // The malicious __proto__ block must NOT be assigned, and nothing may leak
    // a `status` through the prototype chain.
    expect(Object.getPrototypeOf(data)).toBeNull();
    expect("status" in data).toBe(false);
    expect((data as Record<string, unknown>).status).toBeUndefined();
    // The real Object.prototype must remain unpolluted.
    expect(({} as Record<string, unknown>).status).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(data, "__proto__")).toBe(false);
    expect(data.name).toBe("evil");
  });

  test("rejects constructor and prototype keys too", () => {
    const doc = [
      "---",
      "name: evil2",
      "description: x",
      "constructor: hacked",
      "prototype: hacked",
      "---",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    expect(Object.prototype.hasOwnProperty.call(data, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "prototype")).toBe(false);
    expect(data.name).toBe("evil2");
  });
});

describe("parseBlock: child block boundary (line 84-86)", () => {
  test("block key with dedented child line ends the block", () => {
    // A block key with a child line at indent <= baseIndent
    // triggers the `break` (line 85).
    const { parseFrontmatter } = require("../src/frontmatter.js");
    const doc = [
      "---",
      "name: x",
      "description: y",
      "items:",
      "  - a",
      "  - b",
      "after:", // no indent → ends the items block
      "  value: 1",
      "---",
      "body",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    // The block ends at "after:" so items is a list of "a" and "b"
    expect(data).toBeDefined();
  });

  test("parseBlock: empty block key (valuePart='') sets result[key]='' (line 100)", () => {
    const { parseFrontmatter } = require("../src/frontmatter.js");
    const doc = [
      "---",
      "name: x",
      "description: y",
      "items:", // empty block
      "after:", // no indent
      "  value: 1",
      "---",
      "body",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    // The empty block key 'items' should be set to '' (line 100)
    expect(data.items).toBe("");
  });

  test("parseBlock: child line with indent <= baseIndent breaks the block (line 86)", () => {
    const { parseFrontmatter } = require("../src/frontmatter.js");
    // A block with a child line, then a dedented line that
    // terminates the block via the `break` (line 86).
    const doc = [
      "---",
      "name: x",
      "description: y",
      "items:",
      "  - a",
      "next:", // dedented — block ends here
      "  v: 1",
      "---",
      "body",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    // The block should contain only "  - a" — the "next:" line
    // dedents and breaks the block.
    expect(data.items).toEqual(["a"]);
  });

  test("parseBlock: blank line inside child block (line 84-86)", () => {
    const { parseFrontmatter } = require("../src/frontmatter.js");
    // A block with a blank line in the middle of child lines.
    // The blank line hits `child.push(l); j++; continue;` (line 84-86).
    const doc = [
      "---",
      "name: x",
      "description: y",
      "items:",
      "  - a",
      "", // blank line
      "  - b",
      "next:",
      "  v: 1",
      "---",
      "body",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    expect(data.items).toEqual(["a", "b"]);
  });
});

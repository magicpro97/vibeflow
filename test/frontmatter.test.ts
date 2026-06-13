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

  test("preserves blank lines inside a child block", () => {
    const doc = [
      "---",
      "parent:",
      "  child: a",
      "",
      "  other: b",
      "---",
      "body",
    ].join("\n");
    const { data, body } = parseFrontmatter(doc);
    // Blank line inside the indented child block must be preserved in
    // iteration (the parser continues past it) so subsequent siblings parse.
    expect(data.parent).toEqual({ child: "a", other: "b" });
    expect(body).toBe("body");
  });

  test("an empty child block resolves to an empty string", () => {
    const doc = ["---", "parent:", "---", "body"].join("\n");
    const { data, body } = parseFrontmatter(doc);
    expect(data.parent).toBe("");
    expect(body).toBe("body");
  });

  test("forbidden keys with inline list values are also dropped", () => {
    const doc = [
      "---",
      "name: evil-list",
      "__proto__: [a, b, c]",
      "---",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    expect(Object.prototype.hasOwnProperty.call(data, "__proto__")).toBe(false);
    expect(data.name).toBe("evil-list");
  });

  test("forbidden keys with scalar values are also dropped", () => {
    // Use `prototype` (also in FORBIDDEN_KEYS) as a non-block scalar.
    const doc = [
      "---",
      "name: evil-scalar",
      "prototype: nope",
      "---",
    ].join("\n");
    const { data } = parseFrontmatter(doc);
    expect(Object.prototype.hasOwnProperty.call(data, "prototype")).toBe(false);
    expect(data.name).toBe("evil-scalar");
  });
});

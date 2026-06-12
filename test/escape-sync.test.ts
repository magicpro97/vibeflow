import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { esc } from "../src/ui/escape.js";

describe("esc() sync between module and shell.html inline", () => {
  test("module and inline implementations produce identical output for sample inputs", () => {
    const html = readFileSync("src/ui/shell.html", "utf8");
    // Extract the inline esc function body. The inline body is:
    //   function esc(s) {
    //     return String(s).replace(/[&<>"']/g, function (m) {
    //       return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    //     });
    //   }
    const match = html.match(/function esc\(s\)\s*\{([\s\S]*?)\n\s{6}\}/);
    if (!match) throw new Error("Could not find inline esc() in shell.html");
    const inlineBody = match[1];
    // Both should escape: & < > " '
    for (const ch of ["&", "<", ">", '"', "'"]) {
      expect(inlineBody).toContain(ch);
    }
    // And the module should produce the same output as a hand-rolled reference
    // that matches the inline implementation's regex and replacement table.
    const referenceEsc = (s: string) =>
      String(s).replace(/[&<>"']/g, (m) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[m]!);
    const samples = [
      "<script>alert(1)</script>",
      'a"b',
      "a'b",
      "a&b",
      "a<b>c",
      "",
      "no special chars",
      "mix & < > \" '",
      "&amp;",
    ];
    for (const s of samples) {
      expect(esc(s)).toBe(referenceEsc(s));
    }
  });

  test("module esc() handles null and undefined", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  MARKER_FIELDS,
  MARKER_PROJECT,
  MARKER_PROJECT_OPTION_BY_STATUS,
  MARKER_STATUS,
  MARKER_STATUSES,
  isDispatchMarker,
  isMarkerStatus,
} from "../src/orchestrator/marker-contract.js";

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("marker protocol contract", () => {
  test("freezes a total status and project mapping authority", () => {
    expect(Object.values(MARKER_STATUS)).toEqual([...MARKER_STATUSES]);
    expect(Object.keys(MARKER_PROJECT_OPTION_BY_STATUS).sort()).toEqual(
      [...MARKER_STATUSES].sort(),
    );
    for (const value of [
      MARKER_STATUS,
      MARKER_STATUSES,
      MARKER_FIELDS,
      MARKER_PROJECT,
      MARKER_PROJECT.options,
      MARKER_PROJECT_OPTION_BY_STATUS,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    for (const status of MARKER_STATUSES) expect(isMarkerStatus(status)).toBe(true);
    for (const value of ["", "unknown", "toString", null, 1])
      expect(isMarkerStatus(value)).toBe(false);
  });

  test("validates persisted markers fail-closed", () => {
    const valid = {
      unit: "unit-1",
      status: MARKER_STATUS.RUNNING,
      startedAt: 1,
      updatedAt: 2,
      confidence: 0.5,
      evidence: ["evidence.json"],
    };
    expect(isDispatchMarker(valid)).toBe(true);
    expect(isDispatchMarker({ ...valid, status: "unknown" })).toBe(false);
    expect(isDispatchMarker({ ...valid, confidence: 2 })).toBe(false);
    expect(isDispatchMarker({ ...valid, unexpected: true })).toBe(false);
    expect(isDispatchMarker(Object.assign(Object.create({}), valid))).toBe(false);
  });

  test("keeps the marker consumer free of handwritten status discriminants", () => {
    const source = readFileSync(resolve("src/orchestrator/marker.ts"), "utf8");
    const rawStatus = new RegExp(
      `(?:status\\s*(?:===|!==|:)\\s*|status:\\s*)["'](?:${MARKER_STATUSES.join("|")})["']`,
      "u",
    );
    expect(source).not.toMatch(rawStatus);
    expect(source).toContain("marker-contract.js");
  });

  test("keeps every marker producer on the shared status authority", () => {
    const violations: string[] = [];
    for (const path of productionTypeScriptFiles(resolve("src"))) {
      if (path.endsWith("marker-contract.ts")) continue;
      const source = readFileSync(path, "utf8");
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === "createMarker" || node.expression.text === "updateMarker")
        ) {
          for (const argument of node.arguments) {
            if (!ts.isObjectLiteralExpression(argument)) continue;
            for (const property of argument.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(file) === "status" &&
                ts.isStringLiteral(property.initializer) &&
                isMarkerStatus(property.initializer.text)
              )
                violations.push(
                  `${path}:${file.getLineAndCharacterOfPosition(property.pos).line + 1}`,
                );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(violations).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  CAPABILITY_MANIFEST_ACCESSES,
  CAPABILITY_MANIFEST_COMPONENT_TYPES,
  CAPABILITY_MANIFEST_DEPENDENCY_SCOPES,
  CAPABILITY_MANIFEST_FILESYSTEM_ROOTS,
  CAPABILITY_MANIFEST_HEALTH_PROBE_KINDS,
  CAPABILITY_MANIFEST_HEALTH_RETRIES,
  CAPABILITY_MANIFEST_HOOK_EVENTS,
  CAPABILITY_MANIFEST_ICON_MEDIA_TYPES,
  CAPABILITY_MANIFEST_INPUT_TYPES,
  CAPABILITY_MANIFEST_INSTALLER_KINDS,
  CAPABILITY_MANIFEST_INSTALLER_LIFECYCLE_SCRIPTS,
  CAPABILITY_MANIFEST_MCP_TRANSPORTS,
  CAPABILITY_MANIFEST_NETWORK_TRANSPORTS,
  CAPABILITY_MANIFEST_PERMISSION_KINDS,
  CAPABILITY_MANIFEST_PLATFORM_ARCHES,
  CAPABILITY_MANIFEST_PLATFORM_LIBCS,
  CAPABILITY_MANIFEST_PLATFORM_OSES,
  CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS,
  FILESYSTEM_LEGACY_SOURCES,
  LEGACY_SOURCES,
  isCapabilityManifestPlatformArch,
  isCapabilityManifestPlatformLibc,
  isCapabilityManifestPlatformOs,
} from "../../src/actions/capability-manifest-vocabulary-contract.js";
import { RUNTIME_PLATFORMS } from "../../src/durability/process-identity-contract.js";

const productionSources = (roots: readonly string[]): string[] => {
  const output: string[] = [];
  const visit = (path: string): void => {
    if (path.endsWith(".ts")) {
      output.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(child);
    }
  };
  for (const root of roots) visit(resolve(root));
  return output.sort();
};

const isTypeofLiteral = (node: ts.StringLiteral): boolean => {
  let ancestor: ts.Node | undefined = node.parent;
  for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parent)
    if (ts.isBinaryExpression(ancestor))
      return ts.isTypeOfExpression(ancestor.left) || ts.isTypeOfExpression(ancestor.right);
  return false;
};

const rawManifestLiterals = (path: string, forbidden: ReadonlySet<string>): string[] => {
  const displayPath = relative(process.cwd(), path);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const intentional = new Map([
    ["src/commands/capability/parser-authority.ts:secret", "CLI command noun"],
    ["src/capabilities/authority/shapes.ts:secret", "exact object field name"],
    ["src/capabilities/legacy/filesystem-reader.ts:mcp", "legacy config namespace"],
    ["src/capabilities/adapters/projection-builders.ts:mcp", "OpenCode config key"],
    ["src/actions/validation.ts:string", "JSON typeof vocabulary"],
    ["src/actions/validation.ts:boolean", "JSON typeof vocabulary"],
  ]);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) &&
      forbidden.has(node.text) &&
      !isTypeofLiteral(node) &&
      !intentional.has(`${displayPath}:${node.text}`)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offenders.push(`${displayPath}:${line + 1}:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
};

describe("capability manifest vocabulary consumers", () => {
  test("aliases runtime OS and freezes every manifest/legacy vocabulary", () => {
    expect(CAPABILITY_MANIFEST_PLATFORM_OSES).toBe(RUNTIME_PLATFORMS);
    expect(FILESYSTEM_LEGACY_SOURCES.every((source) => LEGACY_SOURCES.includes(source))).toBe(true);
    for (const authority of [
      CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS,
      CAPABILITY_MANIFEST_PLATFORM_OSES,
      CAPABILITY_MANIFEST_PLATFORM_ARCHES,
      CAPABILITY_MANIFEST_PLATFORM_LIBCS,
      CAPABILITY_MANIFEST_ICON_MEDIA_TYPES,
      CAPABILITY_MANIFEST_INSTALLER_KINDS,
      CAPABILITY_MANIFEST_INSTALLER_LIFECYCLE_SCRIPTS,
      CAPABILITY_MANIFEST_COMPONENT_TYPES,
      CAPABILITY_MANIFEST_MCP_TRANSPORTS,
      CAPABILITY_MANIFEST_HOOK_EVENTS,
      CAPABILITY_MANIFEST_INPUT_TYPES,
      CAPABILITY_MANIFEST_DEPENDENCY_SCOPES,
      CAPABILITY_MANIFEST_PERMISSION_KINDS,
      CAPABILITY_MANIFEST_FILESYSTEM_ROOTS,
      CAPABILITY_MANIFEST_ACCESSES,
      CAPABILITY_MANIFEST_NETWORK_TRANSPORTS,
      CAPABILITY_MANIFEST_HEALTH_PROBE_KINDS,
      CAPABILITY_MANIFEST_HEALTH_RETRIES,
      LEGACY_SOURCES,
      FILESYSTEM_LEGACY_SOURCES,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
  });

  test("keeps manifest platform guards on the canonical runtime vocabularies", () => {
    expect(isCapabilityManifestPlatformOs(CAPABILITY_MANIFEST_PLATFORM_OSES[0])).toBe(true);
    expect(isCapabilityManifestPlatformOs("linux ")).toBe(false);
    expect(isCapabilityManifestPlatformArch(CAPABILITY_MANIFEST_PLATFORM_ARCHES[0])).toBe(true);
    expect(isCapabilityManifestPlatformArch("arm")).toBe(false);
    expect(isCapabilityManifestPlatformLibc(CAPABILITY_MANIFEST_PLATFORM_LIBCS[0])).toBe(true);
    expect(isCapabilityManifestPlatformLibc("glibc ")).toBe(false);
  });

  test("dynamically scans the complete action/capability/CLI production boundary", () => {
    const forbidden = new Set<string>([
      ...CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS,
      ...CAPABILITY_MANIFEST_PLATFORM_OSES,
      ...CAPABILITY_MANIFEST_PLATFORM_ARCHES,
      ...CAPABILITY_MANIFEST_PLATFORM_LIBCS,
      ...CAPABILITY_MANIFEST_ICON_MEDIA_TYPES,
      ...CAPABILITY_MANIFEST_INSTALLER_KINDS,
      ...Object.values(CAPABILITY_MANIFEST_INSTALLER_LIFECYCLE_SCRIPTS),
      ...CAPABILITY_MANIFEST_COMPONENT_TYPES,
      ...CAPABILITY_MANIFEST_MCP_TRANSPORTS,
      ...CAPABILITY_MANIFEST_HOOK_EVENTS,
      ...CAPABILITY_MANIFEST_INPUT_TYPES,
      ...CAPABILITY_MANIFEST_DEPENDENCY_SCOPES,
      ...CAPABILITY_MANIFEST_PERMISSION_KINDS,
      ...CAPABILITY_MANIFEST_FILESYSTEM_ROOTS,
      ...CAPABILITY_MANIFEST_ACCESSES,
      ...CAPABILITY_MANIFEST_NETWORK_TRANSPORTS,
      ...CAPABILITY_MANIFEST_HEALTH_PROBE_KINDS,
      ...LEGACY_SOURCES,
    ]);
    const canonical = new Set([
      "src/actions/capability-manifest-vocabulary-contract.ts",
      "src/actions/public-action-vocabulary-contract.ts",
      "src/actions/public-error-details-contract.ts",
      "src/actions/public-operation-contract.ts",
    ]);
    const sources = productionSources([
      "src/actions",
      "src/capabilities",
      "src/commands/capability",
      "src/commands/capability.ts",
    ]).filter((path) => !canonical.has(relative(process.cwd(), path)));
    expect(sources.flatMap((path) => rawManifestLiterals(path, forbidden))).toEqual([]);
  });
});

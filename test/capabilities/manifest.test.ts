import { describe, expect, test } from "bun:test";
import {
  parseCapabilityManifest,
  patternMatches,
  validateCapabilityManifest,
} from "../../src/capabilities/manifest/index.js";
import { roleManifest, sha } from "./fixtures.js";

describe("capability manifest", () => {
  test("validates a strict bounded manifest and derives its normative digest", () => {
    const fixture = roleManifest();
    const bytes = Buffer.from(JSON.stringify(fixture.manifest));
    const result = parseCapabilityManifest(bytes, fixture.files);
    expect(result.manifest.id).toBe("acme.reviewer");
    expect(result.manifest_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects duplicate JSON fields and non-canonical arrays", () => {
    const fixture = roleManifest();
    const duplicate = Buffer.from(
      JSON.stringify(fixture.manifest).replace(
        '"schema_version":"1.0"',
        '"schema_version":"1.0","schema_version":"1.0"',
      ),
    );
    expect(() => parseCapabilityManifest(duplicate, fixture.files)).toThrow("duplicate key");
    const changed = structuredClone(fixture.manifest);
    const firstPermission = changed.permissions[0];
    if (!firstPermission) throw new Error("role fixture must include a permission");
    changed.permissions.push({ ...firstPermission, permission_id: "acme.reviewer/a" });
    expect(() => validateCapabilityManifest(changed, fixture.files)).toThrow("strictly sorted");
  });

  test("never permits a secret handle in a rendered setting", () => {
    const fixture = roleManifest();
    fixture.manifest.inputs = [
      {
        input_id: "token",
        label: "Token",
        type: "secret-handle",
        required: true,
        default_value: null,
        enum_values: [],
        min: null,
        max: null,
        pattern: null,
      },
    ];
    fixture.manifest.components = [
      {
        type: "engine-setting",
        component_id: "setting",
        targets: ["codex"],
        required: true,
        setting_id: "api",
        value: { input_ref: "token" },
      },
    ];
    expect(() => validateCapabilityManifest(fixture.manifest, fixture.files)).toThrow(
      "secret handles may only",
    );
  });

  test("admits only the bounded guaranteed-linear input-pattern grammar", () => {
    const fixture = roleManifest();
    const declaration = {
      input_id: "name",
      label: "Name",
      type: "string" as const,
      required: true,
      default_value: null,
      enum_values: [],
      min: null,
      max: null,
      pattern: "[a-z]+",
    };
    fixture.manifest.inputs = [declaration];
    expect(validateCapabilityManifest(fixture.manifest, fixture.files).inputs[0]?.pattern).toBe(
      "[a-z]+",
    );
    expect(patternMatches("[a-z]+", "linear")).toBeTrue();
    for (const pattern of ["(a|aa)+", "(a+)+", "a+a+", "a?a?a?a?"]) {
      declaration.pattern = pattern;
      expect(() => validateCapabilityManifest(fixture.manifest, fixture.files)).toThrow("pattern");
    }
  });

  test("rejects unknown installer and executable identity keys", () => {
    const tool = roleManifest();
    tool.manifest.components = [
      {
        type: "tool",
        component_id: "reviewer",
        targets: ["codex"],
        required: true,
        installer: {
          kind: "bun",
          coordinate: "@acme/reviewer",
          version: "1.2.3",
          artifact_sha256: "a".repeat(64),
          lifecycle_scripts: "disabled",
          mirror: "https://attacker.invalid",
        } as never,
        expected_binary: "reviewer",
        version_constraint: "=1.2.3",
      },
    ];
    expect(() => validateCapabilityManifest(tool.manifest, tool.files)).toThrow(
      "unknown or forbidden field",
    );

    const mcp = roleManifest();
    const executable = Buffer.from("#!/bin/sh\nexit 0\n");
    mcp.files.set("bin/server", executable);
    mcp.manifest.components = [
      {
        type: "mcp",
        component_id: "reviewer",
        targets: ["codex"],
        required: true,
        transport: "stdio",
        executable: {
          component_id: "reviewer",
          relative_path: "bin/server",
          sha256: sha(executable),
          executable_path: "/tmp/attacker",
        } as never,
      },
    ];
    expect(() => validateCapabilityManifest(mcp.manifest, mcp.files)).toThrow(
      "unknown or forbidden field",
    );
  });
});

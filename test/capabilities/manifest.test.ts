import { describe, expect, test } from "bun:test";
import {
  parseCapabilityManifest,
  validateCapabilityManifest,
} from "../../src/capabilities/manifest/index.js";
import { roleManifest } from "./fixtures.js";

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
});

import { describe, expect, test } from "bun:test";
import { validateComponent } from "../../src/capabilities/manifest/component-validation.js";
import type {
  CapabilityInputDeclarationV1,
  CapabilityManifestV1,
} from "../../src/capabilities/manifest/index.js";
import {
  assertValidatedCapabilityManifest,
  collectInputRefs,
  parseCapabilityManifest,
  patternMatches,
  validateCapabilityManifest,
  validateInputDeclaration,
  verifyFile,
} from "../../src/capabilities/manifest/index.js";
import { roleManifest, sha } from "./fixtures.js";

function input(
  type: CapabilityInputDeclarationV1["type"],
  overrides: Partial<CapabilityInputDeclarationV1> = {},
): CapabilityInputDeclarationV1 {
  return {
    input_id: "input",
    label: "Input",
    type,
    required: false,
    default_value: null,
    enum_values: [],
    min: null,
    max: null,
    pattern: null,
    ...overrides,
  };
}

function invalid(
  mutate: (manifest: CapabilityManifestV1, files: Map<string, Uint8Array>) => void,
  message: string,
): void {
  const fixture = roleManifest();
  mutate(fixture.manifest, fixture.files);
  expect(() => validateCapabilityManifest(fixture.manifest, fixture.files)).toThrow(message);
}

describe("capability manifest behavioral coverage", () => {
  test("accepts safe icons and canonical platform, dependency, conflict, and health records", () => {
    for (const [mediaType, bytes] of [
      [
        "image/png",
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(16),
        ]),
      ],
      ["image/webp", Buffer.from("RIFF0000WEBP0000")],
    ] as const) {
      const fixture = roleManifest();
      fixture.files.set("icon.bin", bytes);
      fixture.manifest.metadata = {
        ...fixture.manifest.metadata,
        homepage_url: "https://example.com/",
        documentation_url: "https://example.com/docs",
        icon: { relative_path: "icon.bin", sha256: sha(bytes), media_type: mediaType },
      };
      fixture.manifest.compatibility.platforms = [
        { os: "darwin", arch: "arm64", libc: null },
        { os: "linux", arch: "x64", libc: "glibc" },
      ];
      fixture.manifest.dependencies = [
        { package_id: "acme.base", version_range: "^1.0.0", required_scope: "same" },
        {
          package_id: "acme.user-base",
          version_range: "^1.0.0",
          required_scope: "user-prerequisite",
        },
      ];
      fixture.manifest.conflicts = [
        { package_id: "acme.legacy", version_range: null, reason: "superseded" },
        { package_id: "acme.old", version_range: "^0.1.0", reason: "obsolete" },
      ];
      fixture.manifest.health = [
        {
          probe_id: "role-parse",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 1_000,
          retries: 2,
        },
      ];
      expect(
        validateCapabilityManifest(fixture.manifest, fixture.files).metadata.icon,
      ).not.toBeNull();
    }
  });

  test("rejects unsafe metadata and invalid platform tuples", () => {
    invalid((manifest, files) => {
      const bytes = Buffer.alloc(24);
      files.set("icon.png", bytes);
      manifest.metadata.icon = {
        relative_path: "icon.png",
        sha256: sha(bytes),
        media_type: "image/png",
      };
    }, "safe media type");
    invalid((manifest) => {
      manifest.metadata.homepage_url = "http://example.com";
    }, "protocol is not allowed");
    invalid((manifest) => {
      manifest.compatibility.platforms = [];
    }, "platform list");
    invalid((manifest) => {
      manifest.compatibility.platforms = [{ os: "android" as never, arch: "arm64", libc: null }];
    }, "unsupported platform");
    invalid((manifest) => {
      manifest.compatibility.platforms = [{ os: "darwin", arch: "arm64", libc: "musl" }];
    }, "libc is invalid");
    invalid((manifest) => {
      manifest.compatibility.platforms = [
        { os: "linux", arch: "x64", libc: null },
        { os: "linux", arch: "x64", libc: null },
      ];
    }, "strictly sorted");
  });

  test("rejects invalid dependency, conflict, compatibility, and health authority", () => {
    invalid((manifest) => {
      manifest.dependencies = [
        { package_id: manifest.id, version_range: "^1.0.0", required_scope: "same" },
      ];
    }, "self dependency");
    invalid((manifest) => {
      manifest.dependencies = [
        {
          package_id: "acme.base",
          version_range: "^1.0.0",
          required_scope: "global" as never,
        },
      ];
    }, "invalid dependency scope");
    invalid((manifest) => {
      manifest.conflicts = [{ package_id: "acme.legacy", version_range: null, reason: "" }];
    }, "byte length is out of bounds");
    invalid((manifest) => {
      manifest.compatibility.engines = {};
    }, "exactly cover");
    invalid((manifest) => {
      manifest.health = [
        {
          probe_id: "probe",
          component_ids: [],
          kind: "role-parse",
          required: true,
          timeout_ms: 1,
          retries: 0,
        },
      ];
    }, "component set is empty");
    invalid((manifest) => {
      manifest.health = [
        {
          probe_id: "probe",
          component_ids: ["missing"],
          kind: "role-parse",
          required: true,
          timeout_ms: 1,
          retries: 0,
        },
      ];
    }, "unknown component");
    invalid((manifest) => {
      manifest.health = [
        {
          probe_id: "probe",
          component_ids: ["reviewer"],
          kind: "network" as never,
          required: true,
          timeout_ms: 1,
          retries: 0,
        },
      ];
    }, "unknown health probe");
    invalid((manifest) => {
      manifest.health = [
        {
          probe_id: "probe",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 1,
          retries: 3 as never,
        },
      ];
    }, "invalid health");
  });

  test("validates every public input kind and its semantic constraints", () => {
    const valid = [
      input("string", { default_value: "abc", pattern: "[a-z]{3}" }),
      input("boolean", { default_value: true }),
      input("integer", { default_value: 2, min: 1, max: 3 }),
      input("enum", { default_value: "a", enum_values: ["a", "b"] }),
      input("project-path", { default_value: "src" }),
      input("secret-handle", { required: true }),
    ];
    for (const [index, declaration] of valid.entries())
      expect(() => validateInputDeclaration(declaration, `input[${index}]`)).not.toThrow();

    for (const [declaration, message] of [
      [input("string", { default_value: false }), "string default"],
      [input("string", { default_value: "123", pattern: "[a-z]+" }), "fails its pattern"],
      [input("boolean", { pattern: "true" }), "boolean input"],
      [input("integer", { default_value: 1.5 }), "integer input"],
      [input("integer", { default_value: 4, min: 1, max: 3 }), "outside bounds"],
      [input("enum"), "enum input"],
      [input("enum", { default_value: "c", enum_values: ["a", "b"] }), "not declared"],
      [input("project-path", { default_value: "../escape" }), "relative"],
      [input("secret-handle", { default_value: "secret" }), "secret input"],
      [input("string", { min: 1 }), "irrelevant input"],
      [input("integer", { min: 2, max: 1 }), "min exceeds max"],
    ] as const) {
      expect(() => validateInputDeclaration(declaration, "input")).toThrow(message);
    }
  });

  test("validates each component adapter and rejects unsafe transport combinations", () => {
    const bundle = Buffer.from("skill");
    const executable = Buffer.from("#!/bin/sh\n");
    const files = new Map<string, Uint8Array>([
      ["skill", bundle],
      ["server", executable],
    ]);
    const inputs = new Map<string, CapabilityInputDeclarationV1>([
      ["name", input("string", { input_id: "name" })],
      ["token", input("secret-handle", { input_id: "token" })],
    ]);
    const refs: Array<{ id: string; path: string }> = [];
    const components: CapabilityManifestV1["components"] = [
      {
        type: "skill",
        component_id: "skill",
        targets: ["codex"],
        required: true,
        bundle_path: "skill",
        bundle_sha256: sha(bundle),
      },
      {
        type: "hook",
        component_id: "hook",
        targets: ["codex"],
        required: true,
        event: "pre-tool",
        vf_handler_id: "handler",
      },
      {
        type: "tool",
        component_id: "tool",
        targets: ["codex"],
        required: true,
        installer: {
          kind: "bun",
          coordinate: "@acme/tool",
          version: "1.0.0",
          artifact_sha256: "a".repeat(64),
          lifecycle_scripts: "disabled",
        },
        expected_binary: "tool",
        version_constraint: "^1.0.0",
      },
      {
        type: "engine-setting",
        component_id: "setting",
        targets: ["codex"],
        required: true,
        setting_id: "setting",
        value: { input_ref: "name" },
      },
      {
        type: "mcp",
        component_id: "stdio",
        targets: ["codex"],
        required: true,
        transport: "stdio",
        executable: { component_id: "server", relative_path: "server", sha256: sha(executable) },
        args: ["--name", { input_ref: "name" }],
        secret_slots: ["token"],
      },
      {
        type: "mcp",
        component_id: "remote",
        targets: ["codex"],
        required: true,
        transport: "http",
        url: "https://example.com/mcp",
      },
      {
        type: "mcp",
        component_id: "invalid-remote",
        targets: ["codex"],
        required: true,
        transport: "https" as never,
        url: "https://example.com/mcp",
      },
    ];
    for (const [index, component] of components.slice(0, -1).entries())
      expect(() =>
        validateComponent(component, `component[${index}]`, files, inputs, refs),
      ).not.toThrow();
    expect(refs).toEqual([
      { id: "name", path: "component[3].value" },
      { id: "name", path: "component[4].args[1]" },
    ]);

    const assertInvalid = (
      component: CapabilityManifestV1["components"][number],
      message: string,
    ) =>
      expect(() => validateComponent(component, "component", files, inputs, [])).toThrow(message);
    assertInvalid({ ...components[0], targets: [] } as never, "targets are out of bounds");
    assertInvalid({ ...components[0], targets: ["unknown"] } as never, "unknown engine");
    assertInvalid({ ...components[0], required: "yes" } as never, "required must be boolean");
    assertInvalid({ ...components[1], event: "during-tool" } as never, "invalid hook event");
    const tool = components[2];
    if (tool?.type !== "tool") throw new Error("tool fixture missing");
    assertInvalid(
      { ...tool, installer: { ...tool.installer, lifecycle_scripts: "enabled" } } as never,
      "unsupported installer",
    );
    const stdio = components[4];
    if (stdio?.type !== "mcp") throw new Error("stdio fixture missing");
    assertInvalid({ ...stdio, secret_slots: ["name"] }, "secret-handle input");
    assertInvalid({ ...stdio, executable: undefined }, "requires executable");
    assertInvalid({ ...stdio, url: "https://example.com" }, "forbids URL");
    assertInvalid(
      {
        ...stdio,
        transport: "http",
        executable: undefined,
        args: undefined,
        url: undefined,
      },
      "remote MCP requires URL",
    );
    assertInvalid(
      {
        ...stdio,
        transport: "sse",
        executable: undefined,
        args: undefined,
        url: "http://example.com",
      },
      "protocol is not allowed",
    );
    assertInvalid(components.at(-1) as never, "invalid MCP transport");
    assertInvalid({ ...components[0], type: "unknown" } as never, "unknown component type");
  });

  test("enforces bounded linear patterns and template traversal", () => {
    expect(patternMatches("[a-z]{2,4}", "abc")).toBeTrue();
    expect(patternMatches("a\\+b", "a+b")).toBeTrue();
    for (const pattern of [
      "a{257}",
      "a{4,2}",
      "[abc",
      "a|b",
      "(?=a)",
      "(ab)+",
      "*a",
      "a+?",
      "(",
      ")",
      "\\1",
      "\\u{110000}",
    ])
      expect(() => patternMatches(pattern, "a")).toThrow("pattern");
    expect(() => patternMatches("a", "x".repeat(8_193))).toThrow("byte limit");

    const refs: Array<{ id: string; path: string }> = [];
    collectInputRefs({ nested: [null, true, 1, "text", { input_ref: "token" }] }, "value", refs);
    expect(refs).toEqual([{ id: "token", path: "value.nested[4]" }]);
    expect(() => collectInputRefs(Symbol("invalid") as never, "value", [])).toThrow(
      "invalid template",
    );
    expect(() => collectInputRefs({ constructor: "blocked" }, "value", [])).toThrow(
      "forbidden template key",
    );
    expect(() => collectInputRefs("x".repeat(8_193), "value", [])).toThrow("out of bounds");
    expect(() => collectInputRefs(null, "value", [], 33)).toThrow("nesting exceeds");
    expect(() => collectInputRefs(new Array(1_025).fill(null), "value", [])).toThrow(
      "array exceeds",
    );
    const huge = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`k${index}`, null]),
    );
    expect(() => collectInputRefs(huge, "value", [])).toThrow("object exceeds");
  });

  test("validates file integrity and parser provenance", () => {
    const bytes = Buffer.from("safe");
    expect(verifyFile(new Map([["safe", bytes]]), "safe", sha(bytes), "file")).toEqual(bytes);
    expect(() => verifyFile(new Map(), "missing", sha(bytes), "file")).toThrow("missing");
    expect(() => verifyFile(new Map([["large", bytes]]), "large", sha(bytes), "file", 1)).toThrow(
      "byte limit",
    );
    expect(() => verifyFile(new Map([["safe", bytes]]), "safe", "0".repeat(64), "file")).toThrow(
      "hash mismatch",
    );

    const fixture = roleManifest();
    const parsed = parseCapabilityManifest(
      Buffer.from(JSON.stringify(fixture.manifest)),
      fixture.files,
    );
    expect(assertValidatedCapabilityManifest(parsed)).toBe(parsed);
    expect(() => assertValidatedCapabilityManifest(structuredClone(parsed))).toThrow(
      "not parser-validated",
    );
    expect(() => parseCapabilityManifest(new Uint8Array(), fixture.files)).toThrow("byte size");
    expect(() => parseCapabilityManifest(Uint8Array.from([0xff]), fixture.files)).toThrow(
      "strict UTF-8",
    );
    expect(() =>
      parseCapabilityManifest(
        Buffer.from(`\uFEFF${JSON.stringify(fixture.manifest)}`),
        fixture.files,
      ),
    ).toThrow("BOM");
  });

  test("rejects invalid schema, collection bounds, and undeclared template inputs", () => {
    invalid((manifest) => {
      manifest.schema_version = "2.0" as never;
    }, "unsupported manifest schema");
    invalid((manifest) => {
      manifest.components = [];
    }, "collection exceeds bounds");
    invalid((manifest) => {
      manifest.components = [
        {
          type: "engine-setting",
          component_id: "setting",
          targets: ["codex"],
          required: true,
          setting_id: "theme",
          value: { input_ref: "missing" },
        },
      ];
    }, "undeclared input");
  });
});

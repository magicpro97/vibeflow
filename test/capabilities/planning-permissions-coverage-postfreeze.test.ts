import { describe, expect, test } from "bun:test";
import type { CapabilityPublicInputV1 } from "../../src/actions/request-types.js";
import type {
  CapabilityInputDeclarationV1,
  CapabilityPermissionKindScopeV1,
} from "../../src/capabilities/manifest/types.js";
import {
  canonicalPermissionBinding,
  canonicalPermissionUnion,
  permissionBindingDigest,
  permissionContains,
  permissionRowSortKey,
  permissionTargetSetDigest,
  permissionUnionContains,
} from "../../src/capabilities/permissions/containment.js";
import { permissionDelta } from "../../src/capabilities/permissions/delta.js";
import {
  assertPermissionMatchesOperationScope,
  canonicalHost,
  canonicalRelativePrefix,
  canonicalUrlPathPrefix,
  permissionScopeDigest,
  publicPermissionScope,
  validateManifestPermission,
  validatePermissionKindScope,
} from "../../src/capabilities/permissions/scope.js";
import type {
  PermissionBindingRowV1,
  PermissionBindingV1,
} from "../../src/capabilities/permissions/types.js";
import {
  type CapabilityPrivateInputAuthorityV1,
  UnavailableCapabilityPrivateInputAuthorityV1,
  materializeCurrentPackageInputs,
  materializePackageInputs,
  materializePatchedPackageInputs,
} from "../../src/capabilities/planning/input-materializer.js";
import type { ResolvedCapabilityPackageV1 } from "../../src/capabilities/planning/types.js";
import { digestV1 } from "../../src/durability/index.js";
import { resolvedRolePackage, runtimeDigest } from "./runtime-fixtures.js";

const declaration = (
  input_id: string,
  type: CapabilityInputDeclarationV1["type"],
  overrides: Partial<CapabilityInputDeclarationV1> = {},
): CapabilityInputDeclarationV1 => ({
  input_id,
  label: input_id,
  type,
  required: false,
  default_value: null,
  enum_values: [],
  min: null,
  max: null,
  pattern: null,
  ...overrides,
});

function packageWithInputs(inputs: CapabilityInputDeclarationV1[]): ResolvedCapabilityPackageV1 {
  return resolvedRolePackage((manifest) => {
    manifest.inputs = [...inputs].sort((a, b) => a.input_id.localeCompare(b.input_id));
  });
}

const privateReference = {
  private_input_binding_id: `vf-private-input-binding-${"1".repeat(64)}`,
  binding_digest: runtimeDigest("private-reference"),
};

function privateAuthority(overrides: Partial<CapabilityPrivateInputAuthorityV1> = {}) {
  const validated: string[] = [];
  const current: string[][] = [];
  const patches: Array<{ ids: string[]; patch: string }> = [];
  const authority: CapabilityPrivateInputAuthorityV1 = {
    validateReference(input) {
      validated.push(input.input_id);
    },
    resolveCurrentBinding(input) {
      current.push(input.input_ids);
      return runtimeDigest(`current:${input.input_ids.join(",")}`);
    },
    resolvePatchedBinding(input) {
      patches.push({
        ids: input.replacements.map((row) => row.input_id),
        patch: input.patch_digest,
      });
      return {
        binding_digest: runtimeDigest("patched-binding"),
        prior_binding_digest: input.current_binding_digest,
        patch_digest: input.patch_digest,
      };
    },
    ...overrides,
  };
  return { authority, current, patches, validated };
}

describe("Capability input materialization coverage", () => {
  test("materializes every public kind and one opaque secret in canonical order", () => {
    const pkg = packageWithInputs([
      declaration("count", "integer", { required: true, min: 1, max: 9 }),
      declaration("enabled", "boolean", { required: true }),
      declaration("mode", "enum", { enum_values: ["fast", "safe"], default_value: "safe" }),
      declaration("name", "string", { pattern: "[a-z]+", default_value: "alpha" }),
      declaration("path", "project-path", { required: true }),
      declaration("token", "secret-handle", { required: true }),
    ]);
    const broker = privateAuthority();
    const values: CapabilityPublicInputV1[] = [
      { input_id: "token", value: privateReference },
      { input_id: "path", value: "src/tools" },
      { input_id: "enabled", value: true },
      { input_id: "count", value: 4 },
      { input_id: "mode", value: "fast" },
      { input_id: "name", value: "beta" },
    ];
    const result = materializePackageInputs({
      pkg,
      values,
      scope: "project",
      scopeIdentityDigest: runtimeDigest("input-scope"),
      privateInputs: broker.authority,
    });
    expect(result.public_inputs.map((row) => row.input_id)).toEqual([
      "count",
      "enabled",
      "mode",
      "name",
      "path",
    ]);
    expect(result.secret_input_ids).toEqual(["token"]);
    expect(result.private_input_binding_digest).toBeTruthy();
    expect(broker.validated).toEqual(["token"]);
  });

  test("applies defaults and rejects every invalid public/private value class", () => {
    const defaults = packageWithInputs([
      declaration("mode", "enum", { enum_values: ["fast", "safe"], default_value: "safe" }),
      declaration("name", "string", { default_value: "alpha" }),
    ]);
    expect(
      materializePackageInputs({
        pkg: defaults,
        values: [],
        scope: "project",
        scopeIdentityDigest: runtimeDigest("defaults"),
        privateInputs: privateAuthority().authority,
      }).public_inputs,
    ).toEqual([
      { input_id: "mode", value: "safe" },
      { input_id: "name", value: "alpha" },
    ]);

    const cases: Array<[CapabilityInputDeclarationV1[], CapabilityPublicInputV1[], RegExp]> = [
      [[declaration("flag", "boolean")], [{ input_id: "flag", value: "yes" }], /boolean/],
      [[declaration("count", "integer")], [{ input_id: "count", value: 1.5 }], /integer/],
      [[declaration("count", "integer", { min: 2 })], [{ input_id: "count", value: 1 }], /minimum/],
      [[declaration("count", "integer", { max: 2 })], [{ input_id: "count", value: 3 }], /maximum/],
      [
        [declaration("mode", "enum", { enum_values: ["safe"] })],
        [{ input_id: "mode", value: "fast" }],
        /outside its enum/,
      ],
      [
        [declaration("name", "string", { pattern: "[a-z]+" })],
        [{ input_id: "name", value: "123" }],
        /pattern/,
      ],
      [
        [declaration("path", "project-path")],
        [{ input_id: "path", value: "/tmp" }],
        /bounded project path/,
      ],
      [
        [declaration("path", "project-path")],
        [{ input_id: "path", value: "src/../secret" }],
        /bounded project path/,
      ],
      [
        [declaration("token", "secret-handle")],
        [{ input_id: "token", value: "raw-secret" }],
        /opaque binding/,
      ],
      [
        [declaration("name", "string")],
        [{ input_id: "name", value: privateReference }],
        /cannot use a private binding/,
      ],
      [[declaration("required", "string", { required: true })], [], /required capability input/],
    ];
    for (const [inputs, values, error] of cases) {
      expect(() =>
        materializePackageInputs({
          pkg: packageWithInputs(inputs),
          values,
          scope: "project",
          scopeIdentityDigest: runtimeDigest("invalid-input"),
          privateInputs: privateAuthority().authority,
        }),
      ).toThrow(error);
    }

    const one = packageWithInputs([declaration("name", "string")]);
    for (const values of [
      [
        { input_id: "name", value: "a" },
        { input_id: "name", value: "b" },
      ],
      [{ input_id: "unknown", value: "a" }],
    ] satisfies CapabilityPublicInputV1[][]) {
      expect(() =>
        materializePackageInputs({
          pkg: one,
          values,
          scope: "project",
          scopeIdentityDigest: runtimeDigest("invalid-set"),
          privateInputs: privateAuthority().authority,
        }),
      ).toThrow();
    }
  });

  test("rehydrates current inputs and validates duplicates, declarations, and required rows", () => {
    const pkg = packageWithInputs([
      declaration("name", "string", { required: true }),
      declaration("token", "secret-handle", { required: true }),
    ]);
    const broker = privateAuthority();
    const current = materializeCurrentPackageInputs({
      pkg,
      publicInputs: [{ input_id: "name", value: "alpha" }],
      secretInputIds: ["token"],
      scope: "project",
      scopeIdentityDigest: runtimeDigest("current-scope"),
      privateInputs: broker.authority,
    });
    expect(current.secret_input_ids).toEqual(["token"]);
    expect(broker.current).toEqual([["token"]]);

    const invalid: Array<[ResolvedCapabilityPackageV1["public_inputs"], string[], RegExp]> = [
      [
        [
          { input_id: "name", value: "a" },
          { input_id: "name", value: "b" },
        ],
        ["token"],
        /duplicated/,
      ],
      [[{ input_id: "missing", value: "a" }], ["token"], /not declared/],
      [[{ input_id: "token", value: "a" }], ["token"], /not declared/],
      [[{ input_id: "name", value: "a" }], ["name"], /current secret input/],
      [[{ input_id: "name", value: "a" }], ["missing"], /current secret input/],
      [[], ["token"], /missing from current state/],
      [[{ input_id: "name", value: "a" }], [], /missing from current state/],
    ];
    for (const [publicInputs, secretInputIds, error] of invalid) {
      expect(() =>
        materializeCurrentPackageInputs({
          pkg,
          publicInputs,
          secretInputIds,
          scope: "project",
          scopeIdentityDigest: runtimeDigest("invalid-current"),
          privateInputs: privateAuthority().authority,
        }),
      ).toThrow(error);
    }
  });

  test("configures non-empty public/private patches and binds exact aggregation", () => {
    const base = packageWithInputs([
      declaration("name", "string"),
      declaration("token", "secret-handle"),
    ]);
    base.public_inputs = [{ input_id: "name", value: "old" }];
    base.secret_input_ids = [];
    base.private_input_binding_digest = runtimeDigest("prior-binding");
    const broker = privateAuthority();
    const configured = materializePatchedPackageInputs({
      pkg: base,
      values: [
        { input_id: "token", value: privateReference },
        { input_id: "name", value: "new" },
      ],
      scope: "project",
      scopeIdentityDigest: runtimeDigest("patch-scope"),
      privateInputs: broker.authority,
    });
    expect(configured.public_inputs).toEqual([{ input_id: "name", value: "new" }]);
    expect(configured.secret_input_ids).toEqual(["token"]);
    expect(configured.private_input_binding_digest).toBe(runtimeDigest("patched-binding"));
    expect(broker.patches[0]?.ids).toEqual(["token"]);

    for (const values of [
      [],
      [
        { input_id: "name", value: "a" },
        { input_id: "name", value: "b" },
      ],
      [{ input_id: "missing", value: "a" }],
      [{ input_id: "token", value: "raw" }],
      [{ input_id: "name", value: privateReference }],
    ] satisfies CapabilityPublicInputV1[][]) {
      expect(() =>
        materializePatchedPackageInputs({
          pkg: base,
          values,
          scope: "project",
          scopeIdentityDigest: runtimeDigest("invalid-patch"),
          privateInputs: privateAuthority().authority,
        }),
      ).toThrow();
    }

    for (const resolvePatchedBinding of [
      undefined,
      (
        input: Parameters<
          NonNullable<CapabilityPrivateInputAuthorityV1["resolvePatchedBinding"]>
        >[0],
      ) => ({
        binding_digest: runtimeDigest("wrong-prior"),
        prior_binding_digest: runtimeDigest("other"),
        patch_digest: input.patch_digest,
      }),
      (
        input: Parameters<
          NonNullable<CapabilityPrivateInputAuthorityV1["resolvePatchedBinding"]>
        >[0],
      ) => ({
        binding_digest: runtimeDigest("wrong-patch"),
        prior_binding_digest: input.current_binding_digest,
        patch_digest: runtimeDigest("other-patch"),
      }),
    ]) {
      expect(() =>
        materializePatchedPackageInputs({
          pkg: base,
          values: [{ input_id: "token", value: privateReference }],
          scope: "project",
          scopeIdentityDigest: runtimeDigest("unavailable-patch"),
          privateInputs: privateAuthority({ resolvePatchedBinding }).authority,
        }),
      ).toThrow(/aggregation is unavailable/);
    }
  });

  test("unavailable private authority permits only the exact empty binding", () => {
    const unavailable = new UnavailableCapabilityPrivateInputAuthorityV1();
    expect(unavailable.resolveCurrentBinding({ input_ids: [] }).startsWith("sha256:")).toBeTrue();
    expect(() => unavailable.resolveCurrentBinding({ input_ids: ["token"] })).toThrow(
      /credential broker/,
    );
    expect(() => unavailable.validateReference()).toThrow(/credential broker/);
  });
});

const permission = (
  kind: PermissionBindingRowV1["kind"],
  scope: PermissionBindingRowV1["scope"],
  overrides: Partial<PermissionBindingRowV1> = {},
): PermissionBindingRowV1 =>
  ({
    permission_id: `acme.pkg/${kind}`,
    kind,
    scope,
    target_ids: ["target-a"],
    enforcement: "sandboxed",
    ...overrides,
  }) as PermissionBindingRowV1;

describe("Capability permission scope and containment coverage", () => {
  test("validates canonical path, URL, host, manifest namespace, and operation scope", () => {
    expect(canonicalRelativePrefix("", "path")).toBe("");
    expect(canonicalRelativePrefix("src/tools", "path", false)).toBe("src/tools");
    for (const value of ["/src", "src/", "src\\x", "C:tmp", "src//x", "src/./x", "src/../x"])
      expect(() => canonicalRelativePrefix(value, "path")).toThrow();
    expect(() => canonicalRelativePrefix("", "path", false)).toThrow();

    expect(canonicalUrlPathPrefix("/v1/%2F", "url")).toBe("/v1/%2F");
    for (const value of ["v1", "/v1\\x", "/bad%2f", "/bad%ZZ", "/a/../b", "//["])
      expect(() => canonicalUrlPathPrefix(value, "url")).toThrow();
    expect(canonicalHost("api.example.com", "host")).toBe("api.example.com");
    for (const value of ["*.example.com", "example.com.", "UPPER.example", "bad host"])
      expect(() => canonicalHost(value, "host")).toThrow();

    const filesystem = permission("filesystem", {
      root: "project",
      access: "read",
      path_prefix: "src",
    });
    const filesystemScope = {
      kind: "filesystem",
      scope: filesystem.scope,
    } as CapabilityPermissionKindScopeV1;
    expect(validatePermissionKindScope(filesystemScope)).toEqual(filesystemScope);
    expect(permissionScopeDigest(filesystemScope)).toStartWith("sha256:");
    expect(publicPermissionScope(filesystemScope)).toContain('"filesystem"');
    expect(() => assertPermissionMatchesOperationScope(filesystem, "project")).not.toThrow();
    expect(() => assertPermissionMatchesOperationScope(filesystem, "user")).toThrow(
      /crosses the operation scope/,
    );
    expect(
      validateManifestPermission(
        {
          permission_id: "acme.pkg/read",
          required_enforcement: "sandboxed",
          kind: filesystem.kind,
          scope: filesystem.scope,
        },
        "acme.pkg",
        "permission",
      ).permission_id,
    ).toBe("acme.pkg/read");
    for (const permission_id of ["other/read", "vf.source/read"])
      expect(() =>
        validateManifestPermission(
          {
            permission_id,
            required_enforcement: "sandboxed",
            kind: filesystem.kind,
            scope: filesystem.scope,
          },
          "acme.pkg",
          "permission",
        ),
      ).toThrow(/manifest namespace/);
  });

  test("validates all seven scope variants and their invalid bounds", () => {
    const valid = [
      permission("network", {
        transport: "https",
        host: "api.example.com",
        port: 443,
        path_prefix: "/v1",
      }),
      permission("process", {
        executable_class: "node",
        argv_prefix: ["run"],
        allow_additional_args: true,
      }),
      permission("shell", { adapter_id: "shell", template_id: "install" }),
      permission("config", {
        engine: "codex",
        namespace: "mcp",
        access: "write",
        key_prefix: "servers.local",
      }),
      permission("secret", { input_ids: ["token"] }),
      permission("hook", {
        engine: "claude",
        hook_point: "pre-tool",
        participant_id: null,
      }),
    ];
    for (const value of valid) {
      const kindScope = {
        kind: value.kind,
        scope: value.scope,
      } as CapabilityPermissionKindScopeV1;
      expect(validatePermissionKindScope(kindScope)).toEqual(kindScope);
    }
    expect(() =>
      validatePermissionKindScope({
        kind: "network",
        scope: { transport: "https", host: "api.example.com", port: 0, path_prefix: "/" },
      }),
    ).toThrow();
    expect(() =>
      validatePermissionKindScope({
        kind: "process",
        scope: {
          executable_class: "node",
          argv_prefix: Array(129).fill("x"),
          allow_additional_args: true,
        },
      }),
    ).toThrow(/argv prefix/);
    expect(() => validatePermissionKindScope({ kind: "secret", scope: { input_ids: [] } })).toThrow(
      /secret input set/,
    );
    expect(() =>
      validatePermissionKindScope({ kind: "secret", scope: { input_ids: ["z", "a"] } }),
    ).toThrow();
  });

  test("contains only exact or narrower scopes for every permission kind", () => {
    const rows: Array<[PermissionBindingRowV1, PermissionBindingRowV1, boolean]> = [
      [
        permission("filesystem", { root: "project", access: "read", path_prefix: "src" }),
        permission("filesystem", { root: "project", access: "read", path_prefix: "src/lib" }),
        true,
      ],
      [
        permission("network", {
          transport: "https",
          host: "api.example.com",
          port: null,
          path_prefix: "/v1",
        }),
        permission("network", {
          transport: "https",
          host: "api.example.com",
          port: 443,
          path_prefix: "/v1/items",
        }),
        true,
      ],
      [
        permission("process", {
          executable_class: "node",
          argv_prefix: ["run"],
          allow_additional_args: true,
        }),
        permission("process", {
          executable_class: "node",
          argv_prefix: ["run", "build"],
          allow_additional_args: false,
        }),
        true,
      ],
      [
        permission("shell", { adapter_id: "shell", template_id: "install" }),
        permission("shell", { adapter_id: "shell", template_id: "install" }),
        true,
      ],
      [
        permission("config", {
          engine: "codex",
          namespace: "mcp",
          access: "write",
          key_prefix: "servers",
        }),
        permission("config", {
          engine: "codex",
          namespace: "mcp",
          access: "write",
          key_prefix: "servers.local",
        }),
        true,
      ],
      [
        permission("secret", { input_ids: ["a", "b"] }),
        permission("secret", { input_ids: ["b"] }),
        true,
      ],
      [
        permission("hook", {
          engine: "claude",
          hook_point: "pre-tool",
          participant_id: null,
        }),
        permission("hook", {
          engine: "claude",
          hook_point: "pre-tool",
          participant_id: "reviewer",
        }),
        true,
      ],
    ];
    for (const [grant, request, expected] of rows) {
      expect(permissionContains(grant, request)).toBe(expected);
      expect(permissionContains(request, grant)).toBe(grant.kind === "shell");
    }
    expect(
      permissionContains(
        permission("filesystem", { root: "project", access: "read", path_prefix: "src" }),
        permission("network", {
          transport: "https",
          host: "api.example.com",
          port: 443,
          path_prefix: "/",
        }),
      ),
    ).toBeFalse();
  });

  test("forms canonical unions, bindings, target digests, and containment decisions", () => {
    const broad = permission("filesystem", {
      root: "project",
      access: "read",
      path_prefix: "src",
    });
    const narrow = permission("filesystem", {
      root: "project",
      access: "read",
      path_prefix: "src/lib",
    });
    expect(canonicalPermissionUnion([narrow, broad])).toEqual([broad]);
    expect(permissionRowSortKey(broad)).toContain("acme.pkg/filesystem");
    expect(permissionTargetSetDigest(["a", "b"])).toStartWith("sha256:");
    expect(() => permissionTargetSetDigest(["b", "a"])).toThrow();
    expect(() => canonicalPermissionUnion([{ ...broad, permission_id: "" }])).toThrow();
    expect(() => canonicalPermissionUnion([{ ...broad, target_ids: ["z", "a"] }])).toThrow();
    expect(permissionUnionContains([broad], [narrow])).toBeTrue();
    expect(permissionUnionContains([narrow], [broad])).toBeFalse();

    const binding: PermissionBindingV1 = {
      schema_version: "1.0",
      permissions: [broad],
      secret_input_ids: ["token"],
    };
    expect(canonicalPermissionBinding(binding)).toEqual(binding);
    expect(permissionBindingDigest(binding)).toBe(digestV1("VF-PERMISSION-BINDING\0v1\0", binding));
    expect(() =>
      canonicalPermissionBinding({ ...binding, secret_input_ids: ["z", "a"] }),
    ).toThrow();
    expect(() => canonicalPermissionBinding({ ...binding, permissions: [narrow, broad] })).toThrow(
      /canonical union/,
    );
  });

  test("classifies add, remove, unchanged, narrow, and expand deltas for every scope kind", () => {
    const rows = [
      permission("filesystem", { root: "project", access: "read", path_prefix: "src" }),
      permission("network", {
        transport: "https",
        host: "api.example.com",
        port: 443,
        path_prefix: "/v1",
      }),
      permission("process", {
        executable_class: "node",
        argv_prefix: ["run"],
        allow_additional_args: true,
      }),
      permission("shell", { adapter_id: "shell", template_id: "install" }),
      permission("config", {
        engine: "codex",
        namespace: "mcp",
        access: "write",
        key_prefix: "servers.local",
      }),
      permission("secret", { input_ids: ["token"] }),
      permission("hook", {
        engine: "claude",
        hook_point: "pre-tool",
        participant_id: null,
      }),
    ];
    expect(permissionDelta([], rows).map((value) => value.change)).toEqual(Array(7).fill("add"));
    expect(permissionDelta(rows, []).map((value) => value.change)).toEqual(Array(7).fill("remove"));
    expect(permissionDelta(rows, rows).every((value) => value.change === "unchanged")).toBeTrue();
    const broad = permission("filesystem", {
      root: "project",
      access: "read",
      path_prefix: "src",
    });
    const narrow = permission("filesystem", {
      root: "project",
      access: "read",
      path_prefix: "src/lib",
    });
    expect(permissionDelta([broad], [narrow])[0]?.change).toBe("narrow");
    expect(permissionDelta([narrow], [broad])[0]?.change).toBe("expand");
  });
});

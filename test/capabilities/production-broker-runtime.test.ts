import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareAndSwapProjectionFile,
  projectionStateBytes,
} from "../../src/capabilities/adapters/filesystem-io.js";
import { hydratePrivateEffectPayload } from "../../src/capabilities/adapters/payload-preimage-authority.js";
import {
  privateEffectOwnerPreimageBinding,
  privateEffectPayloadDigest,
  validateAdapterPrivateDescriptor,
  validatePrivateEffectBinding,
  validatePrivateEffectOwnerPreimageBinding,
  validatePrivateEffectPayload,
} from "../../src/capabilities/adapters/private-descriptors.js";
import { resolveCapabilityAdapter } from "../../src/capabilities/adapters/registry.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityPrivateEffectPayloadV1,
} from "../../src/capabilities/adapters/types.js";
import {
  CapabilityFabricServiceV1,
  type CapabilityManifestV1,
  CapabilityRuntimeError,
  FilesystemCapabilityEffectBrokerV1,
  type ResolvedCapabilityPackageV1,
} from "../../src/capabilities/index.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import {
  computePackageTree,
  createAuthenticityBinding,
  createPackagePin,
} from "../../src/capabilities/source/index.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
  userCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import { canonicalJsonBytes, digestV1, sha256Digest } from "../../src/durability/index.js";
import { sha } from "./fixtures.js";
import {
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimePlanningGraph,
  runtimePlanningRequest,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(
  id: string,
  components: CapabilityManifestV1["components"],
  files: Map<string, Uint8Array>,
  health: CapabilityManifestV1["health"] = [],
  inputs: CapabilityManifestV1["inputs"] = [],
): ResolvedCapabilityPackageV1 {
  const value: CapabilityManifestV1 = {
    schema_version: "1.0",
    id,
    version: "1.0.0",
    metadata: {
      display_name: id,
      summary: `Production projection for ${id}`,
      homepage_url: null,
      documentation_url: null,
      icon: null,
    },
    compatibility: {
      vf: "^0.15.0",
      engines: Object.fromEntries(
        [...new Set(components.flatMap((component) => component.targets))].map((engine) => [
          engine,
          ">=1.0.0 <2.0.0",
        ]),
      ),
    },
    components,
    dependencies: [],
    conflicts: [],
    permissions: [],
    inputs,
    health,
  };
  const source = canonicalJsonBytes(value);
  files.set("capability.json", source);
  const tree = computePackageTree([...files].map(([path, bytes]) => ({ path, bytes })));
  const parsed = parseCapabilityManifest(source, tree.files);
  const manifestDigest = parsed.manifest_digest;
  const pin = createPackagePin({
    id,
    version: value.version,
    source: { kind: "local-dev", repo_relative_alias: `.vibeflow/packages/${id}` },
    content_sha256: tree.content_sha256,
  });
  return {
    schema_version: "1.0",
    pin,
    manifest: parsed.manifest,
    manifest_digest: manifestDigest,
    authenticity_binding: createAuthenticityBinding(pin, manifestDigest, null),
    files: tree.files,
    dependencies: [],
    public_inputs: [],
    secret_input_ids: inputs
      .filter((input) => input.type === "secret-handle")
      .map((input) => input.input_id),
    private_input_binding_digest: digestV1("VF-CAPABILITY-PRIVATE-INPUT-BINDING-SET\0v1\0", {
      schema_version: "1.0",
      bindings: [],
    }),
    source_authority_binding_digest: digestV1(
      "VF-RESOLVED-SOURCE-AUTHORITY-BINDING\0v1\0",
      pin.pin_digest,
    ),
  };
}

function fixture(scope: "project" | "user" = "project") {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-production-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const userRoot = join(root, "user");
  mkdirSync(userRoot);
  const authority = runtimeAuthority({
    scope,
    scope_identity_digest: digestV1("VF-CAPABILITY-TEST-SCOPE\0v1\0", scope),
  });
  const paths =
    scope === "project"
      ? projectCapabilityPaths(root)
      : userCapabilityPaths(join(userRoot, ".vibeflow"));
  const storage = new CapabilityStorageV1(paths, authority.scope_identity_digest);
  const broker = new FilesystemCapabilityEffectBrokerV1({
    projectRoot: root,
    userRoot,
    projectStateRoot: projectCapabilityPaths(root).privateRoot,
    userStateRoot: join(userRoot, ".vibeflow", "capabilities"),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  const service = new CapabilityFabricServiceV1({
    storage,
    broker,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return { authority, broker, root, service, storage, userRoot };
}

function install(fx: ReturnType<typeof fixture>, pkg: ResolvedCapabilityPackageV1) {
  retainRuntimePackageCache(fx.storage, pkg);
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: fx.authority.scope,
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: [...new Set(pkg.manifest.components.flatMap((row) => row.targets))],
    },
    fx.broker,
  );
  const { plan } = graph;
  const result = fx.service.execute({
    graph,
    authorization: {
      schema_version: "1.0",
      proposal_id: `vf-proposal-${"1".repeat(64)}`,
      proposal_digest: digestV1("VF-TEST-PROPOSAL\0v1\0", pkg.pin.id),
      approval_id: `vf-approval-${"2".repeat(64)}`,
      approval_digest: digestV1("VF-TEST-APPROVAL\0v1\0", pkg.pin.id),
    },
  });
  return { graph, plan, result };
}

function restart(fx: ReturnType<typeof fixture>) {
  const broker = new FilesystemCapabilityEffectBrokerV1({
    projectRoot: fx.root,
    userRoot: fx.userRoot,
    projectStateRoot: projectCapabilityPaths(fx.root).privateRoot,
    userStateRoot: join(fx.userRoot, ".vibeflow", "capabilities"),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  const service = new CapabilityFabricServiceV1({
    storage: fx.storage,
    broker,
    authority: runtimeAuthorityReader(() => fx.authority),
    ...testRuntimeMutationAuthorities(),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return { broker, service };
}

function redigestPrivateDescriptor(
  descriptor: CapabilityAdapterPrivateDescriptorV1,
): CapabilityAdapterPrivateDescriptorV1 {
  descriptor.value.private_payload.payload_digest = privateEffectPayloadDigest(
    descriptor.value.private_payload,
  );
  descriptor.descriptor_digest = digestV1("VF-ADAPTER-PRIVATE-DESCRIPTOR\0v1\0", {
    schema_version: descriptor.schema_version,
    descriptor_kind: descriptor.descriptor_kind,
    descriptor_schema_id: descriptor.descriptor_schema_id,
    value: descriptor.value,
  });
  return descriptor;
}

describe("production Capability Fabric adapters", () => {
  test("materializes marked role and skill projections without leaking package bytes", () => {
    for (const kind of ["role", "skill"] as const) {
      const fx = fixture();
      const canary = `VF_SECRET_CANARY_${kind}_9d72`;
      const source = Buffer.from(canary);
      const path = kind === "role" ? "roles/reviewer.md" : "skills/reviewer.md";
      const component =
        kind === "role"
          ? {
              type: "role" as const,
              component_id: "reviewer",
              targets: ["codex" as const],
              required: true,
              role_spec_path: path,
              role_spec_sha256: sha(source),
            }
          : {
              type: "skill" as const,
              component_id: "reviewer",
              targets: ["claude" as const],
              required: true,
              bundle_path: path,
              bundle_sha256: sha(source),
            };
      const pkg = manifest(`acme.${kind}`, [component], new Map([[path, source]]), [
        {
          probe_id: "projection",
          component_ids: ["reviewer"],
          kind: kind === "role" ? "role-parse" : "file-hash",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ]);
      const { plan, result } = install(fx, pkg);
      expect(result.status).toBe("succeeded");
      expect(JSON.stringify(plan)).not.toContain(canary);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(fx.storage.readStatus().lock)).not.toContain(canary);
      const target =
        kind === "role"
          ? join(fx.root, ".codex", "agents", "acme.role--reviewer.toml")
          : join(fx.root, ".claude", "skills", "acme.skill--reviewer", "SKILL.md");
      expect(readFileSync(target, "utf8")).toContain(canary);
    }
  });

  test("performs narrow MCP JSON/TOML registration for every host-owned engine", () => {
    const cases = [
      ["claude", ".mcp.json"],
      ["codex", ".codex/config.toml"],
      ["opencode", "opencode.json"],
      ["antigravity", ".agents/mcp_config.json"],
    ] as const;
    for (const [engine, configPath] of cases) {
      const fx = fixture();
      const pkg = manifest(
        `acme.mcp-${engine}`,
        [
          {
            type: "mcp",
            component_id: "server",
            targets: [engine],
            required: true,
            transport: "http",
            url: "https://example.com/mcp",
          },
        ],
        new Map(),
      );
      const { result } = install(fx, pkg);
      expect(result.status).toBe("succeeded");
      expect(readFileSync(join(fx.root, configPath), "utf8")).toContain("example.com");
      const resource = fx.storage.readStatus().lock?.packages[0]?.targets[0]?.projections[0];
      expect(resource).toBeDefined();
      expect(
        fx.broker.health({
          target_id: fx.storage.readStatus().lock?.packages[0]?.targets[0]?.target_id as string,
          probe_id: "handshake",
          kind: "mcp-handshake",
          expected_resources: [
            {
              ownership_key: resource?.ownership_key as string,
              kind: "config-key",
              public_target: configPath,
              expected_preimage_sha256: null,
              expected_postimage_sha256: fx.broker.inspect({
                ownership_key: resource?.ownership_key as string,
              }).content_sha256,
              private_preimage_digest: null,
              private_preimage_ref: null,
            },
          ],
        }).outcome,
      ).toBe("unknown");
    }
  });

  test("writes effective project hook locations and preserves unrelated engine config", () => {
    const claude = fixture();
    mkdirSync(join(claude.root, ".claude"));
    writeFileSync(
      join(claude.root, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", hooks: { Stop: [{ matcher: "custom" }] } }),
    );
    const claudePackage = manifest(
      "acme.hook-claude",
      [
        {
          type: "hook",
          component_id: "guardrail",
          targets: ["claude"],
          required: true,
          event: "pre-tool",
          vf_handler_id: "vf-guardrail",
        },
      ],
      new Map(),
      [
        {
          probe_id: "hook",
          component_ids: ["guardrail"],
          kind: "hook-selftest",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ],
    );
    expect(install(claude, claudePackage).result.status).toBe("succeeded");
    const claudeConfig = JSON.parse(
      readFileSync(join(claude.root, ".claude", "settings.json"), "utf8"),
    ) as { model: string; hooks: { Stop: unknown; PreToolUse: unknown } };
    expect(claudeConfig.model).toBe("opus");
    expect(claudeConfig.hooks.Stop).toEqual([{ matcher: "custom" }]);
    expect(claudeConfig.hooks.PreToolUse).toBeArray();

    const antigravity = fixture();
    mkdirSync(join(antigravity.root, ".agents"));
    writeFileSync(
      join(antigravity.root, ".agents", "hooks.json"),
      JSON.stringify({
        user_hook: { keep: true },
        "vibeflow-guardrail": { PostToolUse: [{ matcher: "custom" }] },
      }),
    );
    const antigravityPackage = manifest(
      "acme.hook-antigravity",
      [
        {
          type: "hook",
          component_id: "guardrail",
          targets: ["antigravity"],
          required: true,
          event: "pre-tool",
          vf_handler_id: "vf-guardrail",
        },
      ],
      new Map(),
    );
    expect(install(antigravity, antigravityPackage).result.status).toBe("succeeded");
    const antigravityConfig = JSON.parse(
      readFileSync(join(antigravity.root, ".agents", "hooks.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(antigravityConfig.user_hook).toEqual({ keep: true });
    expect(antigravityConfig["vibeflow-guardrail"]?.PostToolUse).toEqual([{ matcher: "custom" }]);
    expect(antigravityConfig["vibeflow-guardrail"]?.PreToolUse).toBeArray();

    for (const [engine, relativePath, canary] of [
      ["copilot", ".github/hooks/copilot.json", "preToolUse"],
      ["opencode", ".opencode/plugins/vf-guard.ts", "vibeflow-guardrail"],
    ] as const) {
      const fx = fixture();
      const pkg = manifest(
        `acme.hook-${engine}`,
        [
          {
            type: "hook",
            component_id: "guardrail",
            targets: [engine],
            required: true,
            event: "pre-tool",
            vf_handler_id: "vf-guardrail",
          },
        ],
        new Map(),
      );
      expect(install(fx, pkg).result.status).toBe("succeeded");
      expect(readFileSync(join(fx.root, relativePath), "utf8")).toContain(canary);
    }
  });

  test("writes Codex hooks only in user scope and preserves unrelated global config", () => {
    const fx = fixture("user");
    mkdirSync(join(fx.userRoot, ".codex"));
    writeFileSync(
      join(fx.userRoot, ".codex", "hooks.json"),
      JSON.stringify({ metadata: { keep: true }, hooks: { Stop: [{ command: "custom" }] } }),
    );
    writeFileSync(
      join(fx.userRoot, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[features]\nother_feature = true\n\n[other]\nkeep = 1\n',
    );
    const pkg = manifest(
      "acme.hook-codex",
      [
        {
          type: "hook",
          component_id: "guardrail",
          targets: ["codex"],
          required: true,
          event: "pre-tool",
          vf_handler_id: "vf-guardrail",
        },
      ],
      new Map(),
      [
        {
          probe_id: "hook",
          component_ids: ["guardrail"],
          kind: "hook-selftest",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ],
    );
    const installed = install(fx, pkg);
    expect(installed.result.status).toBe("succeeded");
    const descriptor = installed.graph.ledger.json_objects.find(
      (row) => row.binding.object_schema_id === "vf.adapter-private-descriptor/1",
    )?.value as
      | import("../../src/capabilities/adapters/types.js").CapabilityAdapterPrivateDescriptorV1
      | undefined;
    if (!descriptor || descriptor.value.private_payload.payload_kind !== "hook-config-slice")
      throw new Error("Codex hook descriptor missing");
    expect(descriptor.value.private_payload.codex_feature?.preimage_block).toBeNull();
    expect(descriptor.value.private_payload.preimage).toBeNull();
    expect(JSON.stringify(descriptor)).not.toContain("preimage_owner_record_base64");
    expect(JSON.stringify(descriptor)).not.toContain('model = \\"gpt-5\\"');
    expect(
      installed.graph.ledger.raw_blobs.filter(
        (row) => row.binding.blob_kind === "owned-resource-preimage",
      ),
    ).toHaveLength(0);
    expect(projectionStateBytes(null, null, [], false)).toBeNull();
    expect(projectionStateBytes(null, null, [], true)).not.toBeNull();
    const hooks = JSON.parse(readFileSync(join(fx.userRoot, ".codex", "hooks.json"), "utf8")) as {
      metadata: unknown;
      hooks: { Stop: unknown; PreToolUse: unknown };
    };
    expect(hooks.metadata).toEqual({ keep: true });
    expect(hooks.hooks.Stop).toEqual([{ command: "custom" }]);
    expect(hooks.hooks.PreToolUse).toBeArray();
    const config = readFileSync(join(fx.userRoot, ".codex", "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("other_feature = true");
    expect(config).toContain("codex_hooks = true");
    expect(config.indexOf("codex_hooks = true")).toBeLessThan(config.indexOf("[other]"));
    expect(config).toContain("keep = 1");
    expect(existsSync(join(fx.root, ".codex", "hooks.json"))).toBeFalse();

    const removeGraph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "remove", package_id: pkg.pin.id, cascade: false },
        scope: "user",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: fx.storage.readStatus().lock,
        desired_packages: [],
        effect_packages: [pkg],
        selected_engines: ["codex"],
      },
      fx.broker,
    );
    const removalResource = removeGraph.plan.adapter_plans
      .flatMap((plan) => plan.steps)
      .flatMap((step) => step.owned_resources)
      .find((resource) => resource.ownership_key.includes(":hook:"));
    if (
      !removalResource?.private_preimage_digest ||
      removalResource.expected_preimage_sha256 === null
    )
      throw new Error("Codex hook removal lacks its raw preimage binding");
    const removalBlob = removeGraph.ledger.raw_blobs.find(
      (row) => row.binding.content_digest === removalResource.private_preimage_digest,
    );
    if (!removalBlob) throw new Error("Codex hook removal raw preimage is absent");
    const removalBytes = Buffer.from(removalBlob.bytes_base64, "base64");
    expect(removalBlob.binding.raw_sha256).toBe(removalResource.expected_preimage_sha256);
    expect(removalBlob.binding.raw_sha256).toBe(sha(removalBytes));
    expect(removalBytes.toString("utf8")).not.toContain('model = "gpt-5"');
    expect(removalBytes.toString("utf8")).toContain("codex-hooks-feature:start");
    const removalDescriptor = removeGraph.ledger.json_objects.find(
      (row) =>
        row.binding.object_schema_id === "vf.adapter-private-descriptor/1" &&
        (row.value as { value?: { resource?: { ownership_key?: string } } }).value?.resource
          ?.ownership_key === removalResource.ownership_key,
    )?.value as
      | import("../../src/capabilities/adapters/types.js").CapabilityAdapterPrivateDescriptorV1
      | undefined;
    expect(removalDescriptor?.value.private_payload.preimage_owner_binding).not.toBeNull();
    expect(JSON.stringify(removalDescriptor)).not.toContain("preimage_owner_record_base64");
    expect(
      fx.service.execute({
        graph: removeGraph,
        authorization: {
          schema_version: "1.0",
          proposal_id: `vf-proposal-${"3".repeat(64)}`,
          proposal_digest: digestV1("VF-TEST-PROPOSAL\0v1\0", "remove-codex-hook"),
          approval_id: `vf-approval-${"4".repeat(64)}`,
          approval_digest: digestV1("VF-TEST-APPROVAL\0v1\0", "remove-codex-hook"),
        },
      }).status,
    ).toBe("succeeded");
    const restoredHooks = JSON.parse(
      readFileSync(join(fx.userRoot, ".codex", "hooks.json"), "utf8"),
    ) as { metadata: unknown; hooks: { Stop: unknown; PreToolUse?: unknown } };
    expect(restoredHooks.metadata).toEqual({ keep: true });
    expect(restoredHooks.hooks.Stop).toEqual([{ command: "custom" }]);
    expect(restoredHooks.hooks.PreToolUse).toBeUndefined();
    const restoredConfig = readFileSync(join(fx.userRoot, ".codex", "config.toml"), "utf8");
    expect(restoredConfig).toContain("other_feature = true");
    expect(restoredConfig).toContain("keep = 1");
    expect(restoredConfig).not.toContain("codex_hooks");
  });

  test("rejects re-digested private preimage smuggling and noncanonical Codex paths", () => {
    const fx = fixture("user");
    const pkg = manifest(
      "acme.hook-codex-validator",
      [
        {
          type: "hook",
          component_id: "guardrail",
          targets: ["codex"],
          required: true,
          event: "pre-tool",
          vf_handler_id: "vf-guardrail",
        },
      ],
      new Map(),
    );
    const graph = install(fx, pkg).graph;
    const descriptor = graph.ledger.json_objects.find(
      (row) => row.binding.object_schema_id === "vf.adapter-private-descriptor/1",
    )?.value as CapabilityAdapterPrivateDescriptorV1 | undefined;
    if (
      !descriptor ||
      descriptor.value.private_payload.payload_kind !== "hook-config-slice" ||
      descriptor.value.private_payload.codex_feature === null
    )
      throw new Error("Codex hook descriptor oracle is missing");
    expect(descriptor.value.private_payload.expected_preimage_sha256).toBeNull();
    expect(() => validateAdapterPrivateDescriptor(descriptor)).not.toThrow();

    const effectDescriptor = graph.plan.runtime_closure.descriptors[0];
    if (!effectDescriptor) throw new Error("private effect binding oracle is missing");
    const outerBindingExtra = structuredClone(effectDescriptor.private_payload_binding);
    (outerBindingExtra as unknown as Record<string, unknown>).raw_backup = "eA==";
    expect(() => validatePrivateEffectBinding(outerBindingExtra)).toThrow(/keys are not exact/i);

    const ownerBinding = privateEffectOwnerPreimageBinding(
      effectDescriptor.private_payload_binding,
    );
    expect(() => validatePrivateEffectOwnerPreimageBinding(ownerBinding)).not.toThrow();
    const ownerBindingExtra = structuredClone(ownerBinding);
    (ownerBindingExtra as unknown as Record<string, unknown>).raw_backup = "eA==";
    expect(() => validatePrivateEffectOwnerPreimageBinding(ownerBindingExtra)).toThrow(
      /owner preimage binding is invalid/i,
    );

    const locatorExtra = structuredClone(effectDescriptor.private_payload_binding);
    (locatorExtra.action_root_locator as unknown as Record<string, unknown>).raw_backup = "eA==";
    locatorExtra.action_root_binding_digest = digestV1(
      "VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0",
      locatorExtra.action_root_locator,
    );
    expect(() => validatePrivateEffectBinding(locatorExtra)).toThrow(/action root is invalid/i);

    for (const mutate of [
      (value: CapabilityAdapterPrivateDescriptorV1) => {
        (value as unknown as Record<string, unknown>).raw_backup = "eA==";
      },
      (value: CapabilityAdapterPrivateDescriptorV1) => {
        (value.value as unknown as Record<string, unknown>).raw_backup = "eA==";
      },
      (value: CapabilityAdapterPrivateDescriptorV1) => {
        (value.value.adapter as unknown as Record<string, unknown>).raw_backup = "eA==";
      },
      (value: CapabilityAdapterPrivateDescriptorV1) => {
        (value.value.resource as unknown as Record<string, unknown>).raw_backup = "eA==";
      },
    ]) {
      const extended = structuredClone(descriptor);
      mutate(extended);
      redigestPrivateDescriptor(extended);
      expect(() => validateAdapterPrivateDescriptor(extended)).toThrow(/keys are not exact/i);
    }

    const jsonPayload: CapabilityPrivateEffectPayloadV1 = {
      schema_version: "1.0",
      payload_kind: "json-key-slice",
      payload_digest: "",
      ownership_key: "vf:oracle:json-slice",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      canonical_relative_path: ".mcp.json",
      marker_relative_path: ".vibeflow/markers/oracle.json",
      key_path: ["mcpServers", "oracle"],
      preimage: null,
      preimage_present: false,
      postimage: null,
      postimage_present: false,
      preimage_marker: null,
      postimage_marker: null,
      auxiliary_files: [
        {
          canonical_relative_path: ".vibeflow/private/oracle",
          file_mode: 0o755,
          preimage_base64: null,
          postimage_base64: "eA==",
        },
      ],
    };
    jsonPayload.payload_digest = privateEffectPayloadDigest(jsonPayload);
    expect(() => validatePrivateEffectPayload(jsonPayload)).not.toThrow();
    const auxiliaryExtra = structuredClone(jsonPayload);
    if (auxiliaryExtra.payload_kind !== "json-key-slice")
      throw new Error("JSON auxiliary oracle changed kind");
    (auxiliaryExtra.auxiliary_files[0] as unknown as Record<string, unknown>).raw_backup = "eA==";
    auxiliaryExtra.payload_digest = privateEffectPayloadDigest(auxiliaryExtra);
    expect(() => validatePrivateEffectPayload(auxiliaryExtra)).toThrow(/keys are not exact/i);

    const legacyBytes = Buffer.from("legacy private preimage");
    const legacyPayload: CapabilityPrivateEffectPayloadV1 = {
      schema_version: "1.0",
      payload_kind: "legacy-claim",
      payload_digest: "",
      ownership_key: "legacy:oracle:file",
      expected_preimage_sha256: sha256Digest(legacyBytes).slice("sha256:".length),
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      legacy_source: "skill-lock",
      inspection_evidence_digest: digestV1("VF-TEST-LEGACY-INSPECTION\0v1\0", "oracle"),
      evidence_record_digest: digestV1("VF-TEST-LEGACY-EVIDENCE\0v1\0", "oracle"),
      projection: {
        kind: "file",
        canonical_relative_path: ".agents/skills/oracle/SKILL.md",
        preimage_base64: legacyBytes.toString("base64"),
      },
    };
    legacyPayload.payload_digest = privateEffectPayloadDigest(legacyPayload);
    expect(() => validatePrivateEffectPayload(legacyPayload)).not.toThrow();
    const legacyExtra = structuredClone(legacyPayload);
    if (legacyExtra.payload_kind !== "legacy-claim")
      throw new Error("legacy projection oracle changed kind");
    (legacyExtra.projection as unknown as Record<string, unknown>).raw_backup = "eA==";
    legacyExtra.payload_digest = privateEffectPayloadDigest(legacyExtra);
    expect(() => validatePrivateEffectPayload(legacyExtra)).toThrow(/keys are not exact/i);

    const claudeAdapter = resolveCapabilityAdapter("hook", "claude").adapter;
    if (!claudeAdapter) throw new Error("Claude hook adapter oracle is missing");
    const crossEngineFeature = structuredClone(descriptor);
    crossEngineFeature.value.adapter = claudeAdapter;
    redigestPrivateDescriptor(crossEngineFeature);
    expect(() => validateAdapterPrivateDescriptor(crossEngineFeature)).toThrow(
      /not bound to the Codex hook adapter/i,
    );

    const missingCodexFeature = structuredClone(descriptor);
    if (missingCodexFeature.value.private_payload.payload_kind !== "hook-config-slice")
      throw new Error("Codex hook missing-feature oracle changed kind");
    missingCodexFeature.value.private_payload.codex_feature = null;
    redigestPrivateDescriptor(missingCodexFeature);
    expect(() => validateAdapterPrivateDescriptor(missingCodexFeature)).toThrow(
      /not bound to the Codex hook adapter/i,
    );

    const rawBackup = structuredClone(descriptor);
    (
      rawBackup.value.private_payload as unknown as Record<string, unknown>
    ).raw_preimage_backup_base64 = Buffer.from("accepted-oracle-preimage").toString("base64");
    redigestPrivateDescriptor(rawBackup);
    expect(() => validateAdapterPrivateDescriptor(rawBackup)).toThrow(/keys are not exact/i);
    expect(() => hydratePrivateEffectPayload(rawBackup.value.private_payload, null)).toThrow(
      /keys are not exact/i,
    );

    const inline = structuredClone(descriptor);
    if (inline.value.private_payload.payload_kind !== "hook-config-slice")
      throw new Error("Codex hook inline oracle changed kind");
    const inlineFeature = inline.value.private_payload.codex_feature;
    if (inlineFeature === null) throw new Error("Codex hook inline oracle lacks its feature");
    inlineFeature.preimage_block = "# vf-capability:codex-hooks-feature:start\nraw = true";
    redigestPrivateDescriptor(inline);
    expect(() => validateAdapterPrivateDescriptor(inline)).toThrow(/inline preimage authority/i);
    expect(() => hydratePrivateEffectPayload(inline.value.private_payload, null)).toThrow(
      /inline preimage authority/i,
    );

    const nestedExtra = structuredClone(descriptor);
    if (nestedExtra.value.private_payload.payload_kind !== "hook-config-slice")
      throw new Error("Codex hook nested oracle changed kind");
    const nestedFeature = nestedExtra.value.private_payload.codex_feature;
    if (nestedFeature === null) throw new Error("Codex hook nested oracle lacks its feature");
    (nestedFeature as unknown as Record<string, unknown>).raw_backup = "forbidden";
    redigestPrivateDescriptor(nestedExtra);
    expect(() => validateAdapterPrivateDescriptor(nestedExtra)).toThrow(/keys are not exact/i);

    const escaped = structuredClone(descriptor);
    if (escaped.value.private_payload.payload_kind !== "hook-config-slice")
      throw new Error("Codex hook path oracle changed kind");
    const escapedFeature = escaped.value.private_payload.codex_feature;
    if (escapedFeature === null) throw new Error("Codex hook path oracle lacks its feature");
    escapedFeature.canonical_relative_path = ".ssh/config";
    redigestPrivateDescriptor(escaped);
    expect(() => validateAdapterPrivateDescriptor(escaped)).toThrow(/closed canonical path/i);
  });

  test("pins mutation directories and exact-CASes competing ownership publication", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-cap-symlink-swap-"));
    roots.push(root);
    const liveDirectory = join(root, "live");
    const attackerDirectory = join(root, "attacker");
    mkdirSync(liveDirectory);
    mkdirSync(attackerDirectory);
    writeFileSync(join(liveDirectory, "projection.json"), "before");
    writeFileSync(join(attackerDirectory, "projection.json"), "victim");
    expect(() =>
      compareAndSwapProjectionFile(
        join(liveDirectory, "projection.json"),
        Buffer.from("before"),
        Buffer.from("after"),
        0o600,
        () => {
          renameSync(liveDirectory, join(root, "moved-live"));
          symlinkSync(attackerDirectory, liveDirectory, "dir");
        },
      ),
    ).toThrow();
    expect(readFileSync(join(attackerDirectory, "projection.json"), "utf8")).toBe("victim");

    const fx = fixture();
    const pkg = manifest(
      "acme.owner-cas",
      [
        {
          type: "role",
          component_id: "owner",
          targets: ["claude"],
          required: true,
          role_spec_path: "roles/owner.md",
          role_spec_sha256: sha(Buffer.from("owner")),
        },
      ],
      new Map([["roles/owner.md", Buffer.from("owner")]]),
    );
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [pkg],
        selected_engines: ["claude"],
      },
      fx.broker,
    );
    const descriptor = graph.plan.runtime_closure.descriptors.find(
      (row) => row.descriptor_kind === "intent",
    );
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error("missing test descriptor");
    const payload = fx.broker.resolvePrivatePayload(descriptor.private_payload_binding);
    fx.broker.payloads.publishOwner(payload, descriptor.private_payload_binding, "forward");
    expect(() =>
      fx.broker.payloads.publishOwner(payload, descriptor.private_payload_binding, "forward"),
    ).toThrow("owned projection registry CAS preimage mismatch");
  });

  test("restart reconciliation restores every approved crash-partial projection class", () => {
    const cases = [
      {
        name: "owned-file",
        scope: "project" as const,
        engine: "claude" as const,
        boundaries: 2,
        build: () => {
          const bytes = Buffer.from("crash-safe-role");
          return manifest(
            "acme.crash-role",
            [
              {
                type: "role",
                component_id: "role",
                targets: ["claude"],
                required: true,
                role_spec_path: "roles/role.md",
                role_spec_sha256: sha(bytes),
              },
            ],
            new Map([["roles/role.md", bytes]]),
          );
        },
      },
      {
        name: "json-auxiliary",
        scope: "project" as const,
        engine: "claude" as const,
        boundaries: 3,
        build: () => {
          const bytes = Buffer.from("#!/usr/bin/env bun\n");
          return manifest(
            "acme.crash-mcp-json",
            [
              {
                type: "mcp",
                component_id: "server",
                targets: ["claude"],
                required: true,
                transport: "stdio",
                executable: {
                  component_id: "server",
                  relative_path: "bin/server.ts",
                  sha256: sha(bytes),
                },
                args: [],
                secret_slots: [],
              },
            ],
            new Map([["bin/server.ts", bytes]]),
          );
        },
      },
      {
        name: "hook-codex-feature",
        scope: "user" as const,
        engine: "codex" as const,
        boundaries: 3,
        build: () =>
          manifest(
            "acme.crash-hook",
            [
              {
                type: "hook",
                component_id: "hook",
                targets: ["codex"],
                required: true,
                event: "pre-tool",
                vf_handler_id: "vf-guardrail",
              },
            ],
            new Map(),
          ),
      },
      {
        name: "toml-block",
        scope: "project" as const,
        engine: "codex" as const,
        boundaries: 2,
        build: () =>
          manifest(
            "acme.crash-mcp-toml",
            [
              {
                type: "mcp",
                component_id: "server",
                targets: ["codex"],
                required: true,
                transport: "http",
                url: "https://example.com/crash",
                secret_slots: [],
              },
            ],
            new Map(),
          ),
      },
    ];
    for (const row of cases) {
      for (let faultOrdinal = 1; faultOrdinal <= row.boundaries; faultOrdinal += 1) {
        const fx = fixture(row.scope);
        if (row.name === "hook-codex-feature") {
          mkdirSync(join(fx.userRoot, ".codex"));
          writeFileSync(join(fx.userRoot, ".codex", "hooks.json"), JSON.stringify({ keep: true }));
          writeFileSync(join(fx.userRoot, ".codex", "config.toml"), "[features]\nkeep = true\n");
        }
        const pkg = row.build();
        retainRuntimePackageCache(fx.storage, pkg);
        const graph = runtimePlanningGraph(
          {
            schema_version: "1.0",
            intent: { kind: "install" },
            scope: row.scope,
            scope_identity_digest: fx.authority.scope_identity_digest,
            authority: fx.authority,
            base_lock: null,
            desired_packages: [pkg],
            selected_engines: [row.engine],
          },
          fx.broker,
        );
        const { plan } = graph;
        const authorization = {
          schema_version: "1.0" as const,
          proposal_id: `vf-proposal-${"5".repeat(64)}`,
          proposal_digest: digestV1("VF-TEST-CRASH-PROPOSAL\0v1\0", `${row.name}:${faultOrdinal}`),
          approval_id: `vf-approval-${"6".repeat(64)}`,
          approval_digest: digestV1("VF-TEST-CRASH-APPROVAL\0v1\0", `${row.name}:${faultOrdinal}`),
        };
        const operationId = fx.service.operationId(graph, authorization);
        let boundary = 0;
        fx.broker.fault = (point) => {
          if (point.surface === "projection" && ++boundary === faultOrdinal)
            throw new CapabilityRuntimeError(`simulated ${row.name} crash`, "fault");
        };
        expect(() => fx.service.execute({ graph, authorization })).toThrow("simulated");
        const fresh = restart(fx);
        const recovered = fresh.service.recover(operationId);
        const completed = faultOrdinal === row.boundaries;
        expect(recovered.status).toBe(completed ? "succeeded" : "failed");
        expect(fx.storage.readStatus().lock?.packages[0]?.package_id ?? null).toBe(
          completed ? pkg.pin.id : null,
        );
        const descriptor = plan.runtime_closure.descriptors.find(
          (item) => item.descriptor_kind === "intent",
        );
        if (!descriptor) throw new Error("missing crash descriptor");
        const payload = fresh.broker.resolvePrivatePayload(descriptor.private_payload_binding);
        expect(fresh.broker.inspect(descriptor.resource, payload).content_sha256).toBe(
          completed
            ? descriptor.resource.expected_postimage_sha256
            : descriptor.resource.expected_preimage_sha256,
        );
        expect(fresh.broker.payloads.ownerBinding(descriptor.resource.ownership_key)).toEqual(
          completed ? descriptor.private_payload_binding : null,
        );
      }
    }
  });

  test("restart reconciliation completes an owner-publication crash without duplicate effects", () => {
    const fx = fixture();
    const bytes = Buffer.from("owner-publication");
    const pkg = manifest(
      "acme.owner-publication",
      [
        {
          type: "role",
          component_id: "role",
          targets: ["claude"],
          required: true,
          role_spec_path: "roles/role.md",
          role_spec_sha256: sha(bytes),
        },
      ],
      new Map([["roles/role.md", bytes]]),
    );
    retainRuntimePackageCache(fx.storage, pkg);
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [pkg],
        selected_engines: ["claude"],
      },
      fx.broker,
    );
    const { plan } = graph;
    const authorization = {
      schema_version: "1.0" as const,
      proposal_id: `vf-proposal-${"7".repeat(64)}`,
      proposal_digest: digestV1("VF-TEST-OWNER-PROPOSAL\0v1\0", pkg.pin.id),
      approval_id: `vf-approval-${"8".repeat(64)}`,
      approval_digest: digestV1("VF-TEST-OWNER-APPROVAL\0v1\0", pkg.pin.id),
    };
    const operationId = fx.service.operationId(graph, authorization);
    fx.broker.fault = (point) => {
      if (point.surface === "owner-binding")
        throw new CapabilityRuntimeError("simulated owner publication crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow("owner publication crash");
    const fresh = restart(fx);
    expect(fresh.service.recover(operationId).status).toBe("succeeded");
    expect(fx.storage.readStatus().lock?.packages[0]?.package_id).toBe(pkg.pin.id);
    const descriptor = plan.runtime_closure.descriptors.find(
      (item) => item.descriptor_kind === "intent",
    );
    if (!descriptor) throw new Error("missing owner descriptor");
    expect(fresh.broker.payloads.ownerBinding(descriptor.resource.ownership_key)).toEqual(
      descriptor.private_payload_binding,
    );
  });

  test("reports scoped/manual/native and secret-slot outcomes without host descriptors", () => {
    const fx = fixture();
    const nonHost = manifest(
      "acme.non-host",
      [
        {
          type: "engine-setting",
          component_id: "setting",
          targets: ["antigravity"],
          required: false,
          setting_id: "theme",
          value: "quiet",
        },
        {
          type: "tool",
          component_id: "tool",
          targets: ["claude"],
          required: false,
          installer: {
            kind: "bun",
            coordinate: "example-tool",
            version: "1.0.0",
            artifact_sha256: "a".repeat(64),
            lifecycle_scripts: "disabled",
          },
          expected_binary: "example-tool",
          version_constraint: "1.0.0",
        },
      ],
      new Map(),
    );
    const plan = fx.service.inspectPlan(
      runtimePlanningRequest({
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [nonHost],
        selected_engines: ["antigravity", "claude"],
      }),
    );
    expect(plan.target_dispositions.map((row) => row.execution).sort()).toEqual([
      "manual",
      "required-user-action",
    ]);
    expect(plan.runtime_closure.descriptors).toEqual([]);

    const codexHook = manifest(
      "acme.project-codex-hook",
      [
        {
          type: "hook",
          component_id: "guardrail",
          targets: ["codex"],
          required: true,
          event: "pre-tool",
          vf_handler_id: "vf-guardrail",
        },
      ],
      new Map(),
    );
    const codexPlan = fx.service.inspectPlan(
      runtimePlanningRequest({
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [codexHook],
        selected_engines: ["codex"],
      }),
    );
    expect(codexPlan.target_dispositions[0]?.execution).toBe("manual");
    expect(codexPlan.runtime_closure.descriptors).toEqual([]);

    const secretSlot = manifest(
      "acme.secret-mcp",
      [
        {
          type: "mcp",
          component_id: "secret-server",
          targets: ["claude"],
          required: true,
          transport: "http",
          url: "https://example.com/mcp",
          secret_slots: ["api-token"],
        },
      ],
      new Map(),
      [],
      [
        {
          input_id: "api-token",
          label: "API token",
          type: "secret-handle",
          required: true,
          default_value: null,
          enum_values: [],
          min: null,
          max: null,
          pattern: null,
        },
      ],
    );
    const secretPlan = fx.service.inspectPlan(
      runtimePlanningRequest({
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [secretSlot],
        selected_engines: ["claude"],
      }),
    );
    expect(secretPlan.target_dispositions[0]?.execution).toBe("unsupported");
    expect(secretPlan.runtime_closure.descriptors).toEqual([]);
  });
});

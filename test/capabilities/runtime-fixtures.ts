import { capabilityActionPlanDigest } from "../../src/capabilities/action-domain/action-plan.js";
import type { CapabilityEffectBrokerV1 } from "../../src/capabilities/adapters/types.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityPlanningRequestV1,
  CapabilityRuntimeAuthorityV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/index.js";
import type { CapabilityManifestV1 } from "../../src/capabilities/manifest/index.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import { buildCapabilityPlanningGraph } from "../../src/capabilities/planning/planner.js";
import { capabilitySourceAuthoritySetDigest } from "../../src/capabilities/planning/source-materialization.js";
import { emptyBindingDigest } from "../../src/capabilities/private-input/helpers.js";
import {
  computePackageTree,
  createAuthenticityBinding,
  createPackagePin,
  retainCapabilityPackageCache,
} from "../../src/capabilities/source/index.js";
import type { CapabilityStorageV1 } from "../../src/capabilities/storage/index.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";

export const runtimeDigest = (label: string): string =>
  digestV1("VF-CAPABILITY-RUNTIME-TEST\0v1\0", label);

export function runtimeAuthorityReader(read: () => CapabilityRuntimeAuthorityV1) {
  return {
    read: (_scope: "project" | "user") => read(),
    readPermissionAuthority: (_graph: CapabilityDurablePlanningGraphV1, _checkedAt: string) =>
      read().permission_digest,
    criticalSection: <T>(
      _scope: "project" | "user",
      _operation: string,
      now: () => string,
      callback: (authority: CapabilityRuntimeAuthorityV1, checkedAt: string) => T,
    ): T => {
      const checkedAt = now();
      return callback(read(), checkedAt);
    },
  };
}

const retainedGraphs = new Map<string, CapabilityDurablePlanningGraphV1>();

/** Explicit test-only authorities for executor fixtures backed by synthetic action records. */
export function testRuntimeMutationAuthorities() {
  return {
    sourceAuthority: {
      readSourceAuthoritySet: (graph: CapabilityDurablePlanningGraphV1, _checkedAt: string) =>
        graph.plan.source_authority_set_digest,
    },
    actionAuthority: {
      verifyPrepared: () => {},
      verifyDispatched: () => {},
      verifyReadable: () => {},
      resolvePlanningGraph: (header: { plan_digest: string }) => {
        const graph = retainedGraphs.get(header.plan_digest);
        if (!graph) throw new Error("test runtime graph was not retained");
        return graph;
      },
    },
  };
}

function bindRuntimePackage(
  pkg: ResolvedCapabilityPackageV1,
  request: CapabilityPlanningRequestV1,
): ResolvedCapabilityPackageV1 {
  const privateDigest = emptyBindingDigest({
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    package_id: pkg.pin.id,
    package_pin_digest: pkg.pin.pin_digest,
    manifest_digest: pkg.manifest_digest,
  });
  const context = {
    schema_version: "1.0" as const,
    origin: "standalone" as const,
    planning_options: { mode: "durable" as const, network_read: "ordinary-host-policy" as const },
    interactivity: "foreground-control" as const,
    requested_by: {
      kind: "human-cli" as const,
      public_actor_id: "runtime-fixture",
      credential_class: "interactive-tty" as const,
    },
    principal_digest: runtimeDigest("fixture-principal"),
    authorization_action_type: null,
  };
  const credentialDraft = {
    schema_version: "1.0" as const,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    principal_digest: context.principal_digest,
    kind: "none" as const,
  };
  const credential = {
    ...credentialDraft,
    binding_digest: digestV1("VF-SOURCE-ACCESS-CREDENTIAL-BINDING\0v1\0", credentialDraft),
  };
  const source =
    pkg.pin.source.kind === "local-dev"
      ? { kind: "local-dev" as const, repo_relative_alias: pkg.pin.source.repo_relative_alias }
      : pkg.pin.source.kind === "git"
        ? {
            kind: "git" as const,
            canonical_url: pkg.pin.source.canonical_url,
            commit_oid: pkg.pin.source.commit_oid,
          }
        : pkg.pin.source.kind === "registry"
          ? {
              kind: "registry" as const,
              registry_origin: pkg.pin.source.registry_origin,
              package_url: pkg.pin.source.source_url,
            }
          : {
              kind: "legacy-adopt" as const,
              phase: "candidate" as const,
              candidate_digest:
                request.intent.kind === "adopt"
                  ? request.intent.candidate_digest
                  : (() => {
                      throw new Error("legacy runtime fixture requires an adopt intent");
                    })(),
            };
  const descriptorDraft = {
    schema_version: "1.0" as const,
    request_context: context,
    intent: "read-local-package" as const,
    authorization_mode: "automatic" as const,
    target_engines: [...request.selected_engines],
    source,
    credential,
    expected_content_sha256: pkg.pin.content_sha256,
    network_policy_profile: null,
    max_response_bytes: [...pkg.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    cache_write: false as const,
    required_permission_row_digests: [] as string[],
  };
  const descriptor = {
    ...descriptorDraft,
    descriptor_digest: digestV1("VF-SOURCE-ACCESS-DESCRIPTOR\0v1\0", descriptorDraft),
  };
  const authorityDraft = {
    schema_version: "1.0" as const,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    source_descriptor_digest: descriptor.descriptor_digest,
    effect_classes: ["pure-local-read" as const],
    authorization: { kind: "confirmation-free" as const, reason: "pure-local-read" as const },
    policy_digest: request.authority.policy_digest,
  };
  const authority = {
    ...authorityDraft,
    binding_digest: digestV1("VF-SOURCE-ACCESS-AUTHORITY\0v1\0", authorityDraft),
  };
  const resolvedDraft = {
    schema_version: "1.0" as const,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    authenticity_digest: pkg.authenticity_binding.authenticity_digest,
    trust_epoch: 0,
    trust_head_digest: null,
    source_access_authority_digest: authority.binding_digest,
    resolved_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T01:00:00.000Z",
  };
  const resolved = {
    ...resolvedDraft,
    binding_digest: digestV1("VF-RESOLVED-SOURCE-AUTHORITY\0v1\0", resolvedDraft),
  };
  return {
    ...pkg,
    private_input_binding_digest: privateDigest,
    private_input_execution: { binding_digest: privateDigest, record: null },
    source_authority_binding_digest: resolved.binding_digest,
    source_execution: { descriptor, authority, resolved },
  };
}

/** Materializes exact private/source execution proof without performing any writes. */
export function runtimePlanningRequest(
  input: CapabilityPlanningRequestV1,
): CapabilityPlanningRequestV1 {
  const all = [...input.desired_packages, ...(input.effect_packages ?? input.desired_packages)];
  const byPin = new Map<string, ResolvedCapabilityPackageV1>();
  for (const pkg of all)
    if (!byPin.has(pkg.pin.pin_digest))
      byPin.set(pkg.pin.pin_digest, bindRuntimePackage(pkg, input));
  const select = (pkg: ResolvedCapabilityPackageV1) =>
    byPin.get(pkg.pin.pin_digest) as ResolvedCapabilityPackageV1;
  const packages = [...byPin.values()];
  input.authority.source_authority_set_digest = capabilitySourceAuthoritySetDigest(packages);
  return {
    ...input,
    desired_packages: input.desired_packages.map(select),
    effect_packages: (input.effect_packages ?? input.desired_packages).map(select),
    action_root_locator: input.action_root_locator ?? {
      kind: "capability",
      scope: input.scope,
      scope_identity_digest: input.scope_identity_digest,
    },
    source_request_context: packages[0]?.source_execution?.descriptor.request_context ?? {
      schema_version: "1.0",
      origin: "standalone",
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      interactivity: "foreground-control",
      requested_by: {
        kind: "human-cli",
        public_actor_id: "runtime-fixture",
        credential_class: "interactive-tty",
      },
      principal_digest: runtimeDigest("fixture-principal"),
      authorization_action_type: null,
    },
  };
}

/** Builds one exact durable graph for low-level runtime tests. */
export function runtimePlanningGraph(
  input: CapabilityPlanningRequestV1,
  broker: CapabilityEffectBrokerV1,
  now = "2026-08-25T00:00:00.000Z",
): CapabilityDurablePlanningGraphV1 {
  const graph = buildCapabilityPlanningGraph(runtimePlanningRequest(input), broker, now, "durable");
  retainedGraphs.set(capabilityActionPlanDigest(graph.action_plan), graph);
  return graph;
}

export function runtimeAuthority(
  overrides: Partial<CapabilityRuntimeAuthorityV1> = {},
): CapabilityRuntimeAuthorityV1 {
  return {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: runtimeDigest("scope"),
    authority_epoch: 7,
    authority_head_digest: runtimeDigest("authority-head"),
    policy_digest: runtimeDigest("policy"),
    grant_digest: runtimeDigest("grant"),
    permission_digest: runtimeDigest("prior-permissions"),
    source_authority_set_digest: runtimeDigest("source-set"),
    ...overrides,
  };
}

export function resolvedRolePackage(
  manifestMutator?: (manifest: CapabilityManifestV1) => void,
): ResolvedCapabilityPackageV1 {
  const fixture = roleManifest();
  const manifest = structuredClone(fixture.manifest);
  manifestMutator?.(manifest);
  const sourceBytes = canonicalJsonBytes(manifest);
  const files = new Map(fixture.files);
  files.set("capability.json", sourceBytes);
  const tree = computePackageTree([...files].map(([path, bytes]) => ({ path, bytes })));
  const parsed = parseCapabilityManifest(sourceBytes, tree.files);
  const manifestDigest = parsed.manifest_digest;
  const pin = createPackagePin({
    id: manifest.id,
    version: manifest.version,
    source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/acme.reviewer" },
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
    secret_input_ids: [],
    private_input_binding_digest: runtimeDigest("empty-private-input"),
    source_authority_binding_digest: runtimeDigest("source-authority"),
  };
}

export function retainRuntimePackageCache(
  storage: CapabilityStorageV1,
  pkg: ResolvedCapabilityPackageV1,
  legacyInspectionEvidence: unknown | null = null,
): void {
  const tree = computePackageTree([...pkg.files].map(([path, bytes]) => ({ path, bytes })));
  const manifest = parseCapabilityManifest(
    tree.files.get("capability.json") as Uint8Array,
    tree.files,
  );
  const held = storage.acquire(`retain-runtime-package-${pkg.pin.pin_digest}`);
  try {
    retainCapabilityPackageCache(
      {
        pin: pkg.pin,
        tree,
        manifest,
        authenticity: pkg.authenticity_binding,
        registry_envelope: null,
        legacy_inspection_evidence: legacyInspectionEvidence,
      },
      {
        private_root: storage.paths.privateRoot,
        scope: storage.paths.scope,
        scope_identity_digest: storage.scopeIdentityDigest,
        lock: held.processLock,
      },
    );
  } finally {
    held.release();
  }
}

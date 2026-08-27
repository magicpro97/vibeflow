import { CAPABILITY_SOURCE_KIND } from "../../actions/capability-security-contract.js";
import { ACTION_EFFECT_CLASS } from "../../actions/public-action-contract.js";
import type { ActionRequestAuthorityV1, EngineName } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import type { FilesystemCapabilityPackageCacheV1 } from "../source/package-cache-reader.js";
import { bytewise } from "../wire/primitives.js";
import type {
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
  CapabilitySourceAccessDescriptorV1,
  CapabilitySourceAccessRequestContextV1,
} from "./execution-types.js";
import type { CapabilityHostActionV1, ResolvedCapabilityPackageV1 } from "./types.js";

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export function capabilitySourceRequestContext(input: {
  action: CapabilityHostActionV1;
  planningOptions: import("../../actions/types.js").ActionPlanningOptionsV1;
  authority: ActionRequestAuthorityV1;
  origin: "conversation" | "standalone";
}): CapabilitySourceAccessRequestContextV1 {
  return {
    schema_version: "1.0",
    origin: input.origin,
    planning_options: structuredClone(input.planningOptions),
    interactivity:
      input.authority.actor.credential_class === "automation-grant"
        ? "background"
        : "foreground-control",
    requested_by: structuredClone(input.authority.actor),
    principal_digest: input.authority.principal_digest,
    authorization_action_type: input.action.type,
  };
}

export function materializeCachedPackageSourceExecution(input: {
  cache: FilesystemCapabilityPackageCacheV1;
  pkg: ResolvedCapabilityPackageV1;
  requestContext: CapabilitySourceAccessRequestContextV1;
  targetEngines: EngineName[];
  policyDigest: string;
  now: string;
  legacyCandidateDigest: string | null;
}): ResolvedCapabilityPackageV1 {
  const proof = input.cache.executionAuthority(input.pkg.pin.pin_digest);
  if (
    proof.resolved.manifest_digest !== input.pkg.manifest_digest ||
    proof.record.authenticity_digest !== input.pkg.authenticity_binding.authenticity_digest
  )
    throw new CapabilityRuntimeError(
      "package source proof changed during intent materialization",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  const credentialDraft = {
    schema_version: "1.0" as const,
    scope: proof.record.scope,
    scope_identity_digest: proof.record.scope_identity_digest,
    principal_digest: input.requestContext.principal_digest,
    kind: "none" as const,
  };
  const credential = {
    ...credentialDraft,
    binding_digest: digestV1("VF-SOURCE-ACCESS-CREDENTIAL-BINDING\0v1\0", credentialDraft),
  };
  const source = proof.record.package_pin.source;
  const locator: CapabilitySourceAccessDescriptorV1["source"] =
    source.kind === CAPABILITY_SOURCE_KIND.REGISTRY
      ? {
          kind: CAPABILITY_SOURCE_KIND.REGISTRY,
          registry_origin: source.registry_origin,
          package_url: source.source_url,
        }
      : source.kind === CAPABILITY_SOURCE_KIND.GIT
        ? {
            kind: CAPABILITY_SOURCE_KIND.GIT,
            canonical_url: source.canonical_url,
            commit_oid: source.commit_oid,
          }
        : source.kind === CAPABILITY_SOURCE_KIND.LOCAL_DEV
          ? {
              kind: CAPABILITY_SOURCE_KIND.LOCAL_DEV,
              repo_relative_alias: source.repo_relative_alias,
            }
          : input.legacyCandidateDigest
            ? {
                kind: CAPABILITY_SOURCE_KIND.LEGACY_ADOPT,
                phase: "candidate",
                candidate_digest: input.legacyCandidateDigest,
              }
            : (() => {
                throw new CapabilityRuntimeError(
                  "legacy package cache lacks retained candidate source authority",
                  CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
                );
              })();
  const descriptorDraft = {
    schema_version: "1.0" as const,
    request_context: structuredClone(input.requestContext),
    intent: "read-local-package" as const,
    authorization_mode: "automatic" as const,
    target_engines: [...new Set(input.targetEngines)].sort(bytewise),
    source: locator,
    credential,
    expected_content_sha256: proof.record.package_pin.content_sha256,
    network_policy_profile: null,
    max_response_bytes: proof.record.tree_expanded_byte_length,
    cache_write: false as const,
    required_permission_row_digests: [] as string[],
  };
  const descriptor: CapabilitySourceAccessDescriptorV1 = {
    ...descriptorDraft,
    descriptor_digest: digestV1("VF-SOURCE-ACCESS-DESCRIPTOR\0v1\0", descriptorDraft),
  };
  const authorityDraft = {
    schema_version: "1.0" as const,
    scope: proof.record.scope,
    scope_identity_digest: proof.record.scope_identity_digest,
    source_descriptor_digest: descriptor.descriptor_digest,
    effect_classes: [ACTION_EFFECT_CLASS.PURE_LOCAL_READ],
    authorization: {
      kind: "confirmation-free" as const,
      reason: ACTION_EFFECT_CLASS.PURE_LOCAL_READ,
    },
    policy_digest: input.policyDigest,
  };
  const authority: CapabilitySourceAccessAuthorityBindingV1 = {
    ...authorityDraft,
    binding_digest: digestV1("VF-SOURCE-ACCESS-AUTHORITY\0v1\0", authorityDraft),
  };
  const expiresAt = input.pkg.authenticity_binding.registry_signature
    ? new Date(
        Math.min(
          Date.parse(input.pkg.authenticity_binding.registry_signature.statement_expires_at),
          Date.parse(input.now) + 5 * 60_000,
        ),
      ).toISOString()
    : plus(input.now, 5 * 60_000);
  const resolvedDraft = {
    schema_version: "1.0" as const,
    scope: proof.record.scope,
    scope_identity_digest: proof.record.scope_identity_digest,
    authenticity_digest: proof.record.authenticity_digest,
    trust_epoch: proof.trust.trust_epoch,
    trust_head_digest: proof.trust.trust_head_digest,
    source_access_authority_digest: authority.binding_digest,
    resolved_at: input.now,
    expires_at: expiresAt,
  };
  const resolved: CapabilityResolvedSourceAuthorityBindingV1 = {
    ...resolvedDraft,
    binding_digest: digestV1("VF-RESOLVED-SOURCE-AUTHORITY\0v1\0", resolvedDraft),
  };
  return {
    ...input.pkg,
    source_authority_binding_digest: resolved.binding_digest,
    source_execution: { descriptor, authority, resolved },
  };
}

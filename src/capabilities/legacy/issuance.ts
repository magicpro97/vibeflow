import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ActionConflictError,
  type PrivateActionRootLocatorV1,
  actionIdempotencyKeyDigest,
} from "../../actions/index.js";
import { validateLegacyCandidate } from "../../actions/internal-candidate-validation.js";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  acquireProcessLock,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import type { FilesystemCapabilityPackageCacheV1 } from "../source/package-cache-reader.js";
import { retainCapabilityPackageCache } from "../source/package-cache-writer.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "../wire/cli.js";
import { CapabilityValidationError, digest, timestamp } from "../wire/primitives.js";
import {
  inspectLegacyAdoptCandidateMaterializations,
  projectLegacyAdoptInspection,
} from "./inspection.js";
import {
  type LegacyAdoptActionRootLocatorV1,
  type LegacyAdoptInspectionAuthorityV1,
  type LegacyAdoptInspectionIssuanceV1,
  type LegacyAdoptInspectionResultV1,
  legacyAdoptInspectionIssuanceDigest,
  legacyAdoptInspectionRequestDigest,
  legacyAdoptIssuanceFileKey,
  legacyAdoptIssuanceScopeDigest,
  validateLegacyAdoptInspectionIssuance,
} from "./issuance-record.js";
import { validateLegacyAdoptInspectionRequest } from "./request-validation.js";
import type {
  LegacyAdoptClaimAuthorityV1,
  LegacyAdoptInspectionRequestV1,
  LegacyAdoptScanRequestV1,
  LegacyMarkerReaderV1,
} from "./types.js";

const MAX_RECORD = 8 * 1024 * 1024;

export interface LegacyAdoptActionRootResolverV1 {
  resolve(locator: LegacyAdoptActionRootLocatorV1): string;
}

export interface LegacyAdoptInspectionIssuerOptionsV1 {
  storage: CapabilityStorageV1;
  packages: FilesystemCapabilityPackageCacheV1;
  markers: LegacyMarkerReaderV1;
  claims: LegacyAdoptClaimAuthorityV1;
  actionRoots: LegacyAdoptActionRootResolverV1;
  now: () => string;
}

function canonicalRecord<T>(path: string, label: string): T | null {
  const bytes = privateFileBytes(path, MAX_RECORD);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: MAX_RECORD })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return value as T;
}

function issuancePath(root: string, fileKey: string): string {
  return join(
    root,
    "actions",
    "v1",
    "legacy-adopt-inspection-idempotency",
    `${digestHex(fileKey)}.json`,
  );
}

function candidatePath(root: string, candidateId: string): string {
  return join(root, "actions", "v1", "legacy-adopt-candidates", `${candidateId}.json`);
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function candidateRefs(candidates: readonly StrictLegacyAdoptCandidateV1[]) {
  return candidates.map(({ candidate_id, candidate_digest }) => ({
    candidate_id,
    candidate_digest,
  }));
}

export class LegacyAdoptInspectionIssuerV1 {
  constructor(readonly options: LegacyAdoptInspectionIssuerOptionsV1) {}

  inspect(
    requestValue: LegacyAdoptInspectionRequestV1,
    authority: LegacyAdoptInspectionAuthorityV1,
  ): LegacyAdoptInspectionResultV1 {
    const request = validateLegacyAdoptInspectionRequest(requestValue);
    if (request.scope !== this.options.storage.paths.scope)
      throw new CapabilityValidationError("inspection scope is not owned by this service", "scope");
    const principalDigest = digest(authority.principal_digest, "authority.principal_digest");
    const locator = this.locator(authority.action_root_locator, request.scope);
    const root = realpathSync(this.options.actionRoots.resolve(locator));
    if (root !== resolve(root))
      throw new CapabilityValidationError(
        "action root is not canonical",
        "action_root",
        "integrity_failure",
      );
    const idempotencyKeyDigest = actionIdempotencyKeyDigest(request.idempotency_key);
    const issuanceScopeDigest = legacyAdoptIssuanceScopeDigest(
      locator,
      request.scope,
      this.options.storage.scopeIdentityDigest,
    );
    const fileKey = legacyAdoptIssuanceFileKey({
      principal_digest: principalDigest,
      issuance_scope_digest: issuanceScopeDigest,
      idempotency_key_digest: idempotencyKeyDigest,
    });
    const requestDigest = legacyAdoptInspectionRequestDigest(request);
    const replay = this.readReplay({
      root,
      fileKey,
      principalDigest,
      issuanceScopeDigest,
      idempotencyKeyDigest,
      requestDigest,
      request,
    });
    if (replay) return { created: false, response: replay };

    const inspectedAt = this.options.now();
    timestamp(inspectedAt, "inspected_at");
    const scan: LegacyAdoptScanRequestV1 = {
      schema_version: "1.0",
      scope: request.scope,
      scope_identity_digest: this.options.storage.scopeIdentityDigest,
      sources: request.legacy_sources,
    };
    const materialized = inspectLegacyAdoptCandidateMaterializations(
      { ...scan, markers: this.options.markers.scan(scan) },
      inspectedAt,
    );
    const candidates = materialized.map((item) => item.candidate);
    const response = projectLegacyAdoptInspection(scan, inspectedAt, candidates);
    const issuanceDraft = {
      schema_version: "1.0" as const,
      principal_digest: principalDigest,
      issuance_scope_digest: issuanceScopeDigest,
      idempotency_key_digest: idempotencyKeyDigest,
      request_digest: requestDigest,
      scope: request.scope,
      scope_identity_digest: this.options.storage.scopeIdentityDigest,
      legacy_sources: request.legacy_sources,
      inspected_at: response.inspected_at,
      expires_at: response.expires_at,
      candidate_set_digest: response.candidate_set_digest,
      candidates: candidateRefs(candidates),
    };
    const issuance = validateLegacyAdoptInspectionIssuance({
      ...issuanceDraft,
      issuance_digest: legacyAdoptInspectionIssuanceDigest(issuanceDraft),
    });
    const scopeLock = this.options.storage.acquire(`legacy-adopt-inspect:${digestHex(fileKey)}`);
    try {
      for (const item of materialized)
        retainCapabilityPackageCache(item.publication, {
          private_root: this.options.storage.paths.privateRoot,
          scope: request.scope,
          scope_identity_digest: this.options.storage.scopeIdentityDigest,
          lock: scopeLock.processLock,
        });
    } finally {
      scopeLock.release();
    }

    const actionLock = acquireProcessLock(join(root, "actions", "v1", "writer.lock"), {
      operation: `legacy-adopt-inspection:${digestHex(fileKey)}`,
      coverageRoot: root,
    });
    try {
      const raced = this.readReplay({
        root,
        fileKey,
        principalDigest,
        issuanceScopeDigest,
        idempotencyKeyDigest,
        requestDigest,
        request,
      });
      if (raced) return { created: false, response: raced };
      for (const candidate of candidates)
        createOrVerifyPrivateFile(
          candidatePath(root, candidate.candidate_id),
          canonicalJsonBytes(candidate, { maxBytes: MAX_RECORD }),
          { lock: actionLock, maxBytes: MAX_RECORD },
        );
      createOrVerifyPrivateFile(
        issuancePath(root, fileKey),
        canonicalJsonBytes(issuance, { maxBytes: MAX_RECORD }),
        { lock: actionLock, maxBytes: MAX_RECORD },
      );
      return { created: true, response };
    } finally {
      actionLock.release();
    }
  }

  resolve(
    candidateRef: { candidate_id: string; candidate_digest: string },
    context: { scope: "project" | "user"; action_root_locator: LegacyAdoptActionRootLocatorV1 },
  ): StrictLegacyAdoptCandidateV1 {
    if (context.scope !== this.options.storage.paths.scope)
      throw new CapabilityValidationError("candidate scope is not owned by this service", "scope");
    const root = realpathSync(this.options.actionRoots.resolve(context.action_root_locator));
    const candidate = this.readCandidate(root, candidateRef.candidate_id, context.scope);
    if (candidate.candidate_digest !== candidateRef.candidate_digest)
      throw new CapabilityValidationError(
        "candidate digest mismatch",
        "candidate",
        "integrity_failure",
      );
    this.assertCached(candidate);
    const scan: LegacyAdoptScanRequestV1 = {
      schema_version: "1.0",
      scope: context.scope,
      scope_identity_digest: this.options.storage.scopeIdentityDigest,
      sources: [candidate.legacy_source],
    };
    const live = inspectLegacyAdoptCandidateMaterializations(
      { ...scan, markers: this.options.markers.scan(scan) },
      candidate.inspected_at,
    ).find(
      (item) =>
        item.candidate.candidate_id === candidate.candidate_id &&
        item.candidate.candidate_digest === candidate.candidate_digest &&
        exact(item.candidate, candidate),
    );
    if (!live)
      throw new CapabilityValidationError(
        "legacy candidate no longer matches fixed-root VF ownership evidence",
        "legacy candidate",
        "integrity_failure",
      );
    this.options.claims.stage(live.marker, candidate);
    return candidate;
  }

  private readReplay(input: {
    root: string;
    fileKey: string;
    principalDigest: string;
    issuanceScopeDigest: string;
    idempotencyKeyDigest: string;
    requestDigest: string;
    request: LegacyAdoptInspectionRequestV1;
  }): PublicLegacyAdoptInspectionResponseV1 | null {
    const raw = canonicalRecord<unknown>(
      issuancePath(input.root, input.fileKey),
      "legacy issuance",
    );
    if (!raw) return null;
    const issuance = validateLegacyAdoptInspectionIssuance(raw);
    const derivedKey = legacyAdoptIssuanceFileKey({
      principal_digest: issuance.principal_digest,
      issuance_scope_digest: issuance.issuance_scope_digest,
      idempotency_key_digest: issuance.idempotency_key_digest,
    });
    if (
      derivedKey !== input.fileKey ||
      issuance.principal_digest !== input.principalDigest ||
      issuance.issuance_scope_digest !== input.issuanceScopeDigest ||
      issuance.idempotency_key_digest !== input.idempotencyKeyDigest
    )
      throw new CapabilityValidationError(
        "legacy issuance path binding mismatch",
        "legacy issuance",
        "integrity_failure",
      );
    if (issuance.request_digest !== input.requestDigest)
      throw new ActionConflictError(
        "idempotency_conflict",
        "Idempotency key was used for another legacy inspection request.",
        input.fileKey,
      );
    const candidates = issuance.candidates.map((ref) => {
      const candidate = this.readCandidate(input.root, ref.candidate_id, issuance.scope);
      if (
        candidate.candidate_digest !== ref.candidate_digest ||
        candidate.scope_identity_digest !== issuance.scope_identity_digest ||
        candidate.inspected_at !== issuance.inspected_at ||
        candidate.expires_at !== issuance.expires_at
      )
        throw new CapabilityValidationError(
          "legacy issuance candidate binding mismatch",
          "legacy candidate",
          "integrity_failure",
        );
      this.assertCached(candidate);
      return candidate;
    });
    const response = projectLegacyAdoptInspection(
      {
        scope: issuance.scope,
        scope_identity_digest: issuance.scope_identity_digest,
        sources: issuance.legacy_sources,
      },
      issuance.inspected_at,
      candidates,
    );
    if (
      response.candidate_set_digest !== issuance.candidate_set_digest ||
      !exact(candidateRefs(candidates), issuance.candidates) ||
      response.expires_at !== issuance.expires_at ||
      !exact(input.request.legacy_sources, issuance.legacy_sources)
    )
      throw new CapabilityValidationError(
        "legacy issuance response closure mismatch",
        "legacy issuance",
        "integrity_failure",
      );
    return response;
  }

  private readCandidate(
    root: string,
    candidateId: string,
    scope: "project" | "user",
  ): StrictLegacyAdoptCandidateV1 {
    if (!/^vf-adopt-[a-f0-9]{64}$/.test(candidateId))
      throw new CapabilityValidationError("invalid legacy candidate ID", "candidate_id");
    const candidate = canonicalRecord<StrictLegacyAdoptCandidateV1>(
      candidatePath(root, candidateId),
      "legacy candidate",
    );
    if (!candidate)
      throw new CapabilityValidationError(
        "legacy candidate is missing",
        "legacy candidate",
        "integrity_failure",
      );
    validateLegacyCandidate(candidate, scope, "legacy candidate");
    return candidate;
  }

  private assertCached(candidate: StrictLegacyAdoptCandidateV1): void {
    const cached = this.options.packages.readByPin(candidate.synthetic_pin.pin_digest);
    if (
      !cached ||
      !exact(cached.pin, candidate.synthetic_pin) ||
      !exact(cached.manifest, candidate.synthetic_manifest)
    )
      throw new CapabilityValidationError(
        "legacy candidate cache closure is missing",
        "legacy candidate",
        "integrity_failure",
      );
  }

  private locator(
    value: PrivateActionRootLocatorV1,
    scope: "project" | "user",
  ): LegacyAdoptActionRootLocatorV1 {
    if (value.kind === "recovery-bootstrap")
      throw new CapabilityValidationError(
        "recovery bootstrap cannot inspect legacy state",
        "action_root_locator",
      );
    legacyAdoptIssuanceScopeDigest(value, scope, this.options.storage.scopeIdentityDigest);
    return structuredClone(value);
  }
}

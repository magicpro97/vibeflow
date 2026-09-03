import * as nodePath from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import {
  actionPlanDigest,
  validateActionPlan,
  validateAuthorityPlan,
  validateEffectPlan,
  validatePolicyInverse,
} from "./contracts.js";
import { OrdinaryAuthorityJournalStoreV1 } from "./journal-store.js";
import { validateSecretRevocationCandidate } from "./operation-contracts.js";
import {
  ORDINARY_AUTHORITY_STORE_LIMIT,
  authorityStoreFail,
  parseCanonicalAuthorityRecord,
} from "./state-store.js";
import type {
  AuthorityActionClosureWriteV1,
  AuthorityActionPlanBindingV1,
  AuthorityChangeEffectPlanV1,
  AuthorityChangePlanV1,
  PolicyAuthorityInverseDescriptorV1,
  SecretRevocationCandidateV1,
} from "./types.js";

export type { OrdinaryAuthorityRawStateV1 } from "./state-store.js";

export class OrdinaryAuthorityDurableStoreV1 extends OrdinaryAuthorityJournalStoreV1 {
  writeActionClosure(input: AuthorityActionClosureWriteV1): void {
    validateEffectPlan(input.effect);
    validateAuthorityPlan(input.plan);
    validateActionPlan(input.action_plan, input.plan);
    if (input.inverse) validatePolicyInverse(input.inverse);
    if (input.action_plan_digest !== actionPlanDigest(input.action_plan))
      authorityStoreFail("action plan digest changed before persistence", "authority.objects");
    const held = acquireProcessLock(
      nodePath.join(this.paths.privateRoot, "actions", "v1", "writer.lock"),
      {
        operation: "ordinary-authority-action-closure",
        coverageRoot: this.paths.privateRoot,
      },
    );
    try {
      if (
        (input.preimage_bytes === null) !== (input.replacement_bytes === null) ||
        (input.inverse === null) !== (input.preimage_bytes === null)
      )
        authorityStoreFail("policy action closure blob nullability mismatch", "authority.objects");
      if (input.preimage_bytes && input.replacement_bytes && input.inverse) {
        this.writeActionBlob(
          input.effect.private_preimage_content_digest as string,
          input.preimage_bytes,
          held,
        );
        this.writeActionBlob(
          input.effect.private_replacement_content_digest as string,
          input.replacement_bytes,
          held,
        );
        this.writeActionObject(input.inverse.descriptor_digest, input.inverse, held);
      }
      this.writeActionObject(input.effect.plan_digest, input.effect, held);
      this.writeActionObject(input.plan.plan_digest, input.plan, held);
      this.writeActionObject(input.action_plan_digest, input.action_plan, held);
    } finally {
      held.release();
    }
  }

  readActionObject<T>(digest: string, label: string): T {
    return parseCanonicalAuthorityRecord<T>(
      privateFileBytes(
        nodePath.join(
          this.paths.privateRoot,
          "actions",
          "v1",
          "objects",
          `${digestHex(digest)}.json`,
        ),
        ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
      ),
      label,
    );
  }

  readActionBlob(digest: string, label: string): Buffer {
    const bytes = privateFileBytes(
      nodePath.join(this.paths.privateRoot, "actions", "v1", "blobs", `${digestHex(digest)}.bin`),
      ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
    );
    if (!bytes) return authorityStoreFail(`${label} is missing`, label);
    return bytes;
  }

  readSecretCandidate(privateBindingId: string): SecretRevocationCandidateV1 {
    if (!/^vf-secret-revocation-binding-[a-f0-9]{64}$/u.test(privateBindingId))
      return authorityStoreFail(
        "invalid secret revocation candidate ID",
        "secret_candidate.private_binding_id",
      );
    const candidate = parseCanonicalAuthorityRecord<SecretRevocationCandidateV1>(
      privateFileBytes(
        nodePath.join(
          this.paths.privateRoot,
          "actions",
          "v1",
          "secret-revocation-candidates",
          `${privateBindingId}.json`,
        ),
        ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES,
      ),
      "secret revocation candidate",
    );
    return validateSecretRevocationCandidate(candidate);
  }

  private writeActionObject(
    digest: string,
    value: unknown,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    createOrVerifyPrivateFile(
      nodePath.join(
        this.paths.privateRoot,
        "actions",
        "v1",
        "objects",
        `${digestHex(digest)}.json`,
      ),
      canonicalJsonBytes(value),
      { lock, maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES },
    );
  }

  private writeActionBlob(
    digest: string,
    bytes: Uint8Array,
    lock: import("../../durability/index.js").ProcessLock,
  ): void {
    createOrVerifyPrivateFile(
      nodePath.join(this.paths.privateRoot, "actions", "v1", "blobs", `${digestHex(digest)}.bin`),
      bytes,
      { lock, maxBytes: ORDINARY_AUTHORITY_STORE_LIMIT.JSON_BYTES },
    );
  }
}

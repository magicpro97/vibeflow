import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { validateGrantedPermissionBinding } from "../../src/capabilities/authority/binding-validation.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  foldGrantFrames,
  foldPolicyFrames,
  foldSecretRevocations,
  foldTrustFrames,
  grantFrameDigest,
  grantStateDigest,
  policyAuthorityFrameDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
  secretRevocationStateDigest,
  validateAuthorityEvent,
  validateAuthorityHead,
  validateAuthorityIdentity,
  validateGrantFrame,
  validatePolicyFrame,
  validateSecretRevocationFrame,
  validateTrustFrame,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityLogicalStateV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../../src/capabilities/authority/index.js";
import { validateActionRootLocator } from "../../src/capabilities/authority/shapes.js";
import type { GrantedPermissionBindingV1 } from "../../src/capabilities/permissions/types.js";
import { grantedPermissionBindingDigest } from "../../src/capabilities/permissions/witness.js";
import { digestV1 } from "../../src/durability/index.js";

const scopeIdentity = digestV1("VF-AUTHORITY-COVERAGE-SCOPE\0v1\0", 1);
const operationId = "operation";
const proposalId = "proposal";
const approvalId = "approval";
const planDigest = digestV1("VF-AUTHORITY-COVERAGE-PLAN\0v1\0", 1);
const headerDigest = digestV1("VF-AUTHORITY-COVERAGE-HEADER\0v1\0", 1);
const recordedAt = "2026-01-01T00:00:00.000Z";
const locator = {
  kind: "capability" as const,
  scope: "project" as const,
  scope_identity_digest: scopeIdentity,
};

function permission(permissionId = "acme.pkg/read"): GrantedPermissionBindingV1 {
  const draft: GrantedPermissionBindingV1 = {
    schema_version: "1.0",
    permission_id: permissionId,
    kind: "filesystem",
    scope: { root: "project", access: "read", path_prefix: "src" },
    target_ids: ["codex"],
    enforcement: "sandboxed",
    binding_digest: "",
  };
  return { ...draft, binding_digest: grantedPermissionBindingDigest(draft) };
}

function grantFrame(
  transition: GrantFrameV1["transition"],
  previous: GrantFrameV1 | null = null,
  overrides: Partial<GrantFrameV1> = {},
): GrantFrameV1 {
  const draft: GrantFrameV1 = {
    schema_version: "1.0",
    frame_id: "",
    previous_frame_digest: previous?.frame_digest ?? null,
    grant_sequence: (previous?.grant_sequence ?? 0) + 1,
    authority_epoch: (previous?.authority_epoch ?? 0) + 1,
    operation_id: operationId,
    proposal_id: proposalId,
    approval_id: approvalId,
    plan_digest: planDigest,
    action_root_locator: locator,
    operation_header_digest: headerDigest,
    transition,
    grant_id: previous?.grant_id ?? "grant-a",
    scope: "project",
    scope_identity_digest: scopeIdentity,
    principal: previous?.principal ?? {
      public_actor_id: "actor",
      credential_class: "interactive-tty",
    },
    action_types: previous?.action_types ?? ["capability.install"],
    permissions: previous?.permissions ?? [permission()],
    target_engines: previous?.target_engines ?? ["codex"],
    acted_by: {
      kind: "human-cli",
      public_actor_id: "actor",
      credential_class: "interactive-tty",
    },
    recorded_at: recordedAt,
    not_before: previous?.not_before ?? "2026-01-01T00:00:00.000Z",
    expires_at: previous?.expires_at ?? "2027-01-01T00:00:00.000Z",
    revoked_at: transition === "revoked" ? "2026-06-01T00:00:00.000Z" : null,
    reason_digest: transition === "issued" ? null : digestV1("VF-REASON\0v1\0", transition),
    frame_digest: "",
    ...overrides,
  };
  const digest = grantFrameDigest(draft);
  return {
    ...draft,
    frame_id: `vf-grant-frame-${digest.slice(7)}`,
    frame_digest: digest,
  };
}

function secretFrame(
  previous: SecretRevocationFrameV1 | null = null,
  suffix = "a",
  overrides: Partial<SecretRevocationFrameV1> = {},
): SecretRevocationFrameV1 {
  const draft: SecretRevocationFrameV1 = {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: scopeIdentity,
    sequence: (previous?.sequence ?? -1) + 1,
    previous_frame_digest: previous?.frame_digest ?? null,
    authority_epoch: (previous?.authority_epoch ?? 0) + 1,
    operation_id: operationId,
    proposal_id: proposalId,
    approval_id: approvalId,
    plan_digest: planDigest,
    action_root_locator: locator,
    operation_header_digest: headerDigest,
    secret_handle_id_digest: digestV1("VF-SECRET-HANDLE\0v1\0", suffix),
    expected_binding_digest: digestV1("VF-SECRET-BINDING\0v1\0", suffix),
    revoked_by: {
      kind: "human-cli",
      public_actor_id: "actor",
      credential_class: "interactive-tty",
    },
    revoked_at: recordedAt,
    reason_digest: null,
    frame_digest: "",
    ...overrides,
  };
  return { ...draft, frame_digest: secretRevocationFrameDigest(draft) };
}

function policyGroup(
  authorityEpoch: number,
  previous: PolicyAuthorityFrameV1 | null,
  priorPolicyDigest: string,
  replacementPolicyDigest: string,
): PolicyAuthorityFrameV1[] {
  const frames: PolicyAuthorityFrameV1[] = [];
  for (const state of ["prepared", "effect_in_progress", "observed"] as const) {
    const prior = frames.at(-1) ?? previous;
    const sequence = (prior?.sequence ?? -1) + 1;
    const draft: PolicyAuthorityFrameV1 = {
      schema_version: "1.0",
      sequence,
      previous_frame_digest: prior?.frame_digest ?? null,
      authority_epoch: authorityEpoch,
      operation_id: operationId,
      proposal_id: proposalId,
      approval_id: approvalId,
      plan_digest: planDigest,
      action_root_locator: locator,
      operation_header_digest: headerDigest,
      scope: "project",
      scope_identity_digest: scopeIdentity,
      settings_schema_version: "1.0",
      state,
      expected_settings_sha256: "a".repeat(64),
      expected_settings_byte_length: 10,
      private_preimage_content_digest: digestV1("VF-POLICY-PREIMAGE\0v1\0", authorityEpoch),
      replacement_settings_sha256: "b".repeat(64),
      replacement_settings_byte_length: 11,
      private_replacement_content_digest: digestV1("VF-POLICY-REPLACEMENT\0v1\0", authorityEpoch),
      prior_policy_digest: priorPolicyDigest,
      replacement_policy_digest: replacementPolicyDigest,
      private_preimage_ref: `actions/v1/objects/preimage-${authorityEpoch}.json`,
      private_replacement_ref: `actions/v1/objects/replacement-${authorityEpoch}.json`,
      observed_settings_sha256: state === "observed" ? "b".repeat(64) : null,
      recorded_at: `2026-01-01T00:00:0${sequence}.000Z`,
      frame_digest: "",
    };
    frames.push({ ...draft, frame_digest: policyAuthorityFrameDigest(draft) });
  }
  return frames;
}

function trustFrame(
  transition: RegistryTrustKeyFrameV1["transition"] = "added",
  previous: RegistryTrustKeyFrameV1 | null = null,
  overrides: Partial<RegistryTrustKeyFrameV1> = {},
): RegistryTrustKeyFrameV1 {
  const pair = generateKeyPairSync("ed25519");
  const keyBytes = pair.publicKey.export({ format: "der", type: "spki" });
  const inherited = previous
    ? {
        key_id: previous.key_id,
        public_key_spki_base64: previous.public_key_spki_base64,
        registry_origin: previous.registry_origin,
        publisher_id: previous.publisher_id,
        valid_from: previous.valid_from,
        valid_until: previous.valid_until,
      }
    : {
        key_id: `sha256:${createHash("sha256").update(keyBytes).digest("hex")}`,
        public_key_spki_base64: keyBytes.toString("base64"),
        registry_origin: "https://registry.example",
        publisher_id: "acme",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_until: "2028-01-01T00:00:00.000Z",
      };
  const draft: RegistryTrustKeyFrameV1 = {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: scopeIdentity,
    previous_frame_digest: previous?.frame_digest ?? null,
    trust_epoch: (previous?.trust_epoch ?? 0) + 1,
    authority_epoch: (previous?.authority_epoch ?? 0) + 1,
    operation_id: operationId,
    proposal_id: proposalId,
    approval_id: approvalId,
    plan_digest: planDigest,
    action_root_locator: locator,
    operation_header_digest: headerDigest,
    transition,
    algorithm: "Ed25519",
    ...inherited,
    reason_digest: transition === "added" ? null : digestV1("VF-TRUST-REASON\0v1\0", transition),
    recorded_at: recordedAt,
    frame_digest: "",
    ...overrides,
  };
  return { ...draft, frame_digest: registryTrustFrameDigest(draft) };
}

function logicalState(head: AuthorityEpochHeadV1): AuthorityLogicalStateV1 {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

function emptyHead(): AuthorityEpochHeadV1 {
  const draft: AuthorityEpochHeadV1 = {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: scopeIdentity,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: grantStateDigest("project", scopeIdentity, null, new Map()),
    policy_head_digest: null,
    policy_digest: digestV1("VF-POLICY\0v1\0", 0),
    secret_revocation_digest: secretRevocationStateDigest("project", scopeIdentity, null),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: recordedAt,
    content_digest: "",
  };
  return { ...draft, content_digest: authorityEpochHeadDigest(draft) };
}

function event(
  prior: AuthorityEpochHeadV1,
  change: AuthorityEpochEventV1["change"],
  nextState: AuthorityLogicalStateV1,
  overrides: Partial<AuthorityEpochEventV1> = {},
): AuthorityEpochEventV1 {
  const draft: AuthorityEpochEventV1 = {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: scopeIdentity,
    authority_epoch: prior.authority_epoch + 1,
    previous_event_digest: prior.event_head_digest,
    previous_head_digest: prior.content_digest,
    previous_head_checkpoint_digest: prior.content_digest,
    change,
    prior_state: logicalState(prior),
    next_state: nextState,
    proposal_id: proposalId,
    approval_id: approvalId,
    operation_id: operationId,
    plan_digest: planDigest,
    action_root_locator: locator,
    operation_header_digest: headerDigest,
    recorded_at: recordedAt,
    event_digest: "",
    ...overrides,
  };
  return { ...draft, event_digest: authorityEpochEventDigest(draft) };
}

describe("capability authority behavioral coverage", () => {
  test("folds issued, renewed, and revoked grants as a dense terminal journal", () => {
    const issued = grantFrame("issued");
    const renewed = grantFrame("renewed", issued);
    const revoked = grantFrame("revoked", renewed);
    const folded = foldGrantFrames([issued, renewed, revoked], "project", scopeIdentity);
    expect(folded.latest.get("grant-a")?.transition).toBe("revoked");

    expect(() => foldGrantFrames([grantFrame("renewed")], "project", scopeIdentity)).toThrow(
      "invalid predecessor",
    );
    expect(() =>
      foldGrantFrames([issued, grantFrame("issued", issued)], "project", scopeIdentity),
    ).toThrow("invalid predecessor");
    expect(() =>
      foldGrantFrames(
        [issued, renewed, revoked, grantFrame("renewed", revoked)],
        "project",
        scopeIdentity,
      ),
    ).toThrow("terminal");
    expect(() =>
      foldGrantFrames(
        [
          issued,
          renewed,
          grantFrame("revoked", renewed, { expires_at: "2028-01-01T00:00:00.000Z" }),
        ],
        "project",
        scopeIdentity,
      ),
    ).toThrow("repeat the prior full state");
    expect(() =>
      foldGrantFrames(
        [issued, grantFrame("renewed", issued, { grant_sequence: 3 })],
        "project",
        scopeIdentity,
      ),
    ).toThrow("dense/chained");
    expect(() =>
      foldGrantFrames(
        [issued, grantFrame("renewed", issued, { authority_epoch: issued.authority_epoch })],
        "project",
        scopeIdentity,
      ),
    ).toThrow("epochs must increase");
    const userOwned = grantFrame("issued", null, {
      scope: "user",
      action_root_locator: {
        kind: "capability",
        scope: "user",
        scope_identity_digest: scopeIdentity,
      },
    });
    expect(() => foldGrantFrames([userOwned], "project", scopeIdentity)).toThrow(
      "wrong authority scope",
    );
  });

  test("validates grants and permission witnesses fail closed", () => {
    const valid = grantFrame("issued");
    expect(() => validateGrantFrame(valid)).not.toThrow();
    expect(() => validateGrantedPermissionBinding(permission(), "permission")).not.toThrow();

    const invalidBinding = permission();
    invalidBinding.binding_digest = digestV1("VF-WRONG\0v1\0", 1);
    expect(() => validateGrantedPermissionBinding(invalidBinding, "permission")).toThrow(
      "digest mismatch",
    );
    expect(() =>
      validateGrantedPermissionBinding({ ...permission(), target_ids: [] }, "permission"),
    ).toThrow("target set is empty");
    expect(() =>
      validateGrantedPermissionBinding(
        { ...permission(), schema_version: "2.0" as never },
        "permission",
      ),
    ).toThrow("unsupported granted permission schema");

    expect(() => validateGrantFrame(grantFrame("issued", null, { grant_id: "!invalid" }))).toThrow(
      "invalid grant ID",
    );
    expect(() =>
      validateGrantFrame(grantFrame("issued", null, { expires_at: "2025-01-01T00:00:00.000Z" })),
    ).toThrow("expiry must follow");
    expect(() =>
      validateGrantFrame(grantFrame("issued", null, { revoked_at: recordedAt })),
    ).toThrow("timestamp nullability");
    const wrongDigest = { ...valid, frame_digest: digestV1("VF-WRONG-GRANT\0v1\0", 1) };
    expect(() => validateGrantFrame(wrongDigest)).toThrow("identity/digest mismatch");
    expect(() =>
      validateGrantFrame(
        grantFrame("issued", null, {
          permissions: [permission("acme.pkg/a"), permission("acme.pkg/b")],
        }),
      ),
    ).not.toThrow();
  });

  test("folds distinct secret revocations and rejects replay or foreign ownership", () => {
    const first = secretFrame();
    const second = secretFrame(first, "b");
    expect(foldSecretRevocations([first, second], "project", scopeIdentity)).toStartWith("sha256:");
    expect(() =>
      foldSecretRevocations([first, secretFrame(first, "a")], "project", scopeIdentity),
    ).toThrow("duplicate secret revocation");
    expect(() =>
      foldSecretRevocations([secretFrame(null, "a", { sequence: 1 })], "project", scopeIdentity),
    ).toThrow("dense/chained/owned");
    const foreign = secretFrame(null, "a", {
      scope: "user",
      action_root_locator: {
        kind: "capability",
        scope: "user",
        scope_identity_digest: scopeIdentity,
      },
    });
    expect(() => foldSecretRevocations([foreign], "project", scopeIdentity)).toThrow(
      "dense/chained/owned",
    );
    expect(() => validateSecretRevocationFrame({ ...first, frame_digest: headerDigest })).toThrow(
      "digest mismatch",
    );
  });

  test("validates identity, head, event checkpoint, and exact repair transitions", () => {
    for (const scope of ["project", "user"] as const) {
      const draft: AuthorityScopeIdentityRecordV1 = {
        schema_version: "1.0",
        scope,
        identity_id:
          scope === "project"
            ? `vf-project-${"a".repeat(64)}`
            : `vf-user-authority-${"b".repeat(64)}`,
        created_at: recordedAt,
        content_digest: "",
      };
      const identity = { ...draft, content_digest: authorityScopeIdentityDigest(draft) };
      expect(() => validateAuthorityIdentity(identity)).not.toThrow();
    }
    const badIdentity = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      identity_id: `vf-user-authority-${"a".repeat(64)}`,
      created_at: recordedAt,
      content_digest: headerDigest,
    };
    expect(() => validateAuthorityIdentity(badIdentity)).toThrow("does not match scope");
    const validIdentityDraft: AuthorityScopeIdentityRecordV1 = {
      schema_version: "1.0",
      scope: "project",
      identity_id: `vf-project-${"c".repeat(64)}`,
      created_at: recordedAt,
      content_digest: headerDigest,
    };
    expect(() => validateAuthorityIdentity(validIdentityDraft)).toThrow("identity digest mismatch");

    expect(() =>
      validateActionRootLocator({ kind: "conversation", root_session_id: "session" }, "locator"),
    ).not.toThrow();
    expect(() =>
      validateActionRootLocator(
        { kind: "recovery-bootstrap", bootstrap_identity_digest: headerDigest },
        "locator",
      ),
    ).not.toThrow();

    const prior = emptyHead();
    const repair = event(prior, "authority-repaired", logicalState(prior));
    const repaired = applyAuthorityEvent(prior, repair, {
      change: "authority-repaired",
      checkpoint_head: prior,
    });
    expect(repaired.authority_epoch).toBe(1);
    expect(() => validateAuthorityHead(repaired)).not.toThrow();
    const trustMismatchHeadDraft = {
      ...prior,
      trust_epoch: 1,
      content_digest: "",
    };
    const trustMismatchHead = {
      ...trustMismatchHeadDraft,
      content_digest: authorityEpochHeadDigest(trustMismatchHeadDraft),
    };
    expect(() => validateAuthorityHead(trustMismatchHead)).toThrow("trust head/epoch");
    expect(() => validateAuthorityHead({ ...prior, content_digest: headerDigest })).toThrow(
      "head digest mismatch",
    );

    const otherDraft = { ...prior, updated_at: "2026-01-02T00:00:00.000Z", content_digest: "" };
    const other = { ...otherDraft, content_digest: authorityEpochHeadDigest(otherDraft) };
    expect(() =>
      applyAuthorityEvent(prior, repair, { change: "authority-repaired", checkpoint_head: other }),
    ).toThrow("exact prior head");
    expect(() =>
      applyAuthorityEvent(prior, repair, { change: "grant-changed", grant_frames: [] }),
    ).toThrow("evidence kind mismatch");

    const wrongPrior = event(prior, "authority-repaired", logicalState(prior), {
      prior_state: { ...logicalState(prior), grant_digest: headerDigest },
    });
    expect(() =>
      applyAuthorityEvent(prior, wrongPrior, {
        change: "authority-repaired",
        checkpoint_head: prior,
      }),
    ).toThrow("prior state");
    const wrongChange = event(prior, "authority-repaired", {
      ...logicalState(prior),
      grant_digest: headerDigest,
    });
    expect(() =>
      applyAuthorityEvent(prior, wrongChange, {
        change: "authority-repaired",
        checkpoint_head: prior,
      }),
    ).toThrow("wrong logical state fields");

    expect(() =>
      validateAuthorityEvent({ ...repair, previous_head_checkpoint_digest: headerDigest }),
    ).toThrow("checkpoint must address");
    expect(() => validateAuthorityEvent({ ...repair, event_digest: headerDigest })).toThrow(
      "event digest mismatch",
    );
    const trustMismatch = event(prior, "authority-repaired", logicalState(prior), {
      prior_state: { ...logicalState(prior), trust_epoch: 1 },
    });
    expect(() => validateAuthorityEvent(trustMismatch)).toThrow("trust head/epoch mismatch");
    const skippedEpoch = event(prior, "authority-repaired", logicalState(prior), {
      authority_epoch: 2,
    });
    expect(() =>
      applyAuthorityEvent(prior, skippedEpoch, {
        change: "authority-repaired",
        checkpoint_head: prior,
      }),
    ).toThrow("does not extend exact current head");
  });

  test("folds complete policy groups and publishes exact staged policy evidence", () => {
    const prior = emptyHead();
    const firstDigest = digestV1("VF-POLICY\0v1\0", 1);
    const first = policyGroup(1, null, prior.policy_digest, firstDigest);
    const secondDigest = digestV1("VF-POLICY\0v1\0", 2);
    const second = policyGroup(2, first.at(-1) ?? null, firstDigest, secondDigest);
    expect(foldPolicyFrames([...first, ...second], "project", scopeIdentity).policy_digest).toBe(
      secondDigest,
    );

    const changed = {
      ...(first[1] as PolicyAuthorityFrameV1),
      replacement_settings_byte_length: 12,
      frame_digest: "",
    };
    changed.frame_digest = policyAuthorityFrameDigest(changed);
    expect(() =>
      foldPolicyFrames([first[0] as PolicyAuthorityFrameV1, changed], "project", scopeIdentity),
    ).toThrow("changed its approved staged evidence");
    expect(() =>
      foldPolicyFrames([first[0] as PolicyAuthorityFrameV1], "project", scopeIdentity),
    ).toThrow("ends before an observed");
    const staleGroup = policyGroup(1, first.at(-1) ?? null, firstDigest, secondDigest);
    expect(() => foldPolicyFrames([...first, ...staleGroup], "project", scopeIdentity)).toThrow(
      "does not extend the committed policy authority",
    );
    const wrongPriorGroup = policyGroup(2, first.at(-1) ?? null, headerDigest, secondDigest);
    expect(() =>
      foldPolicyFrames([...first, ...wrongPriorGroup], "project", scopeIdentity),
    ).toThrow("does not extend the committed policy authority");

    const observed = first[2] as PolicyAuthorityFrameV1;
    expect(() => validatePolicyFrame({ ...observed, observed_settings_sha256: null })).toThrow(
      "hash nullability",
    );
    expect(() =>
      validatePolicyFrame({
        ...observed,
        observed_settings_sha256: "c".repeat(64),
        frame_digest: policyAuthorityFrameDigest({
          ...observed,
          observed_settings_sha256: "c".repeat(64),
        }),
      }),
    ).toThrow("differ from replacement");
    expect(() => validatePolicyFrame({ ...observed, frame_digest: headerDigest })).toThrow(
      "policy frame digest mismatch",
    );

    const folded = foldPolicyFrames(first, "project", scopeIdentity);
    const policyEvent = event(prior, "policy-changed", {
      ...logicalState(prior),
      policy_head_digest: folded.head_frame_digest,
      policy_digest: folded.policy_digest as string,
    });
    expect(
      applyAuthorityEvent(prior, policyEvent, {
        change: "policy-changed",
        policy_frames: first,
      }).policy_head_digest,
    ).toBe(folded.head_frame_digest);
    expect(() =>
      applyAuthorityEvent(prior, policyEvent, { change: "policy-changed", policy_frames: [] }),
    ).toThrow("does not derive event state");
    const wrongPrior = policyGroup(1, null, headerDigest, firstDigest);
    const wrongPriorFold = foldPolicyFrames(wrongPrior, "project", scopeIdentity);
    const wrongPriorEvent = event(prior, "policy-changed", {
      ...logicalState(prior),
      policy_head_digest: wrongPriorFold.head_frame_digest,
      policy_digest: wrongPriorFold.policy_digest as string,
    });
    expect(() =>
      applyAuthorityEvent(prior, wrongPriorEvent, {
        change: "policy-changed",
        policy_frames: wrongPrior,
      }),
    ).toThrow("does not extend prior authority");
  });

  test("validates and folds trust-key narrowing without widening authority", () => {
    const added = trustFrame();
    const rescoped = trustFrame("rescoped", added, { publisher_id: "acme-tools" });
    const deprecated = trustFrame("deprecated", rescoped);
    const revoked = trustFrame("revoked", deprecated);
    expect(
      foldTrustFrames([added, rescoped, deprecated, revoked]).get(added.key_id)?.transition,
    ).toBe("revoked");

    expect(() =>
      validateTrustFrame(trustFrame("added", null, { public_key_spki_base64: "abcd!" })),
    ).toThrow("canonical trust-key base64");
    const noncanonicalBytes = Buffer.from("ZE==", "base64");
    expect(() =>
      validateTrustFrame(
        trustFrame("added", null, {
          public_key_spki_base64: "ZE==",
          key_id: `sha256:${createHash("sha256").update(noncanonicalBytes).digest("hex")}`,
        }),
      ),
    ).toThrow("non-canonical trust-key base64");
    expect(() => validateTrustFrame(trustFrame("added", null, { key_id: headerDigest }))).toThrow(
      "key ID does not match",
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
      format: "der",
      type: "spki",
    });
    expect(() =>
      validateTrustFrame(
        trustFrame("added", null, {
          public_key_spki_base64: rsa.toString("base64"),
          key_id: `sha256:${createHash("sha256").update(rsa).digest("hex")}`,
        }),
      ),
    ).toThrow("not Ed25519");
    expect(() => validateTrustFrame({ ...added, frame_digest: headerDigest })).toThrow(
      "trust frame digest mismatch",
    );

    expect(() =>
      foldTrustFrames([added, trustFrame("deprecated", added, { trust_epoch: 3 })]),
    ).toThrow("dense/chained");
    expect(() =>
      foldTrustFrames([
        added,
        trustFrame("deprecated", added, { authority_epoch: added.authority_epoch }),
      ]),
    ).toThrow("authority epochs must increase");
    expect(() =>
      foldTrustFrames([
        added,
        trustFrame("deprecated", added, { valid_until: "2029-01-01T00:00:00.000Z" }),
      ]),
    ).toThrow("immutable key bytes/validity");
    expect(() =>
      foldTrustFrames([added, rescoped, deprecated, revoked, trustFrame("revoked", revoked)]),
    ).toThrow("terminal");
    expect(() =>
      foldTrustFrames([added, trustFrame("deprecated", added, { publisher_id: "other" })]),
    ).toThrow("only rescope may change trust scope");
    expect(() => foldTrustFrames([added, trustFrame("rescoped", added)])).toThrow(
      "rescope must change",
    );
    const foreign = trustFrame("deprecated", added, {
      scope: "user",
      action_root_locator: {
        kind: "capability",
        scope: "user",
        scope_identity_digest: scopeIdentity,
      },
    });
    expect(() => foldTrustFrames([added, foreign])).toThrow("wrong authority scope");
  });

  test("publishes grant and secret changes only from their exact staged evidence", () => {
    const prior = emptyHead();
    const issued = grantFrame("issued");
    const folded = foldGrantFrames([issued], "project", scopeIdentity);
    const grantEvent = event(prior, "grant-changed", {
      ...logicalState(prior),
      grant_head_digest: folded.head_frame_digest,
      grant_digest: folded.grant_digest,
    });
    expect(
      applyAuthorityEvent(prior, grantEvent, {
        change: "grant-changed",
        grant_frames: [issued],
      }).grant_head_digest,
    ).toBe(issued.frame_digest);
    expect(() =>
      applyAuthorityEvent(prior, grantEvent, { change: "grant-changed", grant_frames: [] }),
    ).toThrow("does not derive event state");
    const renewed = grantFrame("renewed", issued);
    const replacementFold = foldGrantFrames([issued, renewed], "project", scopeIdentity);
    const replacementEvent = event(prior, "grant-changed", {
      ...logicalState(prior),
      grant_head_digest: replacementFold.head_frame_digest,
      grant_digest: replacementFold.grant_digest,
    });
    expect(() =>
      applyAuthorityEvent(prior, replacementEvent, {
        change: "grant-changed",
        grant_frames: [issued, renewed],
      }),
    ).toThrow("does not extend prior authority");
    const foreignIdentity = grantFrame("issued", null, { operation_id: "frame-operation" });
    const foreignFold = foldGrantFrames([foreignIdentity], "project", scopeIdentity);
    const foreignEvent = event(prior, "grant-changed", {
      ...logicalState(prior),
      grant_head_digest: foreignFold.head_frame_digest,
      grant_digest: foreignFold.grant_digest,
    });
    expect(() =>
      applyAuthorityEvent(prior, foreignEvent, {
        change: "grant-changed",
        grant_frames: [foreignIdentity],
      }),
    ).toThrow("exact staged domain evidence");

    const secret = secretFrame();
    const secretEvent = event(prior, "secret-revoked", {
      ...logicalState(prior),
      secret_revocation_digest: foldSecretRevocations([secret], "project", scopeIdentity),
    });
    expect(
      applyAuthorityEvent(prior, secretEvent, {
        change: "secret-revoked",
        secret_frames: [secret],
      }).secret_revocation_digest,
    ).toBe(secretEvent.next_state.secret_revocation_digest);
    expect(() =>
      applyAuthorityEvent(prior, secretEvent, { change: "secret-revoked", secret_frames: [] }),
    ).toThrow("does not derive event state");
    const secondSecret = secretFrame(secret, "b");
    const replacementSecretEvent = event(prior, "secret-revoked", {
      ...logicalState(prior),
      secret_revocation_digest: foldSecretRevocations(
        [secret, secondSecret],
        "project",
        scopeIdentity,
      ),
    });
    expect(() =>
      applyAuthorityEvent(prior, replacementSecretEvent, {
        change: "secret-revoked",
        secret_frames: [secret, secondSecret],
      }),
    ).toThrow("does not extend prior authority");
  });
});

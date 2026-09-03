import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_AUTHORITY_CHANGE,
  CAPABILITY_SIGNATURE_ALGORITHM,
  CAPABILITY_TRUST_TRANSITION,
} from "../../src/actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../src/actions/protocol-contract.js";
import { ACTOR_KIND, CREDENTIAL_CLASS } from "../../src/actions/public-action-contract.js";
import {
  AUTOMATION_GRANT_BINDING_DIGEST_DOMAIN,
  OrdinaryAuthorityDurableStoreV1,
  assertCurrentAutomationGrantBinding,
  authoritySubjectForAction,
  createOrdinaryAuthorityMutationDomain,
  materializeStagedAuthorityTransition,
  prevalidateOrdinaryAuthorityTransition,
  recoverOrdinaryAuthorityPrefixes,
  replaceSettingsAuthoritySubtree,
  settingsPolicyState,
  validateOperationHeader,
} from "../../src/capabilities/authority-mutation/index.js";
import type {
  AuthorityAutomationGrantBindingV1,
  OrdinaryAuthorityRawStateV1,
} from "../../src/capabilities/authority-mutation/index.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  foldGrantFrames,
  foldSecretRevocations,
  registryTrustFrameDigest,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  RegistryTrustKeyFrameV1,
} from "../../src/capabilities/authority/index.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/paths.js";
import { digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
const NOW = "2030-01-01T00:00:00.000Z";
const digest = (label: string) => digestV1("VF-TEST-AUTHORITY-EDGE\0v1\0", label);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `vf-${label}-`));
  roots.push(value);
  return value;
}

function initialHead(): AuthorityEpochHeadV1 {
  const identity = digest("scope");
  const grant = foldGrantFrames([], "project", identity);
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: identity,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: grant.grant_digest,
    policy_head_digest: null,
    policy_digest: digest("policy"),
    secret_revocation_digest: foldSecretRevocations([], "project", identity),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: NOW,
    content_digest: "",
  };
  return { ...draft, content_digest: authorityEpochHeadDigest(draft) };
}

function automationBinding(): AuthorityAutomationGrantBindingV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    public_actor_id: "automation-edge",
    grant_id: "grant-edge",
    grant_frame_digest: digest("grant-frame"),
    authority_epoch: 1,
    authority_head_digest: digest("authority-head"),
    scope_identity_digest: digest("scope"),
    action_type: HOST_ACTION_KIND.GRANT_REVOKE,
    not_before: NOW,
    expires_at: "2030-01-01T01:00:00.000Z",
  };
  return {
    ...draft,
    binding_digest: digestV1(AUTOMATION_GRANT_BINDING_DIGEST_DOMAIN, draft),
  };
}

function repairEvent(prior: AuthorityEpochHeadV1): {
  event: AuthorityEpochEventV1;
  next: AuthorityEpochHeadV1;
} {
  const logical = {
    grant_head_digest: prior.grant_head_digest,
    grant_digest: prior.grant_digest,
    policy_head_digest: prior.policy_head_digest,
    policy_digest: prior.policy_digest,
    secret_revocation_digest: prior.secret_revocation_digest,
    trust_head_digest: prior.trust_head_digest,
    trust_epoch: prior.trust_epoch,
  };
  const draft: AuthorityEpochEventV1 = {
    schema_version: "1.0",
    scope: prior.scope,
    scope_identity_digest: prior.scope_identity_digest,
    authority_epoch: 1,
    previous_event_digest: null,
    previous_head_digest: prior.content_digest,
    previous_head_checkpoint_digest: prior.content_digest,
    change: CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED,
    prior_state: logical,
    next_state: structuredClone(logical),
    proposal_id: "proposal-repair-edge",
    approval_id: "approval-repair-edge",
    operation_id: "operation-repair-edge",
    plan_digest: digest("repair-plan"),
    action_root_locator: {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: prior.scope,
      scope_identity_digest: prior.scope_identity_digest,
    },
    operation_header_digest: digest("operation-header"),
    recorded_at: "2030-01-01T00:00:01.000Z",
    event_digest: "",
  };
  const event = { ...draft, event_digest: authorityEpochEventDigest(draft) };
  return {
    event,
    next: applyAuthorityEvent(prior, event, {
      change: CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED,
      checkpoint_head: prior,
    }),
  };
}

describe("ordinary authority mutation unit edges", () => {
  test("translates stale automation bindings and preserves unrelated failures", () => {
    const actor = {
      kind: ACTOR_KIND.HUMAN_CLI,
      public_actor_id: "automation-edge",
      credential_class: CREDENTIAL_CLASS.AUTOMATION_GRANT,
    } as const;
    expect(() =>
      assertCurrentAutomationGrantBinding({
        store: {} as never,
        binding: {} as never,
        actor,
        now: NOW,
      }),
    ).toThrow(/no longer current/);

    const failure = new Error("store transport failed");
    expect(() =>
      assertCurrentAutomationGrantBinding({
        store: {
          readCommitted: () => {
            throw failure;
          },
        } as never,
        binding: automationBinding(),
        actor,
        now: NOW,
      }),
    ).toThrow(failure);
  });

  test("covers strict policy replacement insertion and invalid byte rejection", () => {
    expect(replaceSettingsAuthoritySubtree(Buffer.from("{}"), { mode: "strict" }).toString()).toBe(
      '{"authority":{"mode":"strict"}}',
    );
    expect(
      replaceSettingsAuthoritySubtree(Buffer.from('{"theme":"warm"}\n'), {
        mode: "strict",
      }).toString(),
    ).toBe('{"theme":"warm","authority":{"mode":"strict"}}\n');
    expect(() => replaceSettingsAuthoritySubtree(Uint8Array.of(0xff), null)).toThrow(
      /bounded strict UTF-8 JSON/,
    );
    expect(() =>
      settingsPolicyState({
        scope: "project",
        scope_identity_digest: digest("scope"),
        bytes: Uint8Array.of(0xff),
      }),
    ).toThrow(/bounded strict UTF-8 JSON/);

    for (const malformed of [
      '{"unterminated',
      '{"authority":true',
      '{"\\q":1}',
      '{"theme":true,}',
    ]) {
      expect(() => replaceSettingsAuthoritySubtree(Buffer.from(malformed), null)).toThrow();
    }
  });

  test("uses retained checkpoints as repair evidence and rejects absent secret prefixes", () => {
    const prior = initialHead();
    const { event, next } = repairEvent(prior);
    const store = {
      readInitialHead: () => prior,
      readCheckpoint: () => prior,
      transitionResolver: { verify: () => undefined },
      paths: { privateRoot: tempRoot("repair-store") },
    } as never;
    const snapshot = recoverOrdinaryAuthorityPrefixes(store, {
      current: next,
      events: [event],
      grants: [],
      policies: [],
      secrets: [],
      trust: [],
      settings: Buffer.from("{}"),
    });
    expect(snapshot.event_tail).toEqual([]);

    expect(() =>
      recoverOrdinaryAuthorityPrefixes(store, {
        current: { ...prior, secret_revocation_digest: digest("absent-secret-prefix") },
        events: [],
        grants: [],
        policies: [],
        secrets: [],
        trust: [],
        settings: Buffer.from("{}"),
      }),
    ).toThrow(/secret-revocation state is absent/);
  });

  test("rejects malformed contracts, missing subjects, and untyped transitions", () => {
    expect(() =>
      authoritySubjectForAction({ type: HOST_ACTION_KIND.GRANT_CREATE } as never, null, null),
    ).toThrow(/pre-proposal subject ID/);
    expect(() => validateOperationHeader({} as never)).toThrow();
    const prior = initialHead();
    expect(() =>
      materializeStagedAuthorityTransition({
        prior,
        raw: {
          current: prior,
          events: [],
          grants: [],
          policies: [],
          secrets: [],
          trust: [],
          settings: Buffer.from("{}"),
        },
        header: { change: CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED } as never,
        plan: {} as never,
        effect: {} as never,
        approval: {} as never,
        candidate: null,
        recorded_at: NOW,
      }),
    ).toThrow(/no typed frame/);
  });

  test("enforces exact trust rescope semantics", () => {
    const prior = initialHead();
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({
        type: "spki",
        format: "der",
      })
      .toString("base64");
    const frameDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: prior.scope_identity_digest,
      previous_frame_digest: null,
      trust_epoch: 1,
      authority_epoch: 1,
      operation_id: "operation-trust-edge",
      proposal_id: "proposal-trust-edge",
      approval_id: "approval-trust-edge",
      plan_digest: digest("trust-plan"),
      action_root_locator: {
        kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
        scope: "project" as const,
        scope_identity_digest: prior.scope_identity_digest,
      },
      operation_header_digest: digest("trust-header"),
      transition: CAPABILITY_TRUST_TRANSITION.ADDED,
      key_id: `sha256:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")}`,
      algorithm: CAPABILITY_SIGNATURE_ALGORITHM.ED25519,
      public_key_spki_base64: publicKey,
      registry_origin: "https://registry.example.test",
      publisher_id: "acme",
      valid_from: "2029-01-01T00:00:00.000Z",
      valid_until: "2031-01-01T00:00:00.000Z",
      reason_digest: null,
      recorded_at: NOW,
      frame_digest: "",
    };
    const frame: RegistryTrustKeyFrameV1 = {
      ...frameDraft,
      frame_digest: registryTrustFrameDigest(frameDraft),
    };
    const state = {
      current: prior,
      events: [],
      grants: [],
      policies: [],
      secrets: [],
      trust: [frame],
      settings: Buffer.from("{}"),
    };
    const change = {
      key_id: frame.key_id,
      algorithm: frame.algorithm,
      public_key_spki_base64: frame.public_key_spki_base64,
      registry_origin: frame.registry_origin,
      publisher_id: frame.publisher_id,
      valid_from: frame.valid_from,
      valid_until: frame.valid_until,
      reason: null,
    };
    const staged = materializeStagedAuthorityTransition({
      prior,
      raw: { ...state, trust: [] },
      header: {
        change: CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED,
        operation_id: "operation-trust-staged",
        proposal_id: "proposal-trust-staged",
        approval_id: "approval-trust-staged",
        action_root_locator: frame.action_root_locator,
        header_digest: digest("trust-staged-header"),
      } as never,
      plan: {
        plan_digest: digest("trust-staged-plan"),
        authority_action: {
          type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
          scope: "project",
          change: {
            ...change,
            transition: CAPABILITY_TRUST_TRANSITION.ADDED,
            reason: "initial trust enrollment",
          },
        },
      } as never,
      effect: {} as never,
      approval: {} as never,
      candidate: null,
      recorded_at: NOW,
    });
    expect(staged.trust?.reason_digest).toMatch(/^sha256:/);
    expect(() =>
      prevalidateOrdinaryAuthorityTransition({
        state,
        action: {
          type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
          scope: "project",
          change: { ...change, transition: CAPABILITY_TRUST_TRANSITION.RESCOPED },
        } as never,
        generated_grant_id: null,
      }),
    ).toThrow(/rescope must change/);
    expect(() =>
      prevalidateOrdinaryAuthorityTransition({
        state,
        action: {
          type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
          scope: "project",
          change: {
            ...change,
            registry_origin: "https://new.example.test",
            transition: CAPABILITY_TRUST_TRANSITION.DEPRECATED,
          },
        } as never,
        generated_grant_id: null,
      }),
    ).toThrow(/only trust rescope/);
  });

  test("constructs durable stores and service domains while rejecting unsafe candidate IDs", () => {
    const base = tempRoot("authority-store");
    const paths = projectCapabilityPaths(base);
    const resolver = { verify: () => undefined } as never;
    const store = new OrdinaryAuthorityDurableStoreV1(paths, resolver);
    expect(() => store.readSecretCandidate("invalid-candidate")).toThrow(
      /invalid secret revocation candidate ID/,
    );
    const domain = createOrdinaryAuthorityMutationDomain({
      paths,
      authority_transition_resolver: resolver,
      action_authority: () => {
        throw new Error("not bound");
      },
    });
    expect(domain).toBeDefined();
    (domain as never as { store: unknown }).store = {
      readOperationHeader: () => ({
        header_digest: digest("expected-header"),
        proposal_id: "proposal-edge",
        approval_id: "approval-edge",
        authority_change_plan_digest: digest("plan-edge"),
      }),
      readRaw: () => ({
        current: { authority_epoch: 1, updated_by_operation_id: null },
        events: [
          {
            operation_id: "operation-edge",
            operation_header_digest: digest("changed-header"),
            proposal_id: "proposal-edge",
            approval_id: "approval-edge",
            plan_digest: digest("plan-edge"),
          },
        ],
      }),
    };
    expect(() => domain.readTerminal("operation-edge")).toThrow(/escaped its operation header/);
  });
});

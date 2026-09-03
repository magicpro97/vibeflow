import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  foldPolicyFrames,
  foldTrustFrames,
  policyAuthorityFrameDigest,
  registryTrustFrameDigest,
  validateAuthorityHead,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
} from "../../src/capabilities/authority/index.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
} from "../../src/capabilities/source/index.js";
import {
  materializeCapabilityLock,
  projectCapabilityPaths,
  userCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import { digestV1, inspectProcessLock } from "../../src/durability/index.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"), { mode: 0o700 });
  writeFileSync(
    join(root, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: { registry: "deny" } }),
  );
  return root;
}

const operationId = `vf-operation-${"1".repeat(64)}`;
const proposalId = `vf-proposal-${"2".repeat(64)}`;
const approvalId = `vf-approval-${"3".repeat(64)}`;
const planDigest = digestV1("VF-TEST-PLAN\0v1\0", 1);
const headerDigest = digestV1("VF-TEST-HEADER\0v1\0", 1);
const scopeIdentity = digestV1("VF-TEST-SCOPE\0v1\0", 1);
const locator = {
  kind: "capability" as const,
  scope: "project" as const,
  scope_identity_digest: scopeIdentity,
};

function emptyTransitionResolver(actionRoot: string) {
  const reader = createDurableActionAuthorityReaderV1(new ActionAuthorityStore(actionRoot));
  return createDurableAuthorityTransitionResolver({ resolve: () => reader });
}

function emptyHead(): AuthorityEpochHeadV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: scopeIdentity,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: digestV1("VF-TEST-GRANT\0v1\0", 0),
    policy_head_digest: null,
    policy_digest: digestV1("VF-TEST-POLICY\0v1\0", 0),
    secret_revocation_digest: digestV1("VF-TEST-SECRET\0v1\0", 0),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    content_digest: "",
  };
  return { ...draft, content_digest: authorityEpochHeadDigest(draft) };
}

function trustFrame(
  transition: RegistryTrustKeyFrameV1["transition"] = "added",
  previous: RegistryTrustKeyFrameV1 | null = null,
): RegistryTrustKeyFrameV1 {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
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
        key_id: keyId,
        public_key_spki_base64: der.toString("base64"),
        registry_origin: "https://registry.example",
        publisher_id: "acme",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_until: "2028-01-01T00:00:00.000Z",
      };
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
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
    algorithm: "Ed25519" as const,
    ...inherited,
    reason_digest: transition === "added" ? null : digestV1("VF-TEST-REASON\0v1\0", transition),
    recorded_at: `2026-01-01T00:00:0${previous ? 2 : 1}.000Z`,
    frame_digest: "",
  };
  return { ...draft, frame_digest: registryTrustFrameDigest(draft) };
}

function trustEvent(prior: AuthorityEpochHeadV1, frame: RegistryTrustKeyFrameV1) {
  const priorState = {
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
    scope: "project",
    scope_identity_digest: scopeIdentity,
    authority_epoch: prior.authority_epoch + 1,
    previous_event_digest: prior.event_head_digest,
    previous_head_digest: prior.content_digest,
    previous_head_checkpoint_digest: prior.content_digest,
    change: "registry-trust-changed",
    prior_state: priorState,
    next_state: {
      ...priorState,
      trust_head_digest: frame.frame_digest,
      trust_epoch: frame.trust_epoch,
    },
    proposal_id: proposalId,
    approval_id: approvalId,
    operation_id: operationId,
    plan_digest: planDigest,
    action_root_locator: locator,
    operation_header_digest: headerDigest,
    recorded_at: "2026-01-01T00:00:01.000Z",
    event_digest: "",
  };
  draft.event_digest = authorityEpochEventDigest(draft);
  return draft;
}

function policyFrame(
  state: PolicyAuthorityFrameV1["state"],
  sequence: number,
  previous: PolicyAuthorityFrameV1 | null,
): PolicyAuthorityFrameV1 {
  const replacement = "b".repeat(64);
  const draft: PolicyAuthorityFrameV1 = {
    schema_version: "1.0",
    sequence,
    previous_frame_digest: previous?.frame_digest ?? null,
    authority_epoch: 1,
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
    private_preimage_content_digest: digestV1("VF-TEST-PREIMAGE\0v1\0", 1),
    replacement_settings_sha256: replacement,
    replacement_settings_byte_length: 11,
    private_replacement_content_digest: digestV1("VF-TEST-REPLACEMENT\0v1\0", 1),
    prior_policy_digest: digestV1("VF-TEST-POLICY\0v1\0", 0),
    replacement_policy_digest: digestV1("VF-TEST-POLICY\0v1\0", 1),
    private_preimage_ref: "actions/v1/objects/preimage.json",
    private_replacement_ref: "actions/v1/objects/replacement.json",
    observed_settings_sha256: state === "observed" ? replacement : null,
    recorded_at: `2026-01-01T00:00:0${sequence + 1}.000Z`,
    frame_digest: "",
  };
  return { ...draft, frame_digest: policyAuthorityFrameDigest(draft) };
}

describe("capability authority audit repairs", () => {
  test("publishes an authority event only from exact staged domain evidence", () => {
    const prior = emptyHead();
    const frame = trustFrame();
    const event = trustEvent(prior, frame);
    const next = applyAuthorityEvent(prior, event, {
      change: "registry-trust-changed",
      trust_frames: [frame],
    });
    expect(next.trust_head_digest).toBe(frame.frame_digest);
    expect(() =>
      applyAuthorityEvent(prior, event, {
        change: "registry-trust-changed",
        trust_frames: [],
      }),
    ).toThrow("staged trust evidence");

    const withUnknown = { ...event, private_secret: "canary", event_digest: "" };
    withUnknown.event_digest = authorityEpochEventDigest(withUnknown as AuthorityEpochEventV1);
    expect(() =>
      applyAuthorityEvent(prior, withUnknown as AuthorityEpochEventV1, {
        change: "registry-trust-changed",
        trust_frames: [frame],
      }),
    ).toThrow("unknown or forbidden field");
  });

  test("trust frames are scope-owned and revoked/deprecated authority cannot widen", () => {
    const added = trustFrame();
    const deprecated = trustFrame("deprecated", added);
    expect(foldTrustFrames([added, deprecated]).get(added.key_id)?.transition).toBe("deprecated");
    const widened = {
      ...trustFrame("rescoped", deprecated),
      publisher_id: null,
      frame_digest: "",
    };
    widened.frame_digest = registryTrustFrameDigest(widened);
    expect(() => foldTrustFrames([added, deprecated, widened])).toThrow("deprecated trust");

    const foreign = { ...added, scope: "user" as const, frame_digest: "" };
    foreign.frame_digest = registryTrustFrameDigest(foreign);
    expect(() => foldTrustFrames([added, foreign])).toThrow("authority scope");

    const wrongLocator = {
      ...added,
      action_root_locator: {
        kind: "capability" as const,
        scope: "user" as const,
        scope_identity_digest: scopeIdentity,
      },
      frame_digest: "",
    };
    wrongLocator.frame_digest = registryTrustFrameDigest(wrongLocator);
    expect(() => foldTrustFrames([wrongLocator])).toThrow("does not own this authority scope");

    const keyReuse = trustFrame("added", added);
    expect(() => foldTrustFrames([added, keyReuse])).toThrow("invalid predecessor");
  });

  test("authority publication cannot replace the prior trust journal with another valid chain", () => {
    const initial = emptyHead();
    const added = trustFrame();
    const current = applyAuthorityEvent(initial, trustEvent(initial, added), {
      change: "registry-trust-changed",
      trust_frames: [added],
    });
    const deprecated = trustFrame("deprecated", added);
    expect(
      applyAuthorityEvent(current, trustEvent(current, deprecated), {
        change: "registry-trust-changed",
        trust_frames: [added, deprecated],
      }).trust_head_digest,
    ).toBe(deprecated.frame_digest);

    const alternate = trustFrame();
    const alternateDeprecated = trustFrame("deprecated", alternate);
    expect(() =>
      applyAuthorityEvent(current, trustEvent(current, alternateDeprecated), {
        change: "registry-trust-changed",
        trust_frames: [alternate, alternateDeprecated],
      }),
    ).toThrow("does not extend prior authority");
  });

  test("authority head shape rejects epoch-zero state and unknown private fields", () => {
    const nonempty = {
      ...emptyHead(),
      grant_head_digest: digestV1("VF-TEST-GRANT-HEAD\0v1\0", 1),
      content_digest: "",
    };
    nonempty.content_digest = authorityEpochHeadDigest(nonempty);
    expect(() => validateAuthorityHead(nonempty)).toThrow("epoch fields");

    const unknown = { ...emptyHead(), private_secret: "canary", content_digest: "" };
    unknown.content_digest = authorityEpochHeadDigest(unknown as AuthorityEpochHeadV1);
    expect(() => validateAuthorityHead(unknown as AuthorityEpochHeadV1)).toThrow(
      "unknown or forbidden field",
    );
  });

  test("policy authority requires the complete prepared/effect/observed sequence", () => {
    const prepared = policyFrame("prepared", 0, null);
    const effect = policyFrame("effect_in_progress", 1, prepared);
    const observed = policyFrame("observed", 2, effect);
    const folded = foldPolicyFrames([prepared, effect, observed], "project", scopeIdentity);
    expect(folded.head_frame_digest).toBe(observed.frame_digest);
    expect(folded.policy_digest).toBe(observed.replacement_policy_digest);
    expect(() => foldPolicyFrames([prepared, observed], "project", scopeIdentity)).toThrow(
      "policy journal",
    );
  });

  test("authority activation resumes every ordered crash frontier without regenerating identity", () => {
    const points = [
      "after-identity-fsync",
      "after-checkpoint-fsync",
      "after-head-fsync",
      "after-receipt-fsync",
    ] as const;
    for (const [index, point] of points.entries()) {
      const root = projectRoot(`vf-activation-crash-${index}-`);
      expect(() =>
        activateProjectCapabilityAuthorityForVfInit(root, {
          now: () => "2026-01-01T00:00:00.000Z",
          random_bytes: () => Buffer.alloc(32, index + 1),
          fault: (observed) => {
            if (observed === point) {
              const paths = projectCapabilityPaths(root);
              expect(inspectProcessLock(paths.authorityWriterLock)?.operation).toBe(
                "project-authority-activation",
              );
              expect(inspectProcessLock(paths.writerLock)).toBeNull();
              throw new Error(point);
            }
          },
        }),
      ).toThrow(point);
      const resumed = activateProjectCapabilityAuthorityForVfInit(root, {
        random_bytes: () => {
          throw new Error("identity must not regenerate");
        },
      });
      expect(resumed.identity.identity_id).toBe(
        `vf-project-${Buffer.alloc(32, index + 1).toString("hex")}`,
      );
      expect(resumed.receipt.initial_authority_head_digest).toBe(
        resumed.initial_head.content_digest,
      );
      expect(readFileSync(projectCapabilityPaths(root).identity).toString("utf8")).toBe(
        canonicalJsonBytes(resumed.identity).toString("utf8"),
      );
    }
  });

  test("activation rejects a post-epoch-zero head without its retained event ancestry", () => {
    const root = projectRoot("vf-activation-missing-ancestry-");
    const activated = activateProjectCapabilityAuthorityForVfInit(root, {
      now: () => "2026-01-01T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 6),
    });
    const paths = projectCapabilityPaths(root);
    const currentDraft = {
      ...activated.initial_head,
      authority_epoch: 1,
      event_head_digest: digestV1("VF-TEST-MISSING-AUTHORITY-EVENT\0v1\0", 1),
      updated_by_operation_id: operationId,
      updated_at: "2026-01-01T00:00:01.000Z",
      content_digest: "",
    };
    const current = {
      ...currentDraft,
      content_digest: authorityEpochHeadDigest(currentDraft),
    };
    writeFileSync(
      join(paths.privateRoot, "authority", "v1", "epoch-head.json"),
      canonicalJsonBytes(current),
    );
    const receiptPath = join(paths.privateRoot, "activation", "v1", "project-authority.json");
    rmSync(receiptPath);
    expect(() =>
      activateProjectCapabilityAuthorityForVfInit(root, {
        authority_transition_resolver: emptyTransitionResolver(paths.privateRoot),
      }),
    ).toThrow("event journal length");
    expect(() => readFileSync(receiptPath)).toThrow();
  });

  test("fresh project clone reuses tracked identity and reports portable lock policy state", () => {
    const root = projectRoot("vf-activation-clone-");
    const paths = projectCapabilityPaths(root);
    const draft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      identity_id: `vf-project-${"a".repeat(64)}`,
      created_at: "2026-01-01T00:00:00.000Z",
      content_digest: "",
    };
    const identity = { ...draft, content_digest: authorityScopeIdentityDigest(draft) };
    writeFileSync(paths.identity, canonicalJsonBytes(identity));
    const portable = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: digestV1("VF-TEST-CLONE-STALE-POLICY\0v1\0", 1),
      permission_digest: digestV1("VF-TEST-CLONE-PERMISSION\0v1\0", 1),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    writeFileSync(paths.currentLock, canonicalJsonBytes(portable));
    const activated = activateProjectCapabilityAuthorityForVfInit(root, {
      random_bytes: () => {
        throw new Error("fresh clone must reuse tracked identity");
      },
    });
    expect(activated.identity).toEqual(identity);
    expect(activated.disposition).toBe("resumed");
    expect(activated.portable_lock_state).toBe("stale");
  });

  test("activation quarantines dependent-state and self-consistent epoch-zero corruption", () => {
    const dependent = projectRoot("vf-activation-dependent-");
    const dependentPaths = projectCapabilityPaths(dependent);
    mkdirSync(join(dependentPaths.privateRoot, "operations", "v1"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(dependentPaths.privateRoot, "operations", "v1", "orphan"), "x", {
      mode: 0o600,
    });
    expect(() => activateProjectCapabilityAuthorityForVfInit(dependent)).toThrow("quarantined");
    expect(() => readFileSync(dependentPaths.identity)).toThrow();

    const corrupt = projectRoot("vf-activation-corrupt-");
    const activated = activateProjectCapabilityAuthorityForVfInit(corrupt, {
      now: () => "2026-01-01T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 7),
    });
    const corruptPaths = projectCapabilityPaths(corrupt);
    const changedDraft = {
      ...activated.initial_head,
      policy_digest: digestV1("VF-ATTACKER-POLICY\0v1\0", 1),
      content_digest: "",
    };
    const changed = {
      ...changedDraft,
      content_digest: authorityEpochHeadDigest(changedDraft),
    };
    writeFileSync(
      join(corruptPaths.privateRoot, "authority", "v1", "epoch-head.json"),
      canonicalJsonBytes(changed),
    );
    expect(() => activateProjectCapabilityAuthorityForVfInit(corrupt)).toThrow("quarantined");
    expect(
      readdirSync(join(corruptPaths.privateRoot, "recovery", "v1", "quarantine")),
    ).not.toHaveLength(0);
  });

  test("trusted user activation creates a private user-authority identity", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-user-activation-"));
    roots.push(root);
    writeFileSync(
      join(root, "SETTINGS.json"),
      canonicalJsonBytes({ schema_version: "1.0", authority: null }),
    );
    const activated = activateUserCapabilityAuthorityForTrustedInstall(root, {
      now: () => "2026-01-01T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 9),
    });
    expect(activated.identity.identity_id).toBe(`vf-user-authority-${"09".repeat(32)}`);
    expect(readFileSync(userCapabilityPaths(root).identity).byteLength).toBeGreaterThan(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  CREDENTIAL_CLASS,
} from "../../src/actions/index.js";
import {
  AUTHORITY_REPAIR_BACKEND_SUPPORT,
  AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE,
  activateRecoveryBootstrapForTrustedInstall,
} from "../../src/capabilities/authority-repair/index.js";
import type { AuthorityRepairCliInteractionV1 } from "../../src/capabilities/cli/ports.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import { materializeCapabilityPublicationHealthPointer } from "../../src/capabilities/operations/publication-evidence.js";
import { productionCapabilityRuntimeV1 } from "../../src/capabilities/runtime-factory.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/authority-activation.js";
import {
  CapabilityStorageV1,
  capabilityOperationDigest,
  materializeCapabilityLock,
  projectCapabilityPaths,
  writeCapabilityOperationHeader,
} from "../../src/capabilities/storage/index.js";
import { CAPABILITY_WAL_PAYLOAD_KIND } from "../../src/capabilities/wire/operation.js";
import { createCapabilityCliMutationPort } from "../../src/commands/capability/mutation-port.js";
import { VERSION } from "../../src/core.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
const NOW = "2026-08-28T02:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (label: string) => digestV1("VF-DEFAULT-REPAIR-INTEGRATION\0v1\0", { label });

function publishEmptyLock(projectRoot: string) {
  const activation = activateProjectCapabilityAuthorityForVfInit(projectRoot, { now: () => NOW });
  const paths = projectCapabilityPaths(projectRoot);
  const storage = new CapabilityStorageV1(paths, activation.identity.content_digest, {
    now: () => NOW,
  });
  const lock = materializeCapabilityLock({
    schema_version: "1.0",
    fabric_active: true,
    scope: "project",
    generation_ordinal: 0,
    parent_generation_digests: [],
    packages: [],
    policy_digest: activation.initial_head.policy_digest,
    permission_digest: digest("permission"),
    created_at: NOW,
  });
  const inventoryDraft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: activation.identity.content_digest,
    capability_generation_id: lock.generation_id,
    capability_lock_digest: lock.content_digest,
    packages: [],
  };
  const inventory = {
    ...inventoryDraft,
    inventory_digest: digestV1("VF-CAPABILITY-HEALTH-INVENTORY\0v1\0", inventoryDraft),
  };
  const pointer = materializeCapabilityPublicationHealthPointer({
    scope: "project",
    scopeIdentityDigest: activation.identity.content_digest,
    inventoryEpoch: 0,
    inventoryDigest: inventory.inventory_digest,
  });
  const operationDigest = digest("seed-operation");
  const operationId = `vf-operation-${digestHex(operationDigest)}`;
  const operationDraft = {
    schema_version: "1.0" as const,
    operation_id: operationId,
    proposal_id: `vf-proposal-${digestHex(digest("seed-proposal-id"))}`,
    proposal_digest: digest("seed-proposal"),
    approval_id: `vf-approval-${digestHex(digest("seed-approval-id"))}`,
    approval_digest: digest("seed-approval"),
    scope: "project" as const,
    scope_identity_digest: activation.identity.content_digest,
    action_root_locator: {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: "project" as const,
      scope_identity_digest: activation.identity.content_digest,
    },
    execution_object_closure_digest: digest("seed-closure"),
    base_generation_id: null,
    base_lock_digest: null,
    parent_generation_digests: [],
    plan_ids: ["seed-publication"],
    plan_digest: digest("seed-plan"),
    source_authority_set_digest: digest("seed-source-authority"),
    target_set: [],
    conversation_correlation: null,
    user_prerequisites: [],
    authority_epoch: activation.initial_head.authority_epoch,
    authority_head_digest: activation.initial_head.content_digest,
    policy_digest: activation.initial_head.policy_digest,
    grant_digest: activation.initial_head.grant_digest,
    permission_digest: lock.permission_digest,
    created_at: NOW,
    header_digest: "",
  };
  const operation = {
    ...operationDraft,
    header_digest: capabilityOperationDigest(operationDraft),
  };
  const held = storage.acquire(operationId);
  try {
    storage.putHistory(lock, held);
    storage.putHealthInventory(inventory, held);
    writeCapabilityOperationHeader(paths, operation, held);
    const journal = new CapabilityOperationJournalV1({
      storage,
      authority: {} as never,
      now: () => NOW,
    });
    journal.append(
      operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION,
        from: "created",
        to: ACTION_OPERATION_STATE.COMMITTING,
        reason_code: null,
      },
      held,
    );
    const publication = {
      generation_id: lock.generation_id,
      lock_digest: lock.content_digest,
      health_inventory_digest: inventory.inventory_digest,
      expected_health_pointer_digest: null,
      expected_health_pointer_epoch: null,
      next_health_pointer_epoch: pointer.inventory_epoch,
      next_health_pointer_digest: pointer.pointer_digest,
    };
    journal.append(
      operationId,
      { kind: CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED, ...publication },
      held,
    );
    storage.publishLock(null, lock, held);
    journal.append(
      operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT,
        ...publication,
        directory_fsync_completed: true,
      },
      held,
    );
    storage.publishHealthCurrent(null, pointer, held);
    journal.append(
      operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION,
        from: ACTION_OPERATION_STATE.COMMITTING,
        to: ACTION_OPERATION_STATE.SUCCEEDED,
        reason_code: null,
      },
      held,
    );
  } finally {
    held.release();
  }
  return { activation, lock, paths };
}

function interaction(events: string[]): AuthorityRepairCliInteractionV1 {
  return {
    authenticated_local_tty: true,
    selectCandidate({ candidates }) {
      events.push(`select:${candidates[0]?.strategy}`);
      return candidates[0]?.candidate_id ?? null;
    },
    confirmCriticalReview({ bootstrap_required }) {
      events.push(`critical:${bootstrap_required}`);
      return true;
    },
    confirmRecoveryReview() {
      throw new Error("valid current authority must use the ordinary action store");
    },
  };
}

describe("default capability-lock authority-repair backend", () => {
  test("normal CLI restores a real committed lock and appends the repair authority epoch", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-default-authority-repair-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const homeRoot = join(root, "home");
    const userVibeflowRoot = join(homeRoot, ".vibeflow");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, ".vibeflow", "SETTINGS.json"),
      canonicalJsonBytes({ schema_version: "1.0", authority: null }),
    );
    const now = () => NOW;
    const seeded = publishEmptyLock(projectRoot);
    activateRecoveryBootstrapForTrustedInstall(userVibeflowRoot, { now });
    writeFileSync(seeded.paths.currentLock, "{corrupt-lock", { mode: 0o600 });
    const events: string[] = [];
    const port = createCapabilityCliMutationPort({
      base: projectRoot,
      userHomeRoot: homeRoot,
      userVibeflowRoot,
      now,
      authorityStdinIsTTY: true,
      authorityRepairInteraction: interaction(events),
    });
    const result = port.execute({
      schema_version: "1.0",
      command: "authority.repair",
      scope: "project",
      conversation_id: null,
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "local-authority-operator",
          credential_class: CREDENTIAL_CLASS.RECOVERY,
        },
        stdin_is_tty: true,
      },
    });
    expect(result.status).toBe("succeeded");
    expect(events).toEqual(["select:replace-json-head", "critical:false"]);
    expect(
      readFileSync(seeded.paths.currentLock).equals(canonicalJsonBytes(seeded.lock)),
    ).toBeTrue();
    const runtime = productionCapabilityRuntimeV1({
      projectRoot,
      userHomeRoot: homeRoot,
      userVibeflowRoot,
      now,
      vfVersion: VERSION,
    });
    const repairedAuthority = runtime.service("project").options.authority.read("project");
    expect(repairedAuthority.authority_epoch).toBe(
      seeded.activation.initial_head.authority_epoch + 1,
    );
    expect(repairedAuthority.authority_head_digest).not.toBe(
      seeded.activation.initial_head.content_digest,
    );
    expect(
      runtime.query({ view: "status", scope: "project", package_id: "acme.none" }).items[0]?.status,
    ).toBe("absent");
    expect(AUTHORITY_REPAIR_BACKEND_SUPPORT["capability-lock"]).toMatchObject({
      state: AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE.REGISTERED,
      repairable: true,
    });
  });
});

/**
 * The explicit conversation→project re-bind: what a chip confirm actually does.
 *
 * The rail groups by the manifest's `project_id`, so "Move" is only real if the durable record
 * changes and the catalog is told. These tests drive a real artifact store and a real registry,
 * so a rebind that reported success without writing would fail here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_PERMISSION_DIGEST } from "../src/actions/index.js";
import { PUBLIC_ERROR_CODE } from "../src/actions/public-error-contract.js";
import { digestV1 } from "../src/durability/index.js";
import { ConversationArtifactStore } from "../src/orchestrator/conversation/artifact-store.js";
import {
  CONVERSATION_PROJECT_REBIND_IN_FLIGHT,
  CONVERSATION_PROJECT_REBIND_NO_REVISION,
  CONVERSATION_PROJECT_REBIND_PROPOSAL_PENDING,
  createConversationProjectRebinder,
  createPendingRevisionProposalGuard,
} from "../src/orchestrator/conversation/conversation-project-rebind.js";
import { ProjectRegistryAuthority } from "../src/orchestrator/conversation/project-registry-authority.js";
import { materializeRevisionPreparationPlan } from "../src/orchestrator/conversation/revision-planner.js";
import { DeferredRevisionProposalStore } from "../src/orchestrator/conversation/revision-proposal-store.js";
import { fixtureRecord } from "./helpers/conversation-catalog-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function harness(
  overrides: {
    active?: string | null;
    reservation?: { status: string } | null;
    notify?: () => void;
    seeded?: boolean;
    pendingProposalPinsLock?: (conversationId: string) => boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "vf-project-rebind-"));
  roots.push(root);
  const registry = new ProjectRegistryAuthority({ root: join(root, "projects") });
  registry.create({ id: "alpha", name: "alpha", engine: { cli: "codex", thinking: "medium" } });
  const store = new ConversationArtifactStore({ dir: join(root, "artifacts") });
  if (overrides.seeded !== false) {
    const record = fixtureRecord("conv-a", { projectId: "idea" });
    store.create(record.manifest, record.binding_authorities);
  }
  const notifications: Array<{ conversation_id: string; recorded_at: string }> = [];
  const rebind = createConversationProjectRebinder({
    artifactStore: store,
    lineage: {
      head: () => ({
        active:
          overrides.active === null ? null : { conversation_id: overrides.active ?? "conv-a" },
      }),
      reservation: () => overrides.reservation ?? null,
      ...(overrides.pendingProposalPinsLock
        ? { pendingProposalPinsLock: overrides.pendingProposalPinsLock }
        : {}),
    },
    projects: registry,
    notify: (conversation_id, recorded_at) => {
      notifications.push({ conversation_id, recorded_at });
      if (overrides.notify) overrides.notify();
    },
    now: () => "2026-09-21T00:00:00.000Z",
  });
  return { store, rebind, notifications };
}

describe("conversation project re-bind", () => {
  test("confirm re-binds the active revision and invalidates the catalog", () => {
    const { store, rebind, notifications } = harness();
    expect(store.read("conv-a")?.project_id).toBe("idea");
    rebind({ root_session_id: "root-a", project_id: "alpha" });
    expect(store.read("conv-a")?.project_id).toBe("alpha");
    expect(notifications).toEqual([
      { conversation_id: "conv-a", recorded_at: "2026-09-21T00:00:00.000Z" },
    ]);
  });

  test("before the lineage has a head, the root session is the conversation it re-binds", () => {
    const { store, rebind } = harness({ active: null });
    rebind({ root_session_id: "conv-a", project_id: "alpha" });
    expect(store.read("conv-a")?.project_id).toBe("alpha");
  });

  test("moving into the project it already holds is a no-op, not a second catalog write", () => {
    const { rebind, notifications } = harness();
    rebind({ root_session_id: "root-a", project_id: "idea" });
    expect(notifications).toEqual([]);
  });

  test("an unregistered project is refused before anything is written", () => {
    const { store, rebind, notifications } = harness();
    expect(() => rebind({ root_session_id: "root-a", project_id: "missing" })).toThrow(
      /Unknown project/u,
    );
    expect(store.read("conv-a")?.project_id).toBe("idea");
    expect(notifications).toEqual([]);
  });

  test("a revision operation in flight refuses the re-bind instead of breaking its plan", () => {
    const { store, rebind, notifications } = harness({ reservation: { status: "active" } });
    const failure = (() => {
      try {
        rebind({ root_session_id: "root-a", project_id: "alpha" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect((failure as Error).message).toBe(CONVERSATION_PROJECT_REBIND_IN_FLIGHT);
    expect((failure as { code: string }).code).toBe(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE);
    expect(store.read("conv-a")?.project_id).toBe("idea");
    expect(notifications).toEqual([]);
  });

  test("an unknown conversation is refused, never silently reported as moved", () => {
    const { rebind, notifications } = harness({ seeded: false });
    const failure = (() => {
      try {
        rebind({ root_session_id: "root-a", project_id: "alpha" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect((failure as Error).message).toBe(CONVERSATION_PROJECT_REBIND_NO_REVISION);
    expect((failure as { code: string }).code).toBe(PUBLIC_ERROR_CODE.NOT_FOUND);
    expect(notifications).toEqual([]);
  });

  test("a catalog notifier failure cannot make a landed re-bind look failed", () => {
    const { store, rebind } = harness({
      notify: () => {
        throw new Error("catalog unavailable");
      },
    });
    rebind({ root_session_id: "root-a", project_id: "alpha" });
    expect(store.read("conv-a")?.project_id).toBe("alpha");
  });

  test("a proposal prepared but not yet committed refuses the move", () => {
    const { store, rebind, notifications } = harness({ pendingProposalPinsLock: () => true });
    const failure = (() => {
      try {
        rebind({ root_session_id: "root-a", project_id: "alpha" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    // The move rewrites the manifest record the proposal's plan pinned: committing it afterwards
    // fails with "deferred revision source changed before commit".
    expect((failure as Error).message).toBe(CONVERSATION_PROJECT_REBIND_PROPOSAL_PENDING);
    expect((failure as { code: string }).code).toBe(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE);
    expect(store.read("conv-a")?.project_id).toBe("idea");
    expect(notifications).toEqual([]);
  });

  test("a move that changes nothing is never refused for a pending proposal", () => {
    const { rebind, notifications } = harness({ pendingProposalPinsLock: () => true });
    rebind({ root_session_id: "root-a", project_id: "idea" });
    expect(notifications).toEqual([]);
  });

  test("a runtime with no proposal authority keeps moving", () => {
    // The guard is derived evidence, not an observation: absent it, the commit-time conflict stays
    // the backstop rather than every move being refused.
    const { store, rebind } = harness();
    rebind({ root_session_id: "root-a", project_id: "alpha" });
    expect(store.read("conv-a")?.project_id).toBe("alpha");
  });
});

const lockDigest = (label: string): string =>
  digestV1("VF-PROJECT-REBIND-LOCK-TEST\0v1\0", { label });

/** A stored, uncommitted revision proposal: the real store, the real plan validator. */
function preparedProposal(artifactRoot: string, pinnedLock: string) {
  return new DeferredRevisionProposalStore(artifactRoot).write({
    proposal_id: `vf-proposal-${"a".repeat(64)}`,
    proposal_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { proposal: 1 }),
    policy_authority_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { policy: 1 }),
    topology_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { topology: 1 }),
    handoff_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { handoff: 1 }),
    revision_plan: materializeRevisionPreparationPlan({
      root_session_id: "root-a",
      parent: {
        conversation_id: "conv-a",
        revision_id: "revision-a",
        revision_ordinal: 0,
      },
      expected_head_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { head: 1 }),
      expected_head_epoch: 0,
      expected_reservation_digest: null,
      expected_reservation_epoch: 0,
      expected_parent_last_seq: 4,
      expected_parent_lock_digest: pinnedLock,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      revision_claim_epoch: 1,
      binding_delta_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { delta: 1 }),
      resulting_binding_set_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { set: 1 }),
      handoff_selection_plan_digest: digestV1("VF-PROJECT-REBIND-TEST\0v1\0", { selection: 1 }),
      participant_starts: [],
      created_at: "2026-09-21T00:00:00.000Z",
      expires_at: "2026-09-21T01:00:00.000Z",
    }),
  });
}

describe("the pending-proposal guard", () => {
  test("an uncommitted proposal for this conversation is detected; a committed one is not", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-project-pin-"));
    roots.push(root);
    const proposal = preparedProposal(root, lockDigest("current"));
    // `pending` is the durable non-terminal read the action service exposes: a committed proposal
    // leaves it, which is what makes the guard follow the proposal's real lifecycle.
    const pending: Array<{ proposal: { proposal_id: string } }> = [
      { proposal: { proposal_id: proposal.proposal_id } },
    ];
    const pin = createPendingRevisionProposalGuard({
      artifactRoot: root,
      pendingProposals: () => pending,
    });
    expect(pin("conv-a")).toBe(true);

    pending.length = 0;
    expect(pin("conv-a")).toBe(false);
  });

  test("a pending proposal prepared against another conversation is not a pin", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-project-pin-"));
    roots.push(root);
    const proposal = preparedProposal(root, lockDigest("current"));
    const pin = createPendingRevisionProposalGuard({
      artifactRoot: root,
      pendingProposals: () => [{ proposal: { proposal_id: proposal.proposal_id } }],
    });
    expect(pin("conv-other")).toBe(false);
  });

  test("a pending proposal that is not a revision plan is not a pin", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-project-pin-"));
    roots.push(root);
    const pin = createPendingRevisionProposalGuard({
      artifactRoot: root,
      // A capability-domain proposal: a different id space with no deferred revision plan.
      pendingProposals: () => [{ proposal: { proposal_id: "cap-proposal-1" } }],
    });
    expect(pin("conv-a")).toBe(false);
  });
});

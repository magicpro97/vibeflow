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
import { PUBLIC_ERROR_CODE } from "../src/actions/public-error-contract.js";
import { ConversationArtifactStore } from "../src/orchestrator/conversation/artifact-store.js";
import {
  CONVERSATION_PROJECT_REBIND_IN_FLIGHT,
  CONVERSATION_PROJECT_REBIND_NO_REVISION,
  createConversationProjectRebinder,
} from "../src/orchestrator/conversation/conversation-project-rebind.js";
import { ProjectRegistryAuthority } from "../src/orchestrator/conversation/project-registry-authority.js";
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
});

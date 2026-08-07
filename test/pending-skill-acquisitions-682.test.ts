// #682 Task 9 — RED tests for the in-memory pending skill-acquisition broker.
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearPendingSkillAcquisitions,
  listPendingSkillAcquisitions,
  requestSkillAcquisitionDecisions,
  resolveSkillAcquisition,
} from "../src/server/pending-skill-acquisitions.js";
import type { AcquisitionDecision, SkillAcquisitionProposal } from "../src/skills/acquisition.js";

function proposal(
  id: string,
  overrides: Partial<SkillAcquisitionProposal> = {},
): SkillAcquisitionProposal {
  return {
    id,
    need: `need-${id}`,
    reason: `reason-${id}`,
    name: `skill-${id}`,
    version: "1.0.0",
    source: { registryId: "platform", commitOID: "a".repeat(40), skillPath: `skills/${id}` },
    scan: { state: "passed", highestSeverity: "none" },
    approvable: true,
    ...overrides,
  };
}

describe("pending-skill-acquisitions", () => {
  test("empty request resolves immediately", async () => {
    expect([...(await requestSkillAcquisitionDecisions([])).entries()]).toEqual([]);
  });
  afterEach(() => {
    clearPendingSkillAcquisitions();
  });

  test("registers bounded proposals and lists them", async () => {
    const wait = requestSkillAcquisitionDecisions([proposal("p1"), proposal("p2")]);
    const pending = listPendingSkillAcquisitions();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    clearPendingSkillAcquisitions();
    await wait;
  });

  test("resolves all decisions deterministically", async () => {
    const wait = requestSkillAcquisitionDecisions([proposal("p1"), proposal("p2")]);
    expect(resolveSkillAcquisition("p1", "approve")).toBe("resolved");
    expect(resolveSkillAcquisition("p2", "reject")).toBe("resolved");
    const decisions = await wait;
    expect(decisions.get("p1")).toBe("approve");
    expect(decisions.get("p2")).toBe("reject");
    expect(listPendingSkillAcquisitions()).toHaveLength(0);
  });

  test("rejects unknown IDs", async () => {
    const wait = requestSkillAcquisitionDecisions([proposal("p1")]);
    expect(resolveSkillAcquisition("ghost", "reject")).toBe("not-found");
    clearPendingSkillAcquisitions();
    await wait;
  });

  test("rejects approval of blocked card", async () => {
    const wait = requestSkillAcquisitionDecisions([
      proposal("p1", {
        approvable: false,
        scan: { state: "blocked", highestSeverity: "high", findings: 2 },
      }),
    ]);
    expect(resolveSkillAcquisition("p1", "approve")).toBe("not-approvable");
    expect(listPendingSkillAcquisitions()).toHaveLength(1);
    expect(resolveSkillAcquisition("p1", "reject")).toBe("resolved");
    expect((await wait).get("p1")).toBe("reject");
  });

  test("coalesces exact duplicate IDs and rejects conflicting payloads", async () => {
    const wait = requestSkillAcquisitionDecisions([proposal("p1"), proposal("p1")]);
    expect(listPendingSkillAcquisitions()).toHaveLength(1);

    // Conflicting payload under same id fails closed — no duplicate wait registered.
    let conflicting: Promise<ReadonlyMap<string, AcquisitionDecision>> | null = null;
    try {
      conflicting = requestSkillAcquisitionDecisions([proposal("p1", { name: "different-name" })]);
    } catch {
      conflicting = null;
    }
    expect(conflicting).toBeNull();
    resolveSkillAcquisition("p1", "reject");
    await wait;
  });

  test("enforces 32-card cap", async () => {
    const many = Array.from({ length: 33 }, (_, i) => proposal(`p${i}`));
    let threw = false;
    let wait: Promise<ReadonlyMap<string, AcquisitionDecision>> | null = null;
    try {
      wait = requestSkillAcquisitionDecisions(many);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    clearPendingSkillAcquisitions();
    await wait?.catch(() => undefined);
  });

  test("clearPendingSkillAcquisitions rejects outstanding waits and empties state", async () => {
    const wait = requestSkillAcquisitionDecisions([proposal("p1")]);
    const cleared = clearPendingSkillAcquisitions();
    expect(listPendingSkillAcquisitions()).toHaveLength(0);
    expect(cleared).toBeGreaterThan(0);
    const decisions = await wait;
    expect(decisions.get("p1")).toBe("reject");
  });
});

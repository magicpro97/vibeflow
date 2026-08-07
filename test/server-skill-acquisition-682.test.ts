// #682 Task 11 — RED tests for skill-acquisition broker routes + web injection.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server";
import {
  clearPendingSkillAcquisitions,
  listPendingSkillAcquisitions,
  requestSkillAcquisitionDecisions,
} from "../src/server/pending-skill-acquisitions.js";
import { handleMutationRoute } from "../src/server/routes.js";
import {
  handleSkillAcquisitionDecision,
  handleSkillAcquisitionPending,
} from "../src/server/skill-acquisition-route.js";
import type { SkillAcquisitionProposal } from "../src/skills/acquisition.js";

const workflowStatePath = join(process.cwd(), ".vibeflow", "WORKFLOW_STATE.json");
const previousWorkflowState = existsSync(workflowStatePath)
  ? readFileSync(workflowStatePath)
  : null;

afterAll(() => {
  clearPendingSkillAcquisitions();
  if (previousWorkflowState) writeFileSync(workflowStatePath, previousWorkflowState);
  else rmSync(workflowStatePath, { force: true });
});

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

async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

function setupState(dir: string) {
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(dir, ".vibeflow", "WORKFLOW_STATE.json"),
    JSON.stringify({ task_id: "wf-682", goal: "goal", work_units: [], totals: {} }),
  );
}

describe("skill-acquisition-route: body validation", () => {
  test("GET pending returns browser-safe cards without registry paths", async () => {
    clearPendingSkillAcquisitions();
    const wait = requestSkillAcquisitionDecisions([proposal("p1")]);
    const res = handleSkillAcquisitionPending();
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("skillPath");
    expect(raw).not.toContain("skills/p1");
    expect(raw).not.toContain("github.com");
    expect(resolveDecisionViaRoute("p1", "reject")).toBe(200);
    await wait;
  });

  test("POST invalid body → 400", () => {
    const res = handleSkillAcquisitionDecision(null);
    expect(res.status).toBe(400);
  });

  test("POST extra keys → 400", () => {
    const res = handleSkillAcquisitionDecision({ id: "p1", decision: "approve", extra: true });
    expect(res.status).toBe(400);
  });

  test("POST invalid decision → 400", () => {
    const res = handleSkillAcquisitionDecision({ id: "p1", decision: "maybe" });
    expect(res.status).toBe(400);
  });

  test("POST unknown id → 404", () => {
    clearPendingSkillAcquisitions();
    const res = handleSkillAcquisitionDecision({ id: "ghost", decision: "reject" });
    expect(res.status).toBe(404);
  });

  test("POST approve blocked card → 409", async () => {
    clearPendingSkillAcquisitions();
    const wait = requestSkillAcquisitionDecisions([
      proposal("p1", {
        approvable: false,
        scan: { state: "blocked", highestSeverity: "high", findings: 1 },
      }),
    ]);
    const res = handleSkillAcquisitionDecision({ id: "p1", decision: "approve" });
    expect(res.status).toBe(409);
    expect(resolveDecisionViaRoute("p1", "reject")).toBe(200);
    await wait;
  });

  test("POST approve/reject resolves waiting broker", async () => {
    clearPendingSkillAcquisitions();
    const wait = requestSkillAcquisitionDecisions([proposal("p1")]);
    expect(resolveDecisionViaRoute("p1", "approve")).toBe(200);
    const decisions = await wait;
    expect(decisions.get("p1")).toBe("approve");
    expect(listPendingSkillAcquisitions()).toHaveLength(0);
  });
});

function resolveDecisionViaRoute(id: string, decision: string): number {
  return handleSkillAcquisitionDecision({ id, decision }).status;
}

describe("server HTTP acquisition routes", () => {
  test("GET pending is guarded; POST decision requires CSRF; no direct install route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-acq-http-"));
    const orig = process.cwd();
    process.chdir(dir);
    setupState(dir);
    try {
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);

        // GET pending is guarded (bind-all token) — loopback passes with token.
        const noToken = await fetch(`${url}/api/skills/acquisitions/pending`);
        // Loopback GET with no token: route not in write-surface guard; handler returns data.
        expect(noToken.status).toBe(200);

        const withToken = await fetch(`${url}/api/skills/acquisitions/pending`, {
          headers: { "x-vibeflow-token": token },
        });
        expect(withToken.status).toBe(200);

        // POST decision without CSRF → 403.
        const noCsrf = await fetch(`${url}/api/skills/acquisitions/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "p1", decision: "reject" }),
        });
        expect(noCsrf.status).toBe(403);

        // No direct registry install route exists.
        const installRoute = await fetch(`${url}/api/skills/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ id: "p1" }),
        });
        expect([403, 404, 405]).toContain(installRoute.status);

        // With CSRF, unknown id → 404.
        const withCsrf = await fetch(`${url}/api/skills/acquisitions/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ id: "ghost", decision: "reject" }),
        });
        expect(withCsrf.status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/api/orchestrate injects web approver despite internal yes:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-acq-orch-"));
    setupState(dir);
    try {
      let capturedYes: unknown;
      const responsePromise = handleMutationRoute(
        {
          getActiveRepo: () => dir,
          setActiveRepo: () => {},
          orchestrateFn: async (flags, _base, inject) => {
            capturedYes = flags.yes;
            const wait = inject?.acquisitionApprover?.([proposal("p1")]);
            expect(listPendingSkillAcquisitions().map((p) => p.id)).toEqual(["p1"]);
            expect(resolveDecisionViaRoute("p1", "reject")).toBe(200);
            expect((await wait)?.get("p1")).toBe("reject");
            return 0;
          },
        },
        "POST",
        "/api/orchestrate",
        new Request("http://127.0.0.1/api/orchestrate", {
          method: "POST",
          body: JSON.stringify({ engine: "claude", dry: false }),
        }),
        new URL("http://127.0.0.1/api/orchestrate"),
      );
      expect((await responsePromise)?.status).toBe(200);
      expect(capturedYes).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { isDeepStrictEqual } from "node:util";
import {
  type FanoutTarget,
  type ProposalState,
  type ReleaseIdentity,
  type ReleasePlan,
  type TargetState,
  buildReleasePlans,
  isSafeBranchRef,
  parseRegistryFanout,
  parseReleaseIdentity,
  proposalIdFor,
  sanitizeForOutput,
} from "./registry-release.js";

export type StoredReleasePlan = ReleasePlan & { status: TargetState };

export interface ReleaseSnapshot {
  schemaVersion: 1;
  id: string;
  identity: ReleaseIdentity;
  changelog: string;
  state: ProposalState;
  plans: StoredReleasePlan[];
}

export interface DisposableWorktree {
  id: string;
}

export interface TargetOperation {
  proposalId: string;
  releaseIdentity: ReleaseIdentity;
  changelog: string;
  plan: ReleasePlan;
  target: FanoutTarget;
}

export interface AuthorizedTarget {
  identity: string;
  repository: string;
  baseBranch: string;
  authorized: boolean;
}

export interface WorktreeOperation extends TargetOperation {
  worktree: DisposableWorktree;
}

export interface VerifyResult {
  ok: boolean;
  evidence: string;
}

export interface ExecutorDeps {
  activeIdentity: () => string;
  authorizeTarget: (operation: TargetOperation & { identity: string }) => AuthorizedTarget;
  existingPullRequest: (operation: TargetOperation) => string | null;
  createWorktree: (operation: TargetOperation) => DisposableWorktree;
  readTargetRegistryOid: (operation: WorktreeOperation & { registry: string }) => string | null;
  writeTargetRegistryOid: (
    operation: WorktreeOperation & {
      registry: string;
      expectedOldOid: string;
      newOid: string;
    },
  ) => void;
  assertLockOnlyDiff: (operation: WorktreeOperation) => void;
  verify: (operation: WorktreeOperation) => VerifyResult;
  commit: (operation: WorktreeOperation) => string;
  push: (operation: WorktreeOperation & { commitOid: string }) => void;
  createPullRequest: (operation: WorktreeOperation & { commitOid: string }) => { url: string };
  cleanupWorktree: (operation: WorktreeOperation) => void;
}

export interface TargetApprovalResult {
  repository: string;
  baseBranch: string;
  status: TargetState;
  evidence: string;
}

export interface ApprovalResult {
  snapshot: ReleaseSnapshot;
  targets: TargetApprovalResult[];
}

interface Outcome {
  status: TargetState;
  evidence: string;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ID = /^[0-9a-f]{64}$/;
const MAX_CHANGELOG_LENGTH = 10_000;
const MAX_EVIDENCE = 256;
const TARGET_STATES = new Set<TargetState>([
  "pending",
  "not-eligible",
  "already-current",
  "existing-pr",
  "drifted",
  "verifying",
  "pr-opened",
  "failed",
]);
const SNAPSHOT_KEYS = ["schemaVersion", "id", "identity", "changelog", "state", "plans"];
const PLAN_KEYS = [
  "proposalId",
  "skill",
  "version",
  "registry",
  "branch",
  "target",
  "fanout",
  "status",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function evidence(value: unknown, fallback = "Target operation failed."): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return sanitizeForOutput(text || fallback).slice(0, MAX_EVIDENCE);
}

function sameTarget(a: FanoutTarget, b: FanoutTarget): boolean {
  return (
    a.repository === b.repository &&
    a.baseBranch === b.baseBranch &&
    a.registries.length === b.registries.length &&
    a.registries.every((registry, index) => registry === b.registries[index])
  );
}

function validPlan(snapshot: ReleaseSnapshot, raw: unknown): boolean {
  if (!isObject(raw) || !hasExactKeys(raw, PLAN_KEYS)) return false;
  const plan = raw as unknown as StoredReleasePlan;
  const target = parseRegistryFanout({ schemaVersion: 1, targets: [plan.target] });
  const fanout = parseRegistryFanout(plan.fanout);
  return (
    target.ok &&
    fanout.ok &&
    plan.proposalId === snapshot.id &&
    plan.version === snapshot.identity.version &&
    plan.registry === snapshot.identity.registry &&
    target.value.targets[0]?.registries.includes(snapshot.identity.registry) === true &&
    typeof plan.branch === "string" &&
    plan.branch.startsWith("chore/update-skill-") &&
    isSafeBranchRef(plan.branch) &&
    fanout.value.targets.length === 1 &&
    sameTarget(target.value.targets[0] as FanoutTarget, fanout.value.targets[0] as FanoutTarget) &&
    TARGET_STATES.has(plan.status)
  );
}

function validateSnapshot(snapshot: ReleaseSnapshot): boolean {
  if (!isObject(snapshot) || !hasExactKeys(snapshot, SNAPSHOT_KEYS)) return false;
  const identity = parseReleaseIdentity(snapshot.identity);
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.id !== "string" ||
    !ID.test(snapshot.id) ||
    !identity.ok ||
    typeof snapshot.changelog !== "string" ||
    snapshot.changelog.length > MAX_CHANGELOG_LENGTH ||
    sanitizeForOutput(snapshot.changelog) !== snapshot.changelog ||
    !Array.isArray(snapshot.plans) ||
    snapshot.plans.length === 0 ||
    !snapshot.plans.every((plan) => validPlan(snapshot, plan))
  )
    return false;

  const skill = snapshot.plans[0]?.skill;
  if (
    typeof skill !== "string" ||
    skill.length === 0 ||
    skill.length > 256 ||
    sanitizeForOutput(skill) !== skill ||
    snapshot.plans.some((plan) => plan.skill !== skill)
  )
    return false;

  const targets = parseRegistryFanout({
    schemaVersion: 1,
    targets: snapshot.plans.map((plan) => plan.target),
  });
  if (!targets.ok) return false;
  if (
    snapshot.id !== proposalIdFor(1, identity.value, identity.value.registry, targets.value.targets)
  )
    return false;

  const expected = buildReleasePlans(targets.value.targets, identity.value, skill);
  return (
    expected.length === snapshot.plans.length &&
    snapshot.plans.every((stored, index) => {
      const { status: _status, ...plan } = stored;
      return isDeepStrictEqual(plan, expected[index]);
    })
  );
}

function targetKey(plan: StoredReleasePlan): string {
  return `${plan.target.repository}\0${plan.target.baseBranch}\0${plan.registry}`;
}

function operationFor(snapshot: ReleaseSnapshot, plan: StoredReleasePlan): TargetOperation {
  const { status: _status, ...releasePlan } = plan;
  return {
    proposalId: snapshot.id,
    releaseIdentity: snapshot.identity,
    changelog: snapshot.changelog,
    plan: releasePlan,
    target: plan.target,
  };
}

function executeTarget(
  snapshot: ReleaseSnapshot,
  plan: StoredReleasePlan,
  deps: ExecutorDeps,
): Outcome {
  const operation = operationFor(snapshot, plan);
  try {
    const identity = deps.activeIdentity();
    const access = deps.authorizeTarget({ ...operation, identity });
    if (
      !identity ||
      !access.authorized ||
      access.identity !== identity ||
      access.repository !== plan.target.repository ||
      access.baseBranch !== plan.target.baseBranch
    ) {
      return { status: "failed", evidence: "Target authorization metadata mismatch." };
    }

    const existing = deps.existingPullRequest(operation);
    if (existing !== null) return { status: "existing-pr", evidence: evidence(existing) };

    const worktree = deps.createWorktree(operation);
    const worktreeOperation: WorktreeOperation = { ...operation, worktree };
    let outcome: Outcome;
    try {
      const oid = deps.readTargetRegistryOid({
        ...worktreeOperation,
        registry: snapshot.identity.registry,
      });
      if (oid === snapshot.identity.toOid) {
        outcome = { status: "already-current", evidence: "Registry is already current." };
      } else if (oid !== snapshot.identity.fromOid) {
        outcome = { status: "drifted", evidence: "Registry lock drifted from expected OID." };
      } else {
        deps.writeTargetRegistryOid({
          ...worktreeOperation,
          registry: snapshot.identity.registry,
          expectedOldOid: snapshot.identity.fromOid,
          newOid: snapshot.identity.toOid,
        });
        deps.assertLockOnlyDiff(worktreeOperation);
        const verified = deps.verify(worktreeOperation);
        if (!verified.ok) {
          outcome = {
            status: "failed",
            evidence: evidence(verified.evidence, "Verification failed."),
          };
        } else {
          const commitOid = deps.commit(worktreeOperation);
          if (!OID.test(commitOid)) throw new Error("Commit operation returned an invalid OID.");
          deps.push({ ...worktreeOperation, commitOid });
          const pullRequest = deps.createPullRequest({ ...worktreeOperation, commitOid });
          outcome = { status: "pr-opened", evidence: evidence(pullRequest.url) };
        }
      }
    } catch (error) {
      outcome = { status: "failed", evidence: evidence(error) };
    } finally {
      try {
        deps.cleanupWorktree(worktreeOperation);
      } catch (error) {
        outcome = { status: "failed", evidence: evidence(error, "Worktree cleanup failed.") };
      }
    }
    return outcome;
  } catch (error) {
    return { status: "failed", evidence: evidence(error) };
  }
}

export function approveProposal(
  snapshot: ReleaseSnapshot,
  options: { yes: boolean },
  deps: ExecutorDeps,
): ApprovalResult {
  if (!options.yes) throw new Error("Approval requires --yes.");
  if (snapshot.state !== "pending") throw new Error("Release proposal is not pending.");
  if (!validateSnapshot(snapshot)) throw new Error("Invalid release snapshot.");

  const plans = snapshot.plans.map((plan) => ({ ...plan }));
  const outcomes = new Map<string, Outcome>();
  for (const plan of plans) {
    if (plan.status !== "pending" && !outcomes.has(targetKey(plan))) {
      outcomes.set(targetKey(plan), { status: plan.status, evidence: "" });
    }
  }

  const targets: TargetApprovalResult[] = [];
  for (const plan of plans) {
    const key = targetKey(plan);
    const cached = outcomes.get(key);
    const outcome = cached ?? executeTarget(snapshot, plan, deps);
    outcomes.set(key, outcome);
    plan.status = outcome.status;
    targets.push({
      repository: plan.target.repository,
      baseBranch: plan.target.baseBranch,
      status: outcome.status,
      evidence: outcome.evidence,
    });
  }

  return {
    snapshot: {
      ...snapshot,
      state: plans.some((plan) => plan.status === "failed") ? "partial-failure" : "completed",
      plans,
    },
    targets,
  };
}

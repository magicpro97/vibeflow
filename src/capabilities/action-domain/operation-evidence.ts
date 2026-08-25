import type { ActionApprovalV1, ActionProposalV1 } from "../../actions/index.js";
import { deriveOperationId } from "../../actions/index.js";
import { canonicalJson } from "../../durability/index.js";
import type { CapabilityOperationAuthorityEvidenceV1 } from "../controller.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import {
  readOperationBaseLock,
  readOperationGraph,
  readOperationHeader,
} from "../operations/fold.js";
import type { CapabilityOperationActionAuthorityV1 } from "../operations/types.js";
import { assertCapabilityWalReferentialClosure } from "../operations/wal-referential.js";
import { capabilityClosurePackagePins } from "../planning/closure-packages.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import type { CapabilityStorageV1 } from "../storage/store.js";

export function readCapabilityDomainAuthorityEvidence(
  storage: CapabilityStorageV1,
  operationId: string,
  actionAuthority: CapabilityOperationActionAuthorityV1,
) {
  const prepared = readCapabilityDomainPreparedEvidence(storage, operationId, actionAuthority);
  const { header, plan } = prepared;
  const events = readCapabilityWal(storage.paths, operationId);
  assertCapabilityWalReferentialClosure(
    storage,
    header,
    plan,
    events,
    readOperationBaseLock(storage, plan),
  );
  let terminal: (typeof events)[number] | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (
      candidate?.payload.kind === "operation-transition" &&
      ["succeeded", "failed", "needs_recovery"].includes(candidate.payload.to)
    ) {
      terminal = candidate;
      break;
    }
  }
  const outcome =
    terminal?.payload.kind === "operation-transition"
      ? (terminal.payload.to as "succeeded" | "failed" | "needs_recovery")
      : null;
  return {
    header,
    plan,
    evidence: {
      ...prepared.evidence,
      terminal:
        outcome && terminal
          ? {
              outcome,
              domain_terminal_digest: terminal.event_digest,
              recorded_at: terminal.recorded_at,
            }
          : null,
    } satisfies CapabilityOperationAuthorityEvidenceV1,
  };
}

export function readCapabilityDomainPreparedEvidence(
  storage: CapabilityStorageV1,
  operationId: string,
  actionAuthority: CapabilityOperationActionAuthorityV1,
) {
  const header = readOperationHeader(storage, operationId);
  const plan = readOperationGraph(actionAuthority, header).plan;
  const evidence: CapabilityOperationAuthorityEvidenceV1 = {
    schema_version: "1.0",
    operation_id: operationId,
    header_digest: header.header_digest,
    prepared_at: header.created_at,
    terminal: null,
  };
  return { header, plan, evidence };
}

export function assertCapabilityDomainActionBinding(input: {
  proposal: ActionProposalV1;
  approval: Pick<ActionApprovalV1, "approval_id" | "approval_digest" | "decided_at">;
  operationId: string;
  domain: ReturnType<typeof readCapabilityDomainAuthorityEvidence>;
}): void {
  const { proposal, approval, operationId, domain } = input;
  const { header, plan } = domain;
  if (
    operationId !== deriveOperationId(proposal, approval.approval_id) ||
    header.operation_id !== operationId ||
    header.proposal_id !== proposal.proposal_id ||
    header.proposal_digest !== proposal.proposal_digest ||
    header.approval_id !== approval.approval_id ||
    header.approval_digest !== approval.approval_digest ||
    header.created_at !== approval.decided_at ||
    canonicalJson(header.action_root_locator) !== canonicalJson(proposal.action_root_locator) ||
    proposal.execution_object_closure_digest !== plan.execution_closure_digest ||
    proposal.adapter_set_digest !== plan.adapter_set_digest ||
    proposal.source_authority_set_digest !== plan.source_authority_set_digest ||
    proposal.policy_digest !== plan.runtime_closure.authority.policy_digest ||
    proposal.grant_digest !== plan.runtime_closure.authority.grant_digest ||
    proposal.permission_digest !== plan.permission_digest ||
    canonicalJson(proposal.target_set) !== canonicalJson(plan.targets) ||
    canonicalJson(proposal.package_pins) !==
      canonicalJson(
        capabilityClosurePackagePins(
          plan.runtime_closure.packages,
          plan.runtime_closure.effect_packages,
        ),
      )
  )
    throw new CapabilityRuntimeError(
      "capability domain evidence escaped the approved action closure",
      "authorization-mismatch",
    );
}

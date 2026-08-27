import { describe, expect, test } from "bun:test";
import { CAPABILITY_CLI_COMMAND } from "../src/actions/capability-cli-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../src/actions/index.js";
import { PUBLIC_ERROR_CODE } from "../src/actions/public-error-contract.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_GUIDED_STATUS,
  AUTHORITY_REPAIR_TERMINAL_STATE,
} from "../src/capabilities/authority-repair/index.js";
import { CAPABILITY_OPERATION_STATUS } from "../src/capabilities/wire/operation-state-contract.js";
import { authorityRepairMutationResult } from "../src/commands/capability/authority-repair-mutation-results.js";
import {
  authorityRepairPlanningCandidate,
  authorityRepairTerminalStatus,
} from "../src/commands/capability/authority-repair-runtime-helpers.js";
import { CAPABILITY_PLAN_STATUS } from "../src/core/capability-contract.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const proposal = {
  proposal_id: "proposal-authority-repair",
  proposal_digest: DIGEST,
  plan_digest: DIGEST,
  preview: { recovery_actions: [] },
};
const operation = { operation_id: "operation-authority-repair" };

describe("authority repair command helper coverage", () => {
  test("denied, recovery, and failed guided outcomes retain their distinct CLI authority", () => {
    const denied = authorityRepairMutationResult({
      status: AUTHORITY_REPAIR_GUIDED_STATUS.DENIED,
      proposal,
      approval: {},
      planned: {},
    } as never);
    expect(denied).toMatchObject({
      kind: "plan",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      status: CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      plan_digest: proposal.plan_digest,
      preview: proposal.preview,
      error: null,
    });

    const needsRecovery = authorityRepairMutationResult({
      status: AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY,
      proposal,
      approval: {},
      planned: {},
      operation,
      event: {},
    } as never);
    expect(needsRecovery).toMatchObject({
      kind: "mutation",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      status: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY,
      changed: true,
      operation_id: operation.operation_id,
      proposal_id: proposal.proposal_id,
      recovery_actions: [],
      error: { code: PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT },
    });

    const failed = authorityRepairMutationResult({
      status: AUTHORITY_REPAIR_GUIDED_STATUS.FAILED,
      proposal,
      approval: {},
      planned: {},
      operation,
      event: {},
    } as never);
    expect(failed).toMatchObject({
      kind: "mutation",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      status: CAPABILITY_OPERATION_STATUS.FAILED,
      changed: false,
      operation_id: operation.operation_id,
      proposal_id: proposal.proposal_id,
      recovery_actions: [],
      error: { code: PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT },
    });
  });

  test("ordinary conversation repair planning binds the exact conversation root", () => {
    const candidate = authorityRepairPlanningCandidate(
      {
        candidate_id: "candidate-authority-repair",
        control_state: AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID,
        authorization: { kind: "authenticated" },
        steps: {
          authority_scope: "conversation",
          scope_id: "root-session-authority-repair",
        },
        created_at: "2026-08-28T00:00:00.000Z",
        expires_at: "2026-08-28T00:05:00.000Z",
      } as never,
      null,
    );
    expect(candidate).toMatchObject({
      candidate_id: "candidate-authority-repair",
      action_domain: "conversation",
      action_root_locator: {
        kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
        root_session_id: "root-session-authority-repair",
      },
    });
  });

  test("terminal repair events map failures and reject non-terminal executor output", () => {
    expect(
      authorityRepairTerminalStatus({ state: AUTHORITY_REPAIR_TERMINAL_STATE.FAILED } as never),
    ).toBe(AUTHORITY_REPAIR_GUIDED_STATUS.FAILED);
    expect(
      authorityRepairTerminalStatus({
        state: AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY,
      } as never),
    ).toBe(AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY);
    expect(() => authorityRepairTerminalStatus({ state: "executing" } as never)).toThrow(
      "authority repair executor returned a non-terminal event",
    );
  });
});

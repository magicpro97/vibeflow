import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_CLI_COMMAND } from "../../src/actions/capability-cli-contract.js";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { ACTION_OPERATION_STATE } from "../../src/actions/index.js";
import {
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../src/actions/public-action-contract.js";
import type { CapabilityCliMutationInputV1 } from "../../src/capabilities/cli/ports.js";
import type { CapabilityOrdinaryAuthorityRuntimeV1 } from "../../src/capabilities/ordinary-authority-runtime.js";
import { CapabilityRuntimeFactoryV1 } from "../../src/capabilities/runtime-factory.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
} from "../../src/capabilities/source/authority-activation.js";
import { createCapabilityCliMutationPort } from "../../src/commands/capability/mutation-port.js";
import { executeOrdinaryAuthorityMutation } from "../../src/commands/capability/ordinary-authority-mutation-runtime.js";
import { cliAuthority } from "../../src/commands/capability/runtime.js";
import { CAPABILITY_PLAN_STATUS } from "../../src/core/capability-contract.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";

const roots: string[] = [];
const NOW = "2030-01-01T00:00:01.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-authority-command-edge-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const userHomeRoot = join(root, "home");
  const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: null }),
  );
  writeFileSync(
    join(userVibeflowRoot, "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: null }),
  );
  const now = () => NOW;
  activateProjectCapabilityAuthorityForVfInit(projectRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 3),
  });
  activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 4),
  });
  const factory = new CapabilityRuntimeFactoryV1({
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
    now,
  });
  const runtime = factory.ordinaryAuthority("user");
  const actor = {
    kind: ACTOR_KIND.HUMAN_CLI,
    public_actor_id: "authority-command-edge",
    credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
  } as const;
  return {
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
    now,
    factory,
    runtime,
    authority: cliAuthority(runtime.service, actor),
  };
}

function mutation(idempotencyKey: string, approve = true): CapabilityCliMutationInputV1 {
  return {
    schema_version: "1.0",
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE,
    request: {
      schema_version: "1.0",
      idempotency_key: idempotencyKey,
      scope: "user",
      planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID },
      action: {
        type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
        scope: "user",
        replacement_authority_subtree: { mode: "strict" },
      },
    },
    context: {
      actor: {
        kind: ACTOR_KIND.HUMAN_CLI,
        public_actor_id: "authority-command-edge",
        credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
      },
      stdin_is_tty: true,
      automation_grant_proof: null,
    },
    approve,
  };
}

function runtimeWithSnapshot(
  base: CapabilityOrdinaryAuthorityRuntimeV1,
  state: (typeof ACTION_OPERATION_STATE)[keyof typeof ACTION_OPERATION_STATE],
): CapabilityOrdinaryAuthorityRuntimeV1 {
  let published:
    | Parameters<
        CapabilityOrdinaryAuthorityRuntimeV1["actionStore"]["createProposal"]
      >[0]["proposal"]
    | null = null;
  const approval = { approval_id: "approval-command-edge" } as never;
  return {
    ...base,
    actionStore: {
      preparedProposal: () => null,
      createProposal: (
        input: Parameters<CapabilityOrdinaryAuthorityRuntimeV1["actionStore"]["createProposal"]>[0],
      ) => {
        published = input.proposal;
        return { created: true, proposal: input.proposal };
      },
      getRecorded: () =>
        published
          ? {
              proposal: published,
              approval: state === ACTION_OPERATION_STATE.PENDING_REVIEW ? null : approval,
              state,
              operation_id: null,
              dispatch_record_digest: null,
              domain_terminal_digest: null,
              events: [],
            }
          : null,
      issueChallenge: (
        input: Parameters<CapabilityOrdinaryAuthorityRuntimeV1["actionStore"]["issueChallenge"]>[0],
      ) => ({
        challenge_id: "challenge-command-edge",
        challenge_class: input.challenge_class,
        display_phrase: "user command edge",
        expires_at: "2030-01-01T00:30:00.000Z",
      }),
      decide: () => approval,
    } as never,
  };
}

describe("ordinary authority command runtime coverage edges", () => {
  test("returns failures for unsupported direct and port commands", () => {
    const direct = executeOrdinaryAuthorityMutation({
      mutation: { command: "future.authority.command" } as never,
      runtime: {} as never,
      authority: {} as never,
    });
    expect(direct.status).toBe("failed");

    const fx = fixture();
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.factory,
    });
    expect(port.execute({ command: "future.authority.command" } as never).status).toBe("failed");
  });

  test("rejects a prepared proposal owned by another request", () => {
    const fx = fixture();
    const input = mutation("replay-command-edge", false);
    if (!("request" in input)) throw new Error("authority request fixture is malformed");
    const prepared = fx.runtime.domain.prepareProposal({
      request_action: input.request.action as never,
      request_authority: fx.authority,
      idempotency_key: input.request.idempotency_key,
    });
    const runtime = {
      ...fx.runtime,
      actionStore: {
        preparedProposal: () => ({
          ...prepared.proposal,
          idempotency_key: "different-command-edge",
        }),
      } as never,
    };
    expect(() =>
      executeOrdinaryAuthorityMutation({
        mutation: input as never,
        runtime,
        authority: fx.authority,
      }),
    ).toThrow(/belongs to another request/);
  });

  test("returns action-required when a user-scope challenge cannot be answered", () => {
    const fx = fixture();
    const withoutInteraction = executeOrdinaryAuthorityMutation({
      mutation: mutation("missing-interaction-edge") as never,
      runtime: runtimeWithSnapshot(fx.runtime, ACTION_OPERATION_STATE.PENDING_REVIEW),
      authority: fx.authority,
    });
    expect(withoutInteraction.status).toBe(CAPABILITY_PLAN_STATUS.ACTION_REQUIRED);

    const declined = executeOrdinaryAuthorityMutation({
      mutation: mutation("declined-interaction-edge") as never,
      runtime: runtimeWithSnapshot(fx.runtime, ACTION_OPERATION_STATE.PENDING_REVIEW),
      authority: fx.authority,
      interaction: {
        authenticated_local_tty: true,
        respondToChallenge: () => null,
      },
    });
    expect(declined.status).toBe(CAPABILITY_PLAN_STATUS.ACTION_REQUIRED);
  });

  test("rejects a reviewed proposal that became non-executable", () => {
    const fx = fixture();
    expect(() =>
      executeOrdinaryAuthorityMutation({
        mutation: mutation("stale-snapshot-edge") as never,
        runtime: runtimeWithSnapshot(fx.runtime, ACTION_OPERATION_STATE.CANCELED),
        authority: fx.authority,
      }),
    ).toThrow(/no longer executable/);
  });
});

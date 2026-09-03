import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
  CAPABILITY_CLI_COMMAND,
} from "../src/actions/capability-cli-contract.js";
import { CAPABILITY_TRUST_TRANSITION } from "../src/actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import {
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../src/actions/public-action-contract.js";
import type { OrdinaryAuthorityMutationFaultPointV1 } from "../src/capabilities/authority-mutation/index.js";
import type {
  AuthorityApprovalCliInteractionV1,
  AuthorityRepairCliInteractionV1,
} from "../src/capabilities/cli/ports.js";
import { CapabilityRuntimeFactoryV1 } from "../src/capabilities/runtime-factory.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
} from "../src/capabilities/source/authority-activation.js";
import type {
  CapabilityCliResultV1,
  FabricCliMutationRequestV1,
} from "../src/capabilities/wire/cli.js";
import { authority } from "../src/commands/authority.js";
import { createCapabilityCliMutationPort } from "../src/commands/capability/mutation-port.js";
import { canonicalJsonBytes } from "../src/durability/index.js";
import { runBoundedNodeProcess } from "./helpers/abrupt-process.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(fault?: (point: OrdinaryAuthorityMutationFaultPointV1) => void) {
  const root = mkdtempSync(join(tmpdir(), "vf-authority-hardening-"));
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
  const now = () => "2030-01-01T00:00:01.000Z";
  activateProjectCapabilityAuthorityForVfInit(projectRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 3),
  });
  activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 4),
  });
  const runtime = new CapabilityRuntimeFactoryV1({
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
    now,
    ...(fault ? { ordinaryAuthorityFault: (_scope, point) => fault(point) } : {}),
  });
  return { root, projectRoot, userHomeRoot, userVibeflowRoot, now, runtime };
}

function jsonFile(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, canonicalJsonBytes(value));
  return path;
}

async function call(
  fx: ReturnType<typeof fixture>,
  argv: string[],
  input: { tty: boolean; interaction?: AuthorityApprovalCliInteractionV1 },
): Promise<{ code: number; result: CapabilityCliResultV1 }> {
  const output: string[] = [];
  const code = await authority([...argv, "--yes", "--json"], {
    base: fx.projectRoot,
    userHomeRoot: fx.userHomeRoot,
    userVibeflowRoot: fx.userVibeflowRoot,
    now: fx.now,
    stdinIsTTY: input.tty,
    stdinHasData: false,
    runtimeFactory: () => fx.runtime,
    authorityApprovalInteraction: input.interaction,
    writer: (message) => output.push(message),
  });
  return { code, result: JSON.parse(output[0] ?? "null") as CapabilityCliResultV1 };
}

async function issueAutomationProof(
  fx: ReturnType<typeof fixture>,
  actionType: (typeof HOST_ACTION_KIND)[keyof typeof HOST_ACTION_KIND],
  label: string,
): Promise<string> {
  const grantFile = jsonFile(fx.root, `${label}-grant.json`, {
    scope: "project",
    principal_id: `${label}-operator`,
    action_types: [actionType],
    permissions: [],
    target_engines: [],
    expires_at: "2031-01-01T00:00:00.000Z",
  });
  const issued = await call(
    fx,
    ["grant", "create", "--grant-file", grantFile, "--idempotency-key", `${label}-grant`],
    { tty: true },
  );
  if (issued.code !== 0) throw new Error(JSON.stringify(issued.result));
  const committed = fx.runtime.ordinaryAuthority("project").domain.store.readCommitted();
  const frame = committed.grants.at(-1);
  if (!frame) throw new Error("automation grant frame is absent");
  return jsonFile(fx.root, `${label}-proof.json`, {
    schema_version: "1.0",
    scope: "project",
    public_actor_id: frame.principal.public_actor_id,
    grant_id: frame.grant_id,
    grant_frame_digest: frame.frame_digest,
    authority_epoch: committed.current.authority_epoch,
    authority_head_digest: committed.current.content_digest,
  });
}

function treeSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) {
        snapshot.set(`${relative}/`, "directory");
        visit(path, relative);
      } else snapshot.set(relative, readFileSync(path).toString("base64"));
    }
  };
  visit(root, "");
  return snapshot;
}

const NO_PROOF_COMMANDS = Object.freeze([
  ["grant", "create"],
  ["grant", "renew"],
  ["grant", "revoke"],
  ["policy", "update"],
  ["secret", "revoke"],
  ["trust", "add"],
  ["trust", "rescope"],
  ["trust", "deprecate"],
  ["trust", "revoke"],
] as const);

const MISMATCH_POLICY_ACTION = Object.freeze({
  type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  scope: "project" as const,
  replacement_authority_subtree: { mode: "command-action-mismatch" },
}) satisfies FabricCliMutationRequestV1["action"];

const MISMATCH_GRANT_ACTION = Object.freeze({
  type: HOST_ACTION_KIND.GRANT_CREATE,
  grant: {
    scope: "project" as const,
    principal_id: "vf-command-action-mismatch",
    action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
    permissions: [],
    target_engines: [],
    expires_at: "2031-01-01T00:00:00.000Z",
  },
}) satisfies FabricCliMutationRequestV1["action"];

const mismatchTrustAction = (
  transition: (typeof CAPABILITY_TRUST_TRANSITION)[keyof typeof CAPABILITY_TRUST_TRANSITION],
): FabricCliMutationRequestV1["action"] => ({
  type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
  scope: "project",
  change: {
    transition,
    key_id: "vf-command-action-mismatch-key",
    algorithm: "Ed25519",
    public_key_spki_base64: "cHVibGljLWtleQ==",
    registry_origin: "https://registry.example",
    publisher_id: "vf-command-action-mismatch",
    valid_from: "2029-01-01T00:00:00.000Z",
    valid_until: "2031-01-01T00:00:00.000Z",
    reason: null,
  },
});

const MISMATCHED_COMMAND_ACTIONS = Object.freeze([
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE, MISMATCH_POLICY_ACTION],
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW, MISMATCH_POLICY_ACTION],
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE, MISMATCH_POLICY_ACTION],
  [CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE, MISMATCH_GRANT_ACTION],
  [CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE, MISMATCH_POLICY_ACTION],
  [
    CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD,
    mismatchTrustAction(CAPABILITY_TRUST_TRANSITION.RESCOPED),
  ],
  [
    CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE,
    mismatchTrustAction(CAPABILITY_TRUST_TRANSITION.DEPRECATED),
  ],
  [
    CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE,
    mismatchTrustAction(CAPABILITY_TRUST_TRANSITION.REVOKED),
  ],
  [
    CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE,
    mismatchTrustAction(CAPABILITY_TRUST_TRANSITION.ADDED),
  ],
] as const);

const AUTHENTICATED_APPROVAL_INTERACTION: AuthorityApprovalCliInteractionV1 = Object.freeze({
  authenticated_local_tty: true,
  respondToChallenge: () => null,
});

const AUTHENTICATED_REPAIR_INTERACTION: AuthorityRepairCliInteractionV1 = Object.freeze({
  authenticated_local_tty: true,
  selectCandidate: () => null,
  confirmCriticalReview: () => false,
  confirmRecoveryReview: () => false,
});

describe("public authority production hardening", () => {
  test("rejects every non-interactive ordinary command before the port without durable proof", async () => {
    let executions = 0;
    for (const words of NO_PROOF_COMMANDS) {
      const output: string[] = [];
      const code = await authority([...words, "--idempotency-key", `proof-${words.join("-")}`], {
        stdinIsTTY: false,
        stdinHasData: false,
        mutationPort: {
          execute: () => {
            executions += 1;
            return { schema_version: "1.0" } as never;
          },
        },
        writer: (message) => output.push(message),
      });
      expect(code).toBe(2);
      expect(output).toHaveLength(1);
    }
    expect(executions).toBe(0);
  });

  test("rejects a production-port non-TTY caller that claims an interactive credential", () => {
    const fx = fixture();
    const before = treeSnapshot(fx.projectRoot);
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE,
      request: {
        schema_version: "1.0",
        idempotency_key: "spoofed-interactive-port",
        scope: "project",
        planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID },
        action: {
          type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
          scope: "project",
          replacement_authority_subtree: { mode: "must-not-run" },
        },
      },
      context: {
        actor: {
          kind: ACTOR_KIND.HUMAN_CLI,
          public_actor_id: "spoofed-interactive-port",
          credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
        },
        stdin_is_tty: false,
        automation_grant_proof: null,
      },
      approve: true,
    });
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(treeSnapshot(fx.projectRoot)).toEqual(before);
  });

  test("binds a self-claimed interactive DTO to the child process TTY observation", async () => {
    const fx = fixture();
    const before = treeSnapshot(fx.projectRoot);
    const worker = join(fx.root, "authority-port-tty-worker.ts");
    const mutationPortUrl = pathToFileURL(
      join(process.cwd(), "src", "commands", "capability", "mutation-port.ts"),
    ).href;
    const cliContractUrl = pathToFileURL(
      join(process.cwd(), "src", "actions", "capability-cli-contract.ts"),
    ).href;
    const hostActionUrl = pathToFileURL(
      join(process.cwd(), "src", "actions", "host-action-contract.ts"),
    ).href;
    const publicActionUrl = pathToFileURL(
      join(process.cwd(), "src", "actions", "public-action-contract.ts"),
    ).href;
    writeFileSync(
      worker,
      `import { createCapabilityCliMutationPort } from ${JSON.stringify(mutationPortUrl)};
import { CAPABILITY_CLI_COMMAND } from ${JSON.stringify(cliContractUrl)};
import { HOST_ACTION_KIND } from ${JSON.stringify(hostActionUrl)};
import { ACTION_PLANNING_NETWORK_READ_VALUE, ACTOR_KIND, CREDENTIAL_CLASS } from ${JSON.stringify(publicActionUrl)};
const [base, home, userRoot] = process.argv.slice(2);
const port = createCapabilityCliMutationPort({ base, userHomeRoot: home, userVibeflowRoot: userRoot, now: () => "2030-01-01T00:00:01.000Z", authorityStdinIsTTY: Boolean(process.stdin.isTTY), authorityApprovalInteraction: { authenticated_local_tty: true, respondToChallenge: () => null } });
const result = port.execute({ schema_version: "1.0", command: CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE, request: { schema_version: "1.0", idempotency_key: "child-self-claimed-tty", scope: "project", planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID }, action: { type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY, scope: "project", replacement_authority_subtree: { mode: "must-not-run" } } }, context: { actor: { kind: ACTOR_KIND.HUMAN_CLI, public_actor_id: "child-self-claimed-tty", credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY }, stdin_is_tty: true, automation_grant_proof: null }, approve: true });
process.stdout.write(JSON.stringify(result));
`,
    );
    const child = await runBoundedNodeProcess({
      entrypoint: worker,
      args: [fx.projectRoot, fx.userHomeRoot, fx.userVibeflowRoot],
      expectedStatus: 0,
    });
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout).status).toBe("failed");
    expect(treeSnapshot(fx.projectRoot)).toEqual(before);
  });

  test("rejects self-claimed repair TTY despite an injected interaction", () => {
    const fx = fixture();
    const before = treeSnapshot(fx.projectRoot);
    let repairExecutions = 0;
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      authorityStdinIsTTY: false,
      authorityRepairInteraction: AUTHENTICATED_REPAIR_INTERACTION,
      authorityRepairRuntime: {
        execute() {
          repairExecutions += 1;
          return { schema_version: "1.0" } as never;
        },
      },
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      scope: "project",
      conversation_id: null,
      context: {
        actor: {
          kind: ACTOR_KIND.HUMAN_CLI,
          public_actor_id: "self-claimed-repair-tty",
          credential_class: CREDENTIAL_CLASS.RECOVERY,
        },
        stdin_is_tty: true,
      },
    });
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(repairExecutions).toBe(0);
    expect(treeSnapshot(fx.projectRoot)).toEqual(before);
  });

  test("rejects every mismatched ordinary command and action before durable composition", () => {
    const fx = fixture();
    const before = treeSnapshot(fx.projectRoot);
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      authorityApprovalInteraction: AUTHENTICATED_APPROVAL_INTERACTION,
      authorityStdinIsTTY: true,
      runtimeFactory: () => fx.runtime,
    });
    expect(MISMATCHED_COMMAND_ACTIONS.map(([command]) => command)).toEqual(
      CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS.filter(
        (command) => command !== CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      ),
    );
    for (const [command, action] of MISMATCHED_COMMAND_ACTIONS) {
      const result = port.execute({
        schema_version: "1.0",
        command,
        request: {
          schema_version: "1.0",
          idempotency_key: `mismatch-${command}`,
          scope: "project",
          planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID },
          action,
        },
        context: {
          actor: {
            kind: ACTOR_KIND.HUMAN_CLI,
            public_actor_id: "vf-command-action-mismatch",
            credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
          },
          stdin_is_tty: true,
          automation_grant_proof: null,
        },
        approve: true,
      });
      expect(result.status).toBe("failed");
      expect(result.error).not.toBeNull();
      expect(treeSnapshot(fx.projectRoot)).toEqual(before);
    }
  });

  test("binds an exact current automation grant through public non-TTY execution", async () => {
    const fx = fixture();
    const grantFile = jsonFile(fx.root, "automation-grant.json", {
      scope: "project",
      principal_id: "vf-automation-operator",
      action_types: [HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY],
      permissions: [],
      target_engines: [],
      expires_at: "2031-01-01T00:00:00.000Z",
    });
    expect(
      (
        await call(
          fx,
          ["grant", "create", "--grant-file", grantFile, "--idempotency-key", "issue-proof"],
          { tty: true },
        )
      ).code,
    ).toBe(0);
    const committed = fx.runtime.ordinaryAuthority("project").domain.store.readCommitted();
    const frame = committed.grants[0];
    if (!frame) throw new Error("automation grant frame is absent");
    const proofFile = jsonFile(fx.root, "automation-proof.json", {
      schema_version: "1.0",
      scope: "project",
      public_actor_id: frame.principal.public_actor_id,
      grant_id: frame.grant_id,
      grant_frame_digest: frame.frame_digest,
      authority_epoch: committed.current.authority_epoch,
      authority_head_digest: committed.current.content_digest,
    });
    const replacement = jsonFile(fx.root, "automation-policy.json", {
      replacement_authority_subtree: { mode: "automation-reviewed" },
    });
    const executed = await call(
      fx,
      [
        "policy",
        "update",
        "--scope",
        "project",
        "--replacement-file",
        replacement,
        "--automation-grant-file",
        proofFile,
        "--idempotency-key",
        "automation-policy",
      ],
      { tty: false },
    );
    if (executed.code !== 0) throw new Error(JSON.stringify(executed.result));
    expect(executed.code).toBe(0);
    expect(executed.result.status).toBe("succeeded");
    const after = fx.runtime.ordinaryAuthority("project").domain.store.readCommitted();
    expect(after.current.authority_epoch).toBe(2);
    const replayProof = jsonFile(fx.root, "automation-proof-replay.json", {
      schema_version: "1.0",
      scope: "project",
      public_actor_id: frame.principal.public_actor_id,
      grant_id: frame.grant_id,
      grant_frame_digest: frame.frame_digest,
      authority_epoch: after.current.authority_epoch,
      authority_head_digest: after.current.content_digest,
    });
    const replayed = await call(
      fx,
      [
        "policy",
        "update",
        "--scope",
        "project",
        "--replacement-file",
        replacement,
        "--automation-grant-file",
        replayProof,
        "--idempotency-key",
        "automation-policy",
      ],
      { tty: false },
    );
    expect(replayed).toEqual(executed);
    const admissionReplayed = await call(
      fx,
      [
        "policy",
        "update",
        "--scope",
        "project",
        "--replacement-file",
        replacement,
        "--automation-grant-file",
        proofFile,
        "--idempotency-key",
        "automation-policy",
      ],
      { tty: false },
    );
    expect(admissionReplayed).toEqual(executed);
  });

  test("keeps dry-run byte-for-byte read-only", async () => {
    const fx = fixture();
    const replacement = jsonFile(fx.root, "dry-run-policy.json", {
      replacement_authority_subtree: { mode: "preview-only" },
    });
    const before = treeSnapshot(fx.projectRoot);
    const output: string[] = [];
    const code = await authority(
      [
        "policy",
        "update",
        "--scope",
        "project",
        "--replacement-file",
        replacement,
        "--dry-run",
        "--json",
      ],
      {
        base: fx.projectRoot,
        userHomeRoot: fx.userHomeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
        stdinIsTTY: true,
        stdinHasData: false,
        runtimeFactory: () => fx.runtime,
        writer: (message) => output.push(message),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0] ?? "null").proposal_id).toBeNull();
    expect(treeSnapshot(fx.projectRoot)).toEqual(before);
  });

  test("keeps cold dry-run read-only without resuming a committing authority action", async () => {
    let activeFault: OrdinaryAuthorityMutationFaultPointV1 | null = "after-epoch-event";
    const fx = fixture((point) => {
      if (point === activeFault) throw new Error(`fault:${point}`);
    });
    const grantFile = jsonFile(fx.root, "dry-run-crash-grant.json", {
      scope: "project",
      principal_id: "vf-dry-run-crash-agent",
      action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
      permissions: [],
      target_engines: [],
      expires_at: "2031-01-01T00:00:00.000Z",
    });
    const argv = [
      "grant",
      "create",
      "--grant-file",
      grantFile,
      "--idempotency-key",
      "dry-run-must-not-recover",
    ];
    await expect(call(fx, argv, { tty: true })).rejects.toThrow("fault:after-epoch-event");
    activeFault = null;
    const cold = new CapabilityRuntimeFactoryV1({
      projectRoot: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
    });
    const before = treeSnapshot(fx.projectRoot);
    const output: string[] = [];
    const code = await authority([...argv, "--dry-run", "--json"], {
      base: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      stdinIsTTY: true,
      stdinHasData: false,
      runtimeFactory: () => cold,
      writer: (message) => output.push(message),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output[0] ?? "null").status).toBe("planned");
    expect(treeSnapshot(fx.projectRoot)).toEqual(before);
    expect(
      cold.ordinaryAuthority("project").domain.store.readCommitted().current.authority_epoch,
    ).toBe(1);
  });

  test("cold-replays both interrupted Action proposal publication windows exactly", async () => {
    for (const publicationFault of [
      "after-idempotency-prepared",
      "after-authority-sequence-zero",
    ] as const) {
      let activeFault: typeof publicationFault | null = null;
      const fx = fixture(undefined);
      const proofFile = await issueAutomationProof(
        fx,
        HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
        publicationFault,
      );
      const replacement = jsonFile(fx.root, `${publicationFault}-policy.json`, {
        replacement_authority_subtree: { publication_fault: publicationFault },
      });
      const faulting = new CapabilityRuntimeFactoryV1({
        projectRoot: fx.projectRoot,
        userHomeRoot: fx.userHomeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
        ordinaryAuthorityActionFault: (_scope, point) => {
          if (point === activeFault) throw new Error(`fault:${point}`);
        },
      });
      activeFault = publicationFault;
      const argv = [
        "policy",
        "update",
        "--scope",
        "project",
        "--replacement-file",
        replacement,
        "--automation-grant-file",
        proofFile,
        "--idempotency-key",
        `recover-${publicationFault}`,
      ];
      await expect(
        authority([...argv, "--yes", "--json"], {
          base: fx.projectRoot,
          userHomeRoot: fx.userHomeRoot,
          userVibeflowRoot: fx.userVibeflowRoot,
          now: fx.now,
          stdinIsTTY: false,
          stdinHasData: false,
          runtimeFactory: () => faulting,
          writer: () => undefined,
        }),
      ).rejects.toThrow(`fault:${publicationFault}`);
      activeFault = null;
      const proposalsRoot = join(
        fx.projectRoot,
        ".vibeflow",
        "private",
        "capabilities",
        "actions",
        "v1",
        "proposals",
      );
      const prepared = readdirSync(proposalsRoot)
        .map((name) => JSON.parse(readFileSync(join(proposalsRoot, name), "utf8")))
        .find((proposal) => proposal.idempotency_key === `recover-${publicationFault}`);
      if (!prepared) throw new Error("interrupted proposal preimage is absent");
      const cold = new CapabilityRuntimeFactoryV1({
        projectRoot: fx.projectRoot,
        userHomeRoot: fx.userHomeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
      });
      const output: string[] = [];
      const code = await authority([...argv, "--yes", "--json"], {
        base: fx.projectRoot,
        userHomeRoot: fx.userHomeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
        stdinIsTTY: false,
        stdinHasData: false,
        runtimeFactory: () => cold,
        writer: (message) => output.push(message),
      });
      expect(code).toBe(0);
      expect(JSON.parse(output[0] ?? "null").proposal_id).toBe(prepared.proposal_id);
      expect(
        readdirSync(proposalsRoot)
          .map((name) => JSON.parse(readFileSync(join(proposalsRoot, name), "utf8")))
          .filter((proposal) => proposal.idempotency_key === `recover-${publicationFault}`),
      ).toHaveLength(1);
    }
  });

  test("issues, displays, and consumes the durable fresh-user-scope challenge", async () => {
    const fx = fixture();
    const replacement = jsonFile(fx.root, "user-policy.json", {
      replacement_authority_subtree: { mode: "user-reviewed" },
    });
    let challengeId = "";
    let phrase = "";
    const interaction: AuthorityApprovalCliInteractionV1 = {
      authenticated_local_tty: true,
      respondToChallenge(input) {
        challengeId = input.challenge_id;
        phrase = input.display_phrase;
        return input.display_phrase;
      },
    };
    const executed = await call(
      fx,
      [
        "policy",
        "update",
        "--scope",
        "user",
        "--replacement-file",
        replacement,
        "--idempotency-key",
        "user-challenge",
      ],
      { tty: true, interaction },
    );
    expect(executed.code).toBe(0);
    expect(phrase).toMatch(/^user [a-f0-9]{12}$/);
    expect(fx.runtime.ordinaryAuthority("user").actionStore.getChallenge(challengeId)?.state).toBe(
      "consumed",
    );
  });

  test("serializes concurrent processes to one exact grant proposal and result", async () => {
    const fx = fixture();
    const grantFile = jsonFile(fx.root, "concurrent-grant.json", {
      scope: "project",
      principal_id: "vf-concurrent-agent",
      action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
      permissions: [],
      target_engines: [],
      expires_at: "2031-01-01T00:00:00.000Z",
    });
    const worker = join(fx.root, "authority-worker.ts");
    const authorityUrl = pathToFileURL(join(process.cwd(), "src", "commands", "authority.ts")).href;
    writeFileSync(
      worker,
      `import { authority } from ${JSON.stringify(authorityUrl)};\nconst [base, home, userRoot, grant] = process.argv.slice(2);\nconst code = await authority(["grant","create","--grant-file",grant,"--idempotency-key","concurrent-create","--yes","--json"], { base, userHomeRoot: home, userVibeflowRoot: userRoot, now: () => "2030-01-01T00:00:01.000Z", stdinIsTTY: true, stdinHasData: false, writer: (message) => process.stdout.write(message) });\nprocess.exitCode = code;\n`,
    );
    const processOptions = {
      entrypoint: worker,
      args: [fx.projectRoot, fx.userHomeRoot, fx.userVibeflowRoot, grantFile],
      expectedStatus: 0,
      timeoutMs: 25_000,
    } as const;
    const [first, second] = await Promise.all([
      runBoundedNodeProcess(processOptions),
      runBoundedNodeProcess(processOptions),
    ]);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    const reopened = new CapabilityRuntimeFactoryV1({
      projectRoot: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
    });
    const committed = reopened.ordinaryAuthority("project").domain.store.readCommitted();
    expect(committed.current.authority_epoch).toBe(1);
    expect(committed.events).toHaveLength(1);
    expect(committed.grants).toHaveLength(1);
  }, 30_000);

  test("replays concurrent automation calls byte-exactly from their admission proof", async () => {
    const fx = fixture();
    const proofFile = await issueAutomationProof(
      fx,
      HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
      "concurrent-automation",
    );
    const replacement = jsonFile(fx.root, "concurrent-automation-policy.json", {
      replacement_authority_subtree: { mode: "concurrent-automation" },
    });
    const worker = join(fx.root, "authority-automation-worker.ts");
    const authorityUrl = pathToFileURL(join(process.cwd(), "src", "commands", "authority.ts")).href;
    writeFileSync(
      worker,
      `import { authority } from ${JSON.stringify(authorityUrl)};\nconst [base, home, userRoot, replacement, proof] = process.argv.slice(2);\nconst code = await authority(["policy","update","--scope","project","--replacement-file",replacement,"--automation-grant-file",proof,"--idempotency-key","concurrent-automation-policy","--yes","--json"], { base, userHomeRoot: home, userVibeflowRoot: userRoot, now: () => "2030-01-01T00:00:01.000Z", stdinIsTTY: false, stdinHasData: false, writer: (message) => process.stdout.write(message) });\nprocess.exitCode = code;\n`,
    );
    const processOptions = {
      entrypoint: worker,
      args: [fx.projectRoot, fx.userHomeRoot, fx.userVibeflowRoot, replacement, proofFile],
      expectedStatus: 0,
      timeoutMs: 25_000,
    } as const;
    const [first, second] = await Promise.all([
      runBoundedNodeProcess(processOptions),
      runBoundedNodeProcess(processOptions),
    ]);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    const reopened = new CapabilityRuntimeFactoryV1({
      projectRoot: fx.projectRoot,
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
    });
    const committed = reopened.ordinaryAuthority("project").domain.store.readCommitted();
    expect(committed.current.authority_epoch).toBe(2);
    expect(committed.events).toHaveLength(2);
  }, 30_000);
});

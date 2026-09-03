import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
  CAPABILITY_CLI_COMMAND,
} from "../src/actions/capability-cli-contract.js";
import { CAPABILITY_TRUST_TRANSITION } from "../src/actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND, actionIdempotencyScopeDigest } from "../src/actions/index.js";
import {
  AUTHORITY_CHANGE_DIGEST_DOMAIN,
  type SecretRevocationCandidateV1,
} from "../src/capabilities/authority-mutation/index.js";
import type { CapabilityCliMutationInputV1 } from "../src/capabilities/cli/ports.js";
import { CliCapabilityPrivateInputAuthorityV1 } from "../src/capabilities/private-input/authority.js";
import { CliPrivateInputDurableStoreV1 } from "../src/capabilities/private-input/storage.js";
import { CapabilityRuntimeFactoryV1 } from "../src/capabilities/runtime-factory.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
} from "../src/capabilities/source/authority-activation.js";
import { projectCapabilityPaths } from "../src/capabilities/storage/paths.js";
import type {
  CapabilityCliResultV1,
  FabricCliAuthorityMutationCommandV1,
  FabricCliMutationRequestV1,
} from "../src/capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../src/capabilities/wire/operation-state-contract.js";
import { authority } from "../src/commands/authority.js";
import { canonicalJsonBytes, digestV1, ensurePrivateDirectory } from "../src/durability/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vf-authority-request-file-"));
  roots.push(root);
  return root;
}

function jsonFile(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, canonicalJsonBytes(value));
  return path;
}

function succeeded(command: FabricCliAuthorityMutationCommandV1): CapabilityCliResultV1 {
  return {
    schema_version: "1.0",
    kind: "mutation",
    command,
    status: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
    changed: true,
    operation_id: "vf-operation-request-file",
    proposal_id: "vf-proposal-request-file",
    plan_digest: `sha256:${"a".repeat(64)}`,
    generation_id: null,
    targets: [],
    recovery_actions: [],
    error: null,
  };
}

const GRANT_INPUT = Object.freeze({
  scope: "project" as const,
  principal_id: "vf-request-file-principal",
  action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
  permissions: [],
  target_engines: ["codex" as const],
  expires_at: "2031-01-01T00:00:00.000Z",
});

const TRUST_KEY_BASE = Object.freeze({
  key_id: "vf-request-file-key",
  algorithm: "Ed25519" as const,
  public_key_spki_base64: "cHVibGljLWtleQ==",
  registry_origin: "https://registry.example",
  publisher_id: "acme",
  valid_from: "2029-01-01T00:00:00.000Z",
  valid_until: "2031-01-01T00:00:00.000Z",
  reason: null,
});

const GRANT_CREATE_ACTION = Object.freeze({
  type: HOST_ACTION_KIND.GRANT_CREATE,
  grant: GRANT_INPUT,
});

const REQUEST_FILE_CASES = Object.freeze([
  {
    words: ["grant", "create"],
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE,
    action: GRANT_CREATE_ACTION,
  },
  {
    words: ["grant", "renew"],
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW,
    action: {
      type: HOST_ACTION_KIND.GRANT_RENEW,
      grant_id: "vf-grant-existing",
      grant: GRANT_INPUT,
    },
  },
  {
    words: ["grant", "revoke"],
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
    action: {
      type: HOST_ACTION_KIND.GRANT_REVOKE,
      scope: "project",
      grant_id: "vf-grant-existing",
    },
  },
  {
    words: ["policy", "update"],
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE,
    action: {
      type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
      scope: "project",
      replacement_authority_subtree: { mode: "request-file" },
    },
  },
  {
    words: ["secret", "revoke"],
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
    action: {
      type: HOST_ACTION_KIND.SECRET_REVOKE,
      scope: "project",
      private_binding_id: `vf-secret-revocation-binding-${"b".repeat(64)}`,
      expected_binding_digest: `sha256:${"b".repeat(64)}`,
    },
  },
  ...(
    [
      ["add", CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD, CAPABILITY_TRUST_TRANSITION.ADDED],
      [
        "rescope",
        CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE,
        CAPABILITY_TRUST_TRANSITION.RESCOPED,
      ],
      [
        "deprecate",
        CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE,
        CAPABILITY_TRUST_TRANSITION.DEPRECATED,
      ],
      [
        "revoke",
        CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE,
        CAPABILITY_TRUST_TRANSITION.REVOKED,
      ],
    ] as const
  ).map(([subcommand, command, transition]) => ({
    words: ["trust", subcommand],
    command,
    action: {
      type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
      scope: "project" as const,
      change: { ...TRUST_KEY_BASE, transition },
    },
  })),
] satisfies ReadonlyArray<{
  words: readonly string[];
  command: Exclude<
    FabricCliAuthorityMutationCommandV1,
    typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
  >;
  action: FabricCliMutationRequestV1["action"];
}>);

describe("authority request-file hardening", () => {
  test("forwards all nine non-TTY request files without a contradictory outer idempotency key", async () => {
    const root = tempRoot();
    const proofFile = jsonFile(root, "automation-proof.json", {
      schema_version: "1.0",
      scope: "project",
      public_actor_id: "vf-request-file-automation",
      grant_id: "vf-grant-automation",
      grant_frame_digest: `sha256:${"c".repeat(64)}`,
      authority_epoch: 7,
      authority_head_digest: `sha256:${"d".repeat(64)}`,
    });
    const seen: CapabilityCliMutationInputV1[] = [];
    for (const [index, row] of REQUEST_FILE_CASES.entries()) {
      const requestFile = jsonFile(root, `request-${index}.json`, {
        schema_version: "1.0",
        idempotency_key: `request-file-${index}`,
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: row.action,
      });
      const output: string[] = [];
      const code = await authority(
        [
          ...row.words,
          "--request-file",
          requestFile,
          "--automation-grant-file",
          proofFile,
          "--yes",
          "--json",
        ],
        {
          stdinIsTTY: false,
          stdinHasData: false,
          mutationPort: {
            execute(input) {
              seen.push(input);
              return succeeded(row.command);
            },
          },
          writer: (message) => output.push(message),
        },
      );
      expect(code).toBe(0);
      expect(output).toHaveLength(1);
      const input = seen.at(-1);
      if (!input || !("request" in input)) throw new Error("request-file did not reach the port");
      expect(input.command).toBe(row.command);
      expect(input.request.idempotency_key).toBe(`request-file-${index}`);
      expect(input.request.action).toEqual(row.action);
      expect(input.context.automation_grant_proof?.public_actor_id).toBe(
        "vf-request-file-automation",
      );
    }
    const advertised = CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS.filter(
      (command) => command !== CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
    );
    expect(new Set(seen.map((input) => input.command))).toEqual(new Set(advertised));
  });

  test("keeps outer idempotency exclusive and still requires it for direct non-TTY mutations", async () => {
    const root = tempRoot();
    const proofFile = jsonFile(root, "proof.json", {
      schema_version: "1.0",
      scope: "project",
      public_actor_id: "vf-request-file-automation",
      grant_id: "vf-grant-automation",
      grant_frame_digest: `sha256:${"e".repeat(64)}`,
      authority_epoch: 1,
      authority_head_digest: `sha256:${"f".repeat(64)}`,
    });
    const requestFile = jsonFile(root, "request.json", {
      schema_version: "1.0",
      idempotency_key: "inside-request",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: GRANT_CREATE_ACTION,
    });
    let executions = 0;
    const inject = {
      stdinIsTTY: false,
      stdinHasData: false,
      mutationPort: {
        execute() {
          executions += 1;
          return succeeded(CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE);
        },
      },
      writer: () => undefined,
    } as const;
    expect(
      await authority(
        [
          "grant",
          "create",
          "--request-file",
          requestFile,
          "--automation-grant-file",
          proofFile,
          "--idempotency-key",
          "outside-request",
        ],
        inject,
      ),
    ).toBe(2);
    expect(
      await authority(
        ["grant", "create", "--grant-file", requestFile, "--automation-grant-file", proofFile],
        inject,
      ),
    ).toBe(2);
    expect(executions).toBe(0);
  });

  test("executes secret revoke from a request file only after resolving its exact live candidate", async () => {
    const root = tempRoot();
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    for (const path of [
      join(projectRoot, ".vibeflow", "SETTINGS.json"),
      join(userVibeflowRoot, "SETTINGS.json"),
    ])
      writeFileSync(path, canonicalJsonBytes({ schema_version: "1.0", authority: null }));
    const now = () => "2030-01-01T00:00:01.000Z";
    const activation = activateProjectCapabilityAuthorityForVfInit(projectRoot, {
      now,
      random_bytes: (size) => Buffer.alloc(size, 9),
    });
    activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, {
      now,
      random_bytes: (size) => Buffer.alloc(size, 10),
    });
    const runtime = new CapabilityRuntimeFactoryV1({
      projectRoot,
      userHomeRoot,
      userVibeflowRoot,
      now,
    });
    const ordinary = runtime.ordinaryAuthority("project");
    const paths = projectCapabilityPaths(projectRoot);
    ensurePrivateDirectory(join(paths.privateRoot, "actions", "v1"));
    const packageId = "acme.request-file-secret";
    const packagePinDigest = digestV1("VF-REQUEST-FILE-PIN\0v1\0", packageId);
    const manifestDigest = digestV1("VF-REQUEST-FILE-MANIFEST\0v1\0", packageId);
    const inputId = "token";
    const locator = {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: "project" as const,
      scope_identity_digest: activation.identity.content_digest,
    };
    const privateInputs = new CliCapabilityPrivateInputAuthorityV1({
      root: paths.privateRoot,
      scope: "project",
      scopeIdentityDigest: activation.identity.content_digest,
      principalDigest: digestV1("VF-REQUEST-FILE-PRINCIPAL\0v1\0", packageId),
      authorityScopeDigest: actionIdempotencyScopeDigest(locator),
      now,
    });
    const projected = privateInputs.bind({
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: activation.identity.content_digest,
      package_id: packageId,
      package_pin_digest: packagePinDigest,
      manifest_digest: manifestDigest,
      idempotency_key: "request-file-secret-source",
      values: { [inputId]: "secret-value" },
      expires_at: "2032-01-01T00:00:00.000Z",
    });
    const store = new CliPrivateInputDurableStoreV1(paths.privateRoot);
    const binding = store.readBinding(store.bindingPath(projected.private_binding_id));
    const head = store.readHead({
      scope: "project",
      scope_identity_digest: activation.identity.content_digest,
      package_id: packageId,
      package_pin_digest: packagePinDigest,
      manifest_digest: manifestDigest,
      input_id: inputId,
    });
    const bindingRow = binding?.bindings[0];
    if (!binding || !head || !bindingRow) throw new Error("secret source fixture is incomplete");
    const preimage = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: activation.identity.content_digest,
      package_id: packageId,
      input_id: inputId,
      secret_handle_id_digest: bindingRow.secret_handle_id_digest,
      broker_binding_epoch: bindingRow.broker_binding_epoch,
      broker_scope_digest: bindingRow.broker_scope_digest,
      source_current_head_digest: head.head_digest,
      source_action_root_locator: locator,
      source_private_input_binding_digest: binding.binding_digest,
      created_at: binding.created_at,
    };
    const candidateDigest = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, preimage);
    const candidate: SecretRevocationCandidateV1 = {
      ...preimage,
      private_binding_id: `vf-secret-revocation-binding-${candidateDigest.slice("sha256:".length)}`,
      binding_digest: candidateDigest,
    };
    ordinary.secretCandidates.persist(candidate);
    const requestFile = jsonFile(root, "secret-request.json", {
      schema_version: "1.0",
      idempotency_key: "request-file-secret-revoke",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: {
        type: HOST_ACTION_KIND.SECRET_REVOKE,
        scope: "project",
        private_binding_id: candidate.private_binding_id,
        expected_binding_digest: candidate.binding_digest,
      },
    });
    const staleRequestFile = jsonFile(root, "stale-secret-request.json", {
      schema_version: "1.0",
      idempotency_key: "request-file-stale-secret-revoke",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: {
        type: HOST_ACTION_KIND.SECRET_REVOKE,
        scope: "project",
        private_binding_id: candidate.private_binding_id,
        expected_binding_digest: `sha256:${"0".repeat(64)}`,
      },
    });
    const rejectedOutput: string[] = [];
    const rejectedCode = await authority(
      ["secret", "revoke", "--request-file", staleRequestFile, "--yes", "--json"],
      {
        base: projectRoot,
        userHomeRoot,
        userVibeflowRoot,
        now,
        stdinIsTTY: true,
        stdinHasData: false,
        runtimeFactory: () => runtime,
        writer: (message) => rejectedOutput.push(message),
      },
    );
    expect(rejectedCode).not.toBe(0);
    expect(JSON.parse(rejectedOutput[0] ?? "null").status).toBe(CAPABILITY_OPERATION_STATUS.FAILED);
    expect(ordinary.domain.store.readCommitted().secrets).toHaveLength(0);
    const output: string[] = [];
    const code = await authority(
      ["secret", "revoke", "--request-file", requestFile, "--yes", "--json"],
      {
        base: projectRoot,
        userHomeRoot,
        userVibeflowRoot,
        now,
        stdinIsTTY: true,
        stdinHasData: false,
        runtimeFactory: () => runtime,
        writer: (message) => output.push(message),
      },
    );
    expect(code).toBe(0);
    const result = JSON.parse(output[0] ?? "null") as CapabilityCliResultV1;
    expect(result.status).toBe(CAPABILITY_OPERATION_STATUS.SUCCEEDED);
    const committed = runtime.ordinaryAuthority("project").domain.store.readCommitted();
    expect(committed.secrets).toHaveLength(1);
    expect(committed.secrets[0]?.expected_binding_digest).toBe(candidate.binding_digest);
  });
});

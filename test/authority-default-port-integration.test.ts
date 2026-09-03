import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
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
  type OrdinaryAuthorityMutationFaultPointV1,
  type SecretRevocationCandidateV1,
} from "../src/capabilities/authority-mutation/index.js";
import { CliCapabilityPrivateInputAuthorityV1 } from "../src/capabilities/private-input/authority.js";
import { CliPrivateInputDurableStoreV1 } from "../src/capabilities/private-input/storage.js";
import { CapabilityRuntimeFactoryV1 } from "../src/capabilities/runtime-factory.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../src/capabilities/source/authority-activation.js";
import { activateUserCapabilityAuthorityForTrustedInstall } from "../src/capabilities/source/authority-activation.js";
import { projectCapabilityPaths } from "../src/capabilities/storage/paths.js";
import type { CapabilityCliResultV1 } from "../src/capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../src/capabilities/wire/operation-state-contract.js";
import { authority } from "../src/commands/authority.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
} from "../src/durability/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorityDefaultPortFixture(
  fault?: (scope: "project" | "user", point: OrdinaryAuthorityMutationFaultPointV1) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "vf-authority-default-port-"));
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
  let clock = Date.parse("2030-01-01T00:00:01.000Z");
  const now = () => new Date(clock).toISOString();
  const activation = activateProjectCapabilityAuthorityForVfInit(projectRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 7),
  });
  const userActivation = activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, {
    now,
    random_bytes: (size) => Buffer.alloc(size, 8),
  });
  const options = {
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
    now,
    ...(fault ? { ordinaryAuthorityFault: fault } : {}),
  };
  let runtime = new CapabilityRuntimeFactoryV1(options);

  async function run(argv: string[]): Promise<CapabilityCliResultV1> {
    const output: string[] = [];
    const code = await authority([...argv, "--yes", "--json"], {
      base: projectRoot,
      userHomeRoot,
      userVibeflowRoot,
      now,
      stdinIsTTY: true,
      stdinHasData: false,
      runtimeFactory: () => runtime,
      writer: (message) => output.push(message),
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0] ?? "") as CapabilityCliResultV1;
    expect(result.status).toBe(CAPABILITY_OPERATION_STATUS.SUCCEEDED);
    clock += 1_000;
    return result;
  }

  return {
    root,
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
    now,
    activation,
    userActivation,
    options,
    run,
    runtime: () => runtime,
    restart: () => {
      runtime = new CapabilityRuntimeFactoryV1(options);
      return runtime;
    },
  };
}

function writeAuthorityTestJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, canonicalJsonBytes(value));
  return path;
}

function authorityTestGrant(scope: "project" | "user", expiresAt: string) {
  return {
    scope,
    principal_id: "vf-principal-default-port",
    action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
    permissions: [],
    target_engines: ["codex"],
    expires_at: expiresAt,
  };
}

function stageSecretCandidate(
  fx: ReturnType<typeof authorityDefaultPortFixture>,
): SecretRevocationCandidateV1 {
  const runtime = fx.runtime();
  const service = runtime.service("project");
  const paths = projectCapabilityPaths(fx.projectRoot);
  const packageId = "acme.secret-demo";
  const packagePinDigest = digestV1("VF-TEST-AUTHORITY-PIN\0v1\0", packageId);
  const manifestDigest = digestV1("VF-TEST-AUTHORITY-MANIFEST\0v1\0", packageId);
  const inputId = "token";
  const locator = {
    kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
    scope: "project" as const,
    scope_identity_digest: fx.activation.identity.content_digest,
  };
  const privateInputs = new CliCapabilityPrivateInputAuthorityV1({
    root: paths.privateRoot,
    scope: "project",
    scopeIdentityDigest: fx.activation.identity.content_digest,
    principalDigest: digestV1("VF-TEST-AUTHORITY-PRIVATE-PRINCIPAL\0v1\0", packageId),
    authorityScopeDigest: actionIdempotencyScopeDigest(locator),
    now: fx.now,
  });
  const projected = privateInputs.bind({
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: fx.activation.identity.content_digest,
    package_id: packageId,
    package_pin_digest: packagePinDigest,
    manifest_digest: manifestDigest,
    idempotency_key: "authority-secret-source",
    values: { [inputId]: "test-secret-value" },
    expires_at: "2032-01-01T00:00:00.000Z",
  });
  const store = new CliPrivateInputDurableStoreV1(paths.privateRoot);
  const binding = store.readBinding(store.bindingPath(projected.private_binding_id));
  const head = store.readHead({
    scope: "project",
    scope_identity_digest: fx.activation.identity.content_digest,
    package_id: packageId,
    package_pin_digest: packagePinDigest,
    manifest_digest: manifestDigest,
    input_id: inputId,
  });
  const row = binding?.bindings[0];
  if (!binding || !head || !row) throw new Error("private secret source fixture is incomplete");
  const preimage = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: fx.activation.identity.content_digest,
    package_id: packageId,
    input_id: inputId,
    secret_handle_id_digest: row.secret_handle_id_digest,
    broker_binding_epoch: row.broker_binding_epoch,
    broker_scope_digest: row.broker_scope_digest,
    source_current_head_digest: head.head_digest,
    source_action_root_locator: locator,
    source_private_input_binding_digest: binding.binding_digest,
    created_at: binding.created_at,
  };
  const bindingDigest = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, preimage);
  const candidate: SecretRevocationCandidateV1 = {
    ...preimage,
    private_binding_id: `vf-secret-revocation-binding-${bindingDigest.slice("sha256:".length)}`,
    binding_digest: bindingDigest,
  };
  const lock = acquireProcessLock(join(paths.privateRoot, "actions", "v1", "writer.lock"), {
    operation: "authority-default-port-secret-candidate",
    coverageRoot: paths.privateRoot,
  });
  try {
    createOrVerifyPrivateFile(
      join(
        paths.privateRoot,
        "actions",
        "v1",
        "secret-revocation-candidates",
        `${candidate.private_binding_id}.json`,
      ),
      canonicalJsonBytes(candidate),
      { lock },
    );
  } finally {
    lock.release();
  }
  expect(service.options.storage.scopeIdentityDigest).toBe(candidate.scope_identity_digest);
  return candidate;
}

describe("public authority command production mutation port", () => {
  test("executes every advertised ordinary authority command through the durable chain", async () => {
    const fx = authorityDefaultPortFixture();
    const createGrantFile = writeAuthorityTestJson(
      fx.root,
      "grant-create.json",
      authorityTestGrant("project", "2031-01-01T00:00:00.000Z"),
    );
    const observed: Array<string | null> = [];
    observed.push(
      (
        await fx.run([
          "grant",
          "create",
          "--grant-file",
          createGrantFile,
          "--idempotency-key",
          "public-grant-create",
        ])
      ).command,
    );
    const issued = fx.runtime().ordinaryAuthority("project").domain.store.readCommitted().grants[0];
    if (!issued) throw new Error("grant create did not commit its authority frame");
    const renewGrantFile = writeAuthorityTestJson(
      fx.root,
      "grant-renew.json",
      authorityTestGrant("project", "2032-01-01T00:00:00.000Z"),
    );
    observed.push(
      (
        await fx.run([
          "grant",
          "renew",
          "--grant-id",
          issued.grant_id,
          "--grant-file",
          renewGrantFile,
          "--idempotency-key",
          "public-grant-renew",
        ])
      ).command,
    );
    const replacementFile = writeAuthorityTestJson(fx.root, "policy.json", {
      replacement_authority_subtree: { mode: "strict", quorum: 2 },
    });
    observed.push(
      (
        await fx.run([
          "policy",
          "update",
          "--scope",
          "project",
          "--replacement-file",
          replacementFile,
          "--idempotency-key",
          "public-policy-update",
        ])
      ).command,
    );
    const candidate = stageSecretCandidate(fx);
    observed.push(
      (
        await fx.run([
          "secret",
          "revoke",
          "--scope",
          "project",
          "--candidate-id",
          candidate.private_binding_id,
          "--candidate-digest",
          candidate.binding_digest,
          "--idempotency-key",
          "public-secret-revoke",
        ])
      ).command,
    );

    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const keyId = `sha256:${Bun.CryptoHasher.hash("sha256", spki, "hex")}`;
    const trustBase = {
      key_id: keyId,
      algorithm: "Ed25519",
      public_key_spki_base64: spki.toString("base64"),
      registry_origin: "https://registry.example",
      publisher_id: "acme",
      valid_from: "2029-01-01T00:00:00.000Z",
      valid_until: "2032-01-01T00:00:00.000Z",
      reason: null,
    };
    const trustTransitions = [
      ["add", CAPABILITY_TRUST_TRANSITION.ADDED, trustBase],
      [
        "rescope",
        CAPABILITY_TRUST_TRANSITION.RESCOPED,
        { ...trustBase, registry_origin: "https://packages.example" },
      ],
      [
        "deprecate",
        CAPABILITY_TRUST_TRANSITION.DEPRECATED,
        { ...trustBase, registry_origin: "https://packages.example" },
      ],
      [
        "revoke",
        CAPABILITY_TRUST_TRANSITION.REVOKED,
        { ...trustBase, registry_origin: "https://packages.example" },
      ],
    ] as const;
    for (const [subcommand, transition, base] of trustTransitions) {
      const trustFile = writeAuthorityTestJson(fx.root, `trust-${subcommand}.json`, {
        ...base,
        transition,
      });
      observed.push(
        (
          await fx.run([
            "trust",
            subcommand,
            "--scope",
            "project",
            "--trust-file",
            trustFile,
            "--idempotency-key",
            `public-trust-${subcommand}`,
          ])
        ).command,
      );
    }
    observed.push(
      (
        await fx.run([
          "grant",
          "revoke",
          "--scope",
          "project",
          "--grant-id",
          issued.grant_id,
          "--idempotency-key",
          "public-grant-revoke",
        ])
      ).command,
    );

    const advertised = CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS.filter(
      (command) => command !== CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
    );
    expect(new Set(observed)).toEqual(new Set(advertised));
    const committed = fx.runtime().ordinaryAuthority("project").domain.store.readCommitted();
    expect(committed.current.authority_epoch).toBe(advertised.length);
    expect(committed.events).toHaveLength(advertised.length);
    expect(committed.grants).toHaveLength(3);
    expect(committed.secrets).toHaveLength(1);
    expect(committed.trust).toHaveLength(4);
  });

  test("resumes a committing crash in a new runtime without minting another authority epoch", async () => {
    let activeFault: OrdinaryAuthorityMutationFaultPointV1 | null = "after-epoch-event";
    const fx = authorityDefaultPortFixture((_scope, point) => {
      if (point === activeFault) throw new Error(`fault:${point}`);
    });
    const grantFile = writeAuthorityTestJson(
      fx.root,
      "crash-grant.json",
      authorityTestGrant("project", "2031-01-01T00:00:00.000Z"),
    );
    const argv = [
      "grant",
      "create",
      "--grant-file",
      grantFile,
      "--idempotency-key",
      "public-crash-replay",
    ];
    await expect(fx.run(argv)).rejects.toThrow("fault:after-epoch-event");
    activeFault = null;
    fx.restart();
    const resumed = await fx.run(argv);
    const replayed = await fx.run(argv);
    expect(replayed).toEqual(resumed);
    const committed = fx.runtime().ordinaryAuthority("project").domain.store.readCommitted();
    expect(committed.current.authority_epoch).toBe(1);
    expect(committed.events).toHaveLength(1);
    expect(committed.grants).toHaveLength(1);
  });
});

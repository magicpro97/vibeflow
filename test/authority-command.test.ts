import { describe, expect, test } from "bun:test";
import { AssertionError } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairRuntimeV1,
  CapabilityCliMutationInputV1,
} from "../src/capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import type {
  CapabilityCliResultV1,
  FabricCliAuthorityMutationCommandV1,
} from "../src/capabilities/wire/cli.js";
import { authority } from "../src/commands/authority.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../src/core/capability-contract.js";
import { digestV1 } from "../src/durability/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "vf-authority-command-"));
}

function success(command: FabricCliAuthorityMutationCommandV1) {
  return {
    schema_version: "1.0" as const,
    kind: "mutation" as const,
    command,
    status: "succeeded" as const,
    changed: true as const,
    operation_id: "vf-op",
    proposal_id: "vf-proposal",
    plan_digest: `sha256:${"1".repeat(64)}`,
    generation_id: null,
    targets: [],
    recovery_actions: [],
    error: null,
  } satisfies CapabilityCliResultV1;
}

function grantPayload(scope: "project" | "user") {
  const permission = {
    schema_version: "1.0" as const,
    permission_id: "acme.token",
    kind: "secret" as const,
    scope: { input_ids: ["token"] },
    target_ids: [`vf-target-${"a".repeat(64)}`],
    enforcement: "brokered" as const,
  };
  return {
    scope,
    principal_id: "vf-principal-demo",
    action_types: ["capability.install"],
    permissions: [
      {
        ...permission,
        binding_digest: digestV1("VF-GRANTED-PERMISSION-BINDING\0v1\0", permission),
      },
    ],
    target_engines: ["codex"],
    expires_at: "2026-08-26T00:00:00.000Z",
  };
}

describe("authority CLI durable mutation contract", () => {
  test("authority repair forwards the authenticated local TTY interaction to the injected runtime", async () => {
    const calls: string[] = [];
    const interaction: AuthorityRepairCliInteractionV1 = {
      authenticated_local_tty: true,
      selectCandidate(input) {
        calls.push(`select:${input.scope}:${input.candidates.length}`);
        return input.candidates[0]?.candidate_id ?? null;
      },
      confirmCriticalReview(input) {
        calls.push(`critical:${input.candidate.candidate_id}:${input.plan_digest}`);
        return true;
      },
      confirmRecoveryReview(input) {
        calls.push(
          `recovery:${input.candidate.candidate_id}:${String(input.observed_authority_digest)}`,
        );
        return false;
      },
    };
    const runtime: CapabilityCliAuthorityRepairRuntimeV1 = {
      execute(input, interactive) {
        const candidate = {
          candidate_id: "candidate-1",
          action_domain: "conversation" as const,
          authority_scope: "conversation" as const,
          scope_id: "conv-1",
          control_state: "recovery-checkpoint-only" as const,
          strategy: "replace-json-head",
          created_at: "2026-08-27T00:00:00.000Z",
          expires_at: "2026-08-27T00:05:00.000Z",
        };
        expect(
          interactive.selectCandidate({
            scope: input.scope,
            conversation_id: input.conversation_id,
            candidates: [candidate],
          }),
        ).toBe("candidate-1");
        expect(
          interactive.confirmCriticalReview({
            scope: input.scope,
            conversation_id: input.conversation_id,
            candidate,
            plan_digest: `sha256:${"3".repeat(64)}`,
            repair_id: "vf-repair-1",
            bootstrap_required: true,
          }),
        ).toBe(true);
        expect(
          interactive.confirmRecoveryReview({
            scope: input.scope,
            conversation_id: input.conversation_id,
            candidate,
            operation_id: "vf-repair-op",
            observed_authority_digest: null,
          }),
        ).toBe(false);
        return success("authority.repair");
      },
    };
    const code = await authority(
      ["repair", "--scope", "user", "--conversation", "conv-1", "--json"],
      {
        stdinIsTTY: true,
        stdinHasData: false,
        authorityRepairInteraction: interaction,
        authorityRepairRuntime: runtime,
        runtimeFactory: () =>
          ({
            service() {
              throw new Error("unused");
            },
          }) as never,
        writer: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      "select:user:1",
      `critical:candidate-1:sha256:${"3".repeat(64)}`,
      "recovery:candidate-1:null",
    ]);
  });

  test("grant create forwards the exact request DTO to the mutation port", async () => {
    const root = tempDir();
    try {
      const grantFile = join(root, "grant.json");
      writeFileSync(grantFile, JSON.stringify(grantPayload("project")));
      const seen: CapabilityCliMutationInputV1[] = [];
      const code = await authority(
        [
          "grant",
          "create",
          "--grant-file",
          grantFile,
          "--idempotency-key",
          "grant-create-1",
          "--yes",
          "--json",
        ],
        {
          stdinIsTTY: true,
          stdinHasData: false,
          mutationPort: {
            execute(input) {
              seen.push(input);
              return success("authority.grant.create");
            },
          },
          writer: () => undefined,
        },
      );
      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      const input = seen[0];
      if (!input) throw new Error("expected captured input");
      expect(input.command).toBe("authority.grant.create");
      if (!("request" in input)) throw new Error("expected request execution");
      expect(input.request.idempotency_key).toBe("grant-create-1");
      expect(input.request.scope).toBe("project");
      expect(input.request.action.type).toBe("grant.create");
      if (input.request.action.type !== "grant.create") throw new Error("unreachable");
      expect(input.request.action.grant.scope).toBe("project");
      expect("request" in input).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("secret revoke preserves the unresolved candidate selector for runtime resolution", async () => {
    const seen: CapabilityCliMutationInputV1[] = [];
    const code = await authority(
      [
        "secret",
        "revoke",
        "--scope",
        "project",
        "--candidate-id",
        "vf-secret-revocation-binding-id",
        "--candidate-digest",
        `sha256:${"2".repeat(64)}`,
        "--idempotency-key",
        "secret-revoke-1",
        "--yes",
        "--json",
      ],
      {
        stdinIsTTY: true,
        stdinHasData: false,
        mutationPort: {
          execute(input) {
            seen.push(input);
            return success("authority.secret.revoke");
          },
        },
        writer: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    if (!input) throw new Error("expected captured input");
    expect(input.command).toBe("authority.secret.revoke");
    if ("request" in input || input.command !== "authority.secret.revoke")
      throw new Error("expected secret revoke execution");
    expect(input.idempotency_key).toBe("secret-revoke-1");
    expect(input.secret).toEqual({
      kind: "candidate",
      candidate_id: "vf-secret-revocation-binding-id",
      candidate_digest: `sha256:${"2".repeat(64)}`,
    });
    expect(input.context.actor.credential_class).toBe("interactive-tty");
  });

  test("authority repair uses recovery credentials and never accepts request-file automation", async () => {
    const seen: CapabilityCliMutationInputV1[] = [];
    const code = await authority(
      ["repair", "--scope", "user", "--conversation", "conv-1", "--json"],
      {
        stdinIsTTY: true,
        stdinHasData: false,
        mutationPort: {
          execute(input) {
            seen.push(input);
            return success("authority.repair");
          },
        },
        writer: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    if (!input) throw new Error("expected captured input");
    expect(input.command).toBe("authority.repair");
    if (input.command !== "authority.repair") throw new Error("unreachable");
    expect(input.scope).toBe("user");
    expect(input.conversation_id).toBe("conv-1");
    expect(input.context.actor.credential_class).toBe("recovery");
    expect(input.context.stdin_is_tty).toBe(true);
  });

  test("post-parse authority input failures emit one safe JSON document", async () => {
    const root = tempDir();
    try {
      const missing = join(root, "private-missing-authority.json");
      const notFile = join(root, "private-authority-directory");
      mkdirSync(notFile);
      const cases = [
        [
          "grant",
          "create",
          "--grant-file",
          missing,
          "--idempotency-key",
          "missing-grant",
          "--yes",
          "--json",
        ],
        [
          "trust",
          "add",
          "--scope",
          "project",
          "--trust-file",
          missing,
          "--idempotency-key",
          "missing-trust",
          "--yes",
          "--json",
        ],
        [
          "policy",
          "update",
          "--scope",
          "project",
          "--replacement-file",
          notFile,
          "--idempotency-key",
          "unreadable-policy",
          "--yes",
          "--json",
        ],
      ];
      for (const argv of cases) {
        const lines: Array<{ message: string; level: string | undefined }> = [];
        const code = await authority(argv, {
          stdinIsTTY: true,
          stdinHasData: false,
          mutationPort: {
            execute() {
              throw new TypeError("mutation port must not run after an input failure");
            },
          },
          writer: (message, level) => lines.push({ message, level }),
        });
        expect(code).toBe(2);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.level).toBeUndefined();
        const document = JSON.parse(lines[0]?.message ?? "") as {
          kind: string;
          error: { code: string; message: string };
        };
        expect(document.kind).toBe("usage-error");
        expect(document.error.code).toBe("invalid_request");
        expect(document.error.message).not.toContain(root);
        expect(document.error.message).not.toContain("ENOENT");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tagged mutation-port failures are safe in JSON and human modes", async () => {
    for (const json of [true, false]) {
      const lines: Array<{ message: string; level: string | undefined }> = [];
      const code = await authority(["repair", "--scope", "project", ...(json ? ["--json"] : [])], {
        stdinIsTTY: true,
        stdinHasData: false,
        mutationPort: {
          execute() {
            throw new CapabilityRuntimeError(
              "backend returned undefined at /private/authority/grants.json\n    at repair",
              CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
            );
          },
        },
        writer: (message, level) => lines.push({ message, level }),
      });
      expect(code).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toContain("Capability service is unavailable.");
      expect(lines[0]?.message).not.toContain("/private/authority");
      expect(lines[0]?.message).not.toContain("undefined");
      expect(lines[0]?.message).not.toContain("at repair");
      if (json) {
        expect(lines[0]?.level).toBeUndefined();
        expect(JSON.parse(lines[0]?.message ?? "")).toMatchObject({
          kind: "usage-error",
          command: "authority.repair",
          error: { code: "service_unavailable" },
        });
      } else {
        expect(lines[0]?.level).toBe("error");
        expect(lines[0]?.message).not.toContain("Error:");
      }
    }
  });

  test("all unclassified and programmer faults remain explicit rejections", async () => {
    class CustomInvariantError extends Error {}
    const faults: Error[] = [
      new AssertionError({ message: "assertion invariant fault" }),
      new TypeError("type invariant fault"),
      new Error("unclassified operational-looking fault"),
      new CustomInvariantError("custom invariant fault"),
      new CapabilityRuntimeError("unknown runtime code", "unclassified" as never),
    ];
    for (const fault of faults) {
      const lines: string[] = [];
      let observed: unknown;
      try {
        await authority(["repair", "--scope", "project", "--json"], {
          stdinIsTTY: true,
          stdinHasData: false,
          mutationPort: {
            execute() {
              throw fault;
            },
          },
          writer: (message) => lines.push(message),
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(fault);
      expect(lines).toEqual([]);
    }
  });

  test("non-Error throws are never classified as operational failures", async () => {
    const thrown = { invariant: "non-error" };
    let observed: unknown;
    try {
      await authority(["repair", "--scope", "project", "--json"], {
        stdinIsTTY: true,
        stdinHasData: false,
        mutationPort: {
          execute() {
            throw thrown;
          },
        },
        writer: () => undefined,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(thrown);
  });
});

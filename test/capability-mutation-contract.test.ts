import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityCliMutationInputV1 } from "../src/capabilities/cli/ports.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../src/capabilities/index.js";
import type {
  CapabilityCliResultV1,
  FabricCliCapabilityMutationCommandV1,
} from "../src/capabilities/wire/cli.js";
import { capability } from "../src/commands/capability.js";
import { commandAction } from "../src/commands/capability/mutation.js";
import { parseCapabilityCliArgv } from "../src/commands/capability/parser-capability.js";
import { VERSION } from "../src/core.js";
import { resolvedRolePackage, retainRuntimePackageCache } from "./capabilities/runtime-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-capability-contract-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  const userVibeflowRoot = join(homeRoot, ".vibeflow");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  const now = () => "2026-08-25T12:00:00.000Z";
  activateProjectCapabilityAuthorityForVfInit(projectRoot, { now });
  const runtime = productionCapabilityRuntimeV1({
    projectRoot,
    userHomeRoot: homeRoot,
    userVibeflowRoot,
    now,
    vfVersion: VERSION,
  });
  const service = runtime.service("project");
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(service.options.storage, pkg);
  return { projectRoot, homeRoot, userVibeflowRoot, runtime, pkg };
}

function mutationSuccess(command: FabricCliCapabilityMutationCommandV1) {
  return {
    schema_version: "1.0" as const,
    kind: "mutation" as const,
    command,
    status: "succeeded" as const,
    changed: true as const,
    operation_id: "vf-op",
    proposal_id: "vf-proposal",
    plan_digest: `sha256:${"3".repeat(64)}`,
    generation_id: "vf-generation",
    targets: [],
    recovery_actions: [],
    error: null,
  } satisfies CapabilityCliResultV1;
}

describe("capability CLI mutation contract", () => {
  test("non-interactive mutations without --yes stay zero-write and do not call the durable port", async () => {
    const fx = fixture();
    let calls = 0;
    const lines: string[] = [];
    const code = await capability(
      [
        "install",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--package-pin-digest",
        fx.pkg.pin.pin_digest,
        "--for",
        "codex",
        "--idempotency-key",
        "install-1",
        "--json",
      ],
      {
        base: fx.projectRoot,
        userHomeRoot: fx.homeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        runtimeFactory: () => fx.runtime,
        stdinIsTTY: false,
        stdinHasData: false,
        mutationPort: {
          execute() {
            calls += 1;
            return mutationSuccess("capability.install");
          },
        },
        writer: (line) => {
          if (line) lines.push(line);
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
    const result = JSON.parse(lines[0] as string);
    expect(result.kind).toBe("plan");
    expect(result.command).toBe("capability.install");
  });

  test("durable apply forwards an exact request envelope instead of synthetic authority placeholders", async () => {
    const fx = fixture();
    const seen: CapabilityCliMutationInputV1[] = [];
    const code = await capability(
      [
        "install",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--package-pin-digest",
        fx.pkg.pin.pin_digest,
        "--for",
        "codex",
        "--idempotency-key",
        "install-1",
        "--yes",
        "--json",
      ],
      {
        base: fx.projectRoot,
        userHomeRoot: fx.homeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        runtimeFactory: () => fx.runtime,
        stdinIsTTY: true,
        stdinHasData: false,
        mutationPort: {
          execute(input) {
            seen.push(input);
            return mutationSuccess("capability.install");
          },
        },
        writer: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    if (!input) throw new Error("expected captured input");
    expect(input.command).toBe("capability.install");
    if (!("request" in input)) throw new Error("expected durable request envelope");
    expect(input.request.idempotency_key).toBe("install-1");
    expect(input.request.scope).toBe("project");
    expect(input.request.action.type).toBe("capability.install");
    expect(input.context.actor.credential_class).toBe("interactive-tty");
    expect("request" in input).toBe(true);
  });

  test("request-file from stdin is consumed exactly once and applied durably", async () => {
    const fx = fixture();
    const seen: CapabilityCliMutationInputV1[] = [];
    const envelope = JSON.stringify({
      schema_version: "1.0",
      idempotency_key: "stdin-1",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: {
        type: "capability.install",
        package: { id: fx.pkg.pin.id },
        scope: "project",
        requested_targets: [{ engine: "codex", participant_id: null }],
        inputs: [],
      },
    });
    // Simulate a consuming pipe: bytes are available on the first read only.
    let reads = 0;
    const stdin = () => {
      reads += 1;
      return reads === 1 ? envelope : "";
    };
    const code = await capability(["install", "--request-file", "-", "--yes", "--json"], {
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      runtimeFactory: () => fx.runtime,
      stdinIsTTY: false,
      stdinHasData: true,
      stdin,
      mutationPort: {
        execute(input) {
          seen.push(input);
          return mutationSuccess("capability.install");
        },
      },
      writer: () => undefined,
    });
    expect(code).toBe(0);
    expect(reads).toBe(1);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    if (!input) throw new Error("expected captured input");
    if (!("request" in input)) throw new Error("expected durable request envelope");
    expect(input.request.idempotency_key).toBe("stdin-1");
    expect(input.request.action.type).toBe("capability.install");
  });

  test("update --from-generation-id maps only to capability.restore_package", () => {
    const parsed = parseCapabilityCliArgv(
      ["update", "acme.demo", "--scope", "project", "--from-generation-id", "vf-generation-1"],
      { stdinIsTTY: true, stdinHasData: false },
    );
    const action = commandAction(parsed);
    expect("action" in action).toBe(false);
    if ("action" in action || action.type !== "capability.restore_package")
      throw new Error("expected restore_package");
    expect(action.package_id).toBe("acme.demo");
    expect(action.generation_id).toBe("vf-generation-1");
  });
});

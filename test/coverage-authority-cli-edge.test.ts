import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CAPABILITY_CLI_COMMAND } from "../src/actions/capability-cli-contract.js";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import { ACTION_OPERATION_STATE } from "../src/actions/index.js";
import {
  ACTION_CONFIG_DIFF_MODE,
  ACTION_PERMISSION_CHANGE,
  ACTION_REVERSIBILITY_VALUE,
} from "../src/actions/public-action-contract.js";
import type { HostRenderedPreviewV1 } from "../src/actions/types.js";
import { capabilityPreviewRisk } from "../src/capabilities/action-domain/preview.js";
import {
  canonicalFutureRuntimeDirectory,
  canonicalRuntimeDirectory,
} from "../src/capabilities/runtime-factory-paths.js";
import { readCapabilityOperationHeader } from "../src/capabilities/storage/operation-store.js";
import {
  capabilityOperationPaths,
  projectCapabilityPaths,
} from "../src/capabilities/storage/paths.js";
import * as commandShared from "../src/commands/_shared.js";
import { createLocalAuthorityApprovalInteractionV1 } from "../src/commands/capability/authority-approval-interaction.js";
import {
  DEFAULT_AUTHORITY_PROMPT_IO,
  exactAuthorityConfirmation,
} from "../src/commands/capability/authority-prompt-io.js";
import { ordinaryAuthorityMutationResult } from "../src/commands/capability/ordinary-authority-mutation-results.js";
import { parseAuthorityCliArgv } from "../src/commands/capability/parser-authority.js";
import { conversationBootstrap } from "../src/commands/conversation-args.js";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import { extractEngineResponseText } from "../src/dispatch/prompt.js";
import { ensurePrivateDirectory } from "../src/durability/index.js";
import * as workspaceVerification from "../src/orchestrator/conversation/conversation-delegation-workspace-verification.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function root(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `vf-${label}-`));
  roots.push(value);
  return value;
}

function preview(overrides: Partial<HostRenderedPreviewV1>): HostRenderedPreviewV1 {
  return {
    schema_version: "1.0",
    effect_classes: [],
    risk: "medium",
    reversibility: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
    package_pins: [],
    dependency_delta: [],
    permission_delta: [],
    enforcement: [],
    config_diffs: [],
    health_plan: [],
    recovery_actions: [],
    targets: [],
    ...overrides,
  } as HostRenderedPreviewV1;
}

describe("authority CLI final coverage edges", () => {
  test("classifies permission expansion and full-file/manual diffs as high risk", () => {
    const permissionRisk = capabilityPreviewRisk(
      preview({ permission_delta: [{ change: ACTION_PERMISSION_CHANGE.ADD }] as never }),
      "project",
      HOST_ACTION_KIND.CAPABILITY_UPDATE,
    );
    expect(permissionRisk).toBe("high");

    for (const mode of [ACTION_CONFIG_DIFF_MODE.FULL_FILE, ACTION_CONFIG_DIFF_MODE.MANUAL]) {
      expect(
        capabilityPreviewRisk(
          preview({ config_diffs: [{ mode }] as never }),
          "project",
          HOST_ACTION_KIND.CAPABILITY_UPDATE,
        ),
      ).toBe("high");
    }
  });

  test("reports unavailable current and future runtime directories", () => {
    const base = root("runtime-paths");
    const missingParent = join(base, "absent", "future");
    expect(() => canonicalRuntimeDirectory(missingParent, "runtime root")).toThrow(
      /runtime root is unavailable/,
    );
    expect(() => canonicalFutureRuntimeDirectory(missingParent, "future root")).toThrow(
      /future root parent is unavailable/,
    );
  });

  test("rejects corrupt and non-canonical capability operation headers", () => {
    const base = root("operation-header");
    const paths = projectCapabilityPaths(base);
    const operationId = `vf-operation-${"a".repeat(64)}`;
    const header = capabilityOperationPaths(paths, operationId).header;
    mkdirSync(base, { recursive: true, mode: 0o700 });
    ensurePrivateDirectory(dirname(header));
    writeFileSync(header, "{not-json", { mode: 0o600 });
    expect(() => readCapabilityOperationHeader(paths, operationId)).toThrow(/header is corrupt/);
    writeFileSync(header, ' {"schema_version":"1.0"}', { mode: 0o600 });
    expect(() => readCapabilityOperationHeader(paths, operationId)).toThrow(
      /header is not canonical/,
    );
  });

  test("renders approval prompts and requires an exact response", () => {
    const writes: string[] = [];
    const answers = ["approve-exact", "wrong"];
    const io = {
      write: (message: string) => writes.push(message),
      readLine: () => answers.shift() ?? null,
    };
    const interaction = createLocalAuthorityApprovalInteractionV1(io);
    expect(
      interaction.respondToChallenge({
        command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
        scope: "project",
        proposal_id: "proposal-edge",
        proposal_digest: `sha256:${"1".repeat(64)}`,
        challenge_id: "challenge-edge",
        challenge_class: "public-literal",
        display_phrase: "approve-exact",
        expires_at: "2030-01-01T00:05:00.000Z",
      }),
    ).toBe("approve-exact");
    expect(exactAuthorityConfirmation(io, "Confirm mutation", "approve-exact")).toBeFalse();
    expect(writes.join("\n")).toContain("Authority approval challenge");

    const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      DEFAULT_AUTHORITY_PROMPT_IO.write("authority prompt edge");
      expect(stderr).toHaveBeenCalledWith("authority prompt edge");
    } finally {
      stderr.mockRestore();
    }
  });

  test("reads LF/CRLF/EOF terminal lines through the default prompt IO", () => {
    const chunks = [Buffer.from("first\r\n"), Buffer.from("tail")];
    let chunk = chunks.shift() as Buffer;
    let index = 0;
    const read = spyOn(nodeFs, "readSync").mockImplementation(((
      _fd,
      buffer,
      offset,
      length,
      _position,
    ) => {
      if (index >= chunk.length) {
        chunk = chunks.shift() ?? Buffer.alloc(0);
        index = 0;
        if (chunk.length === 0) return 0;
      }
      const target = buffer as Buffer;
      target[offset] = chunk[index] as number;
      index += Math.min(length, 1);
      return 1;
    }) as typeof nodeFs.readSync);
    try {
      expect(DEFAULT_AUTHORITY_PROMPT_IO.readLine()).toBe("first");
      expect(DEFAULT_AUTHORITY_PROMPT_IO.readLine()).toBe("tail");
      expect(DEFAULT_AUTHORITY_PROMPT_IO.readLine()).toBeNull();
    } finally {
      read.mockRestore();
    }
  });

  test("rejects automation-grant files on an interactive authority command", () => {
    expect(() =>
      parseAuthorityCliArgv(
        [
          "grant",
          "revoke",
          "--scope",
          "project",
          "--grant-id",
          "grant-edge",
          "--automation-grant-file",
          "grant.json",
        ],
        { stdinIsTTY: true, stdinHasData: false },
      ),
    ).toThrow(/only accepted for non-interactive/);
  });

  test("maps ordinary authority failed and recovery terminals", () => {
    const proposal = {
      proposal_id: "proposal-edge",
      plan_digest: `sha256:${"2".repeat(64)}`,
      preview: { recovery_actions: ["inspect-authority-state"] },
    } as never;
    const failed = ordinaryAuthorityMutationResult(
      CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
      proposal,
      { outcome: ACTION_OPERATION_STATE.FAILED, operation_id: "operation-failed" } as never,
    );
    const recovery = ordinaryAuthorityMutationResult(
      CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
      proposal,
      {
        outcome: ACTION_OPERATION_STATE.NEEDS_RECOVERY,
        operation_id: "operation-recovery",
      } as never,
    );
    expect(failed).toMatchObject({ status: "failed", changed: false });
    expect(recovery).toMatchObject({ status: "needs-recovery", changed: true });
  });

  test("extracts Claude structured/object results and OpenCode text events", () => {
    expect(
      extractEngineResponseText(
        '{"type":"result","structured_output":{"status":"ok"}}',
        AGENT_ENGINE.CLAUDE,
      ),
    ).toBe('{"status":"ok"}');
    expect(
      extractEngineResponseText(
        '{"type":"result","result":{"status":"object"}}',
        AGENT_ENGINE.CLAUDE,
      ),
    ).toBe('{"status":"object"}');
    expect(
      extractEngineResponseText(
        'noise {bad} {"type":"text","part":{"text":"one"}} {"type":"text","part":{"text":"two"}}',
        AGENT_ENGINE.OPENCODE,
      ),
    ).toBe("one\ntwo");
    expect(extractEngineResponseText("{bad}", AGENT_ENGINE.OPENCODE)).toBe("{bad}");
    expect(extractEngineResponseText("{bad}", AGENT_ENGINE.CLAUDE)).toBe("{bad}");
    expect(extractEngineResponseText("copilot text", AGENT_ENGINE.COPILOT)).toBe("copilot text");
  });

  test("composes coordination verification from oracle and gate evidence", async () => {
    const base = root("conversation-coordination-verifier");
    const oracleResults = [{ oracle: "bun test scoped", passed: true }] as never;
    const report = { ok: true, confidence: 1 } as never;
    const oracles = spyOn(
      workspaceVerification,
      "runConversationDelegationVerificationOracles",
    ).mockResolvedValue(oracleResults);
    const collect = spyOn(commandShared, "collectVerifyReportAsync").mockResolvedValue({
      gates: report,
    } as never);
    try {
      const bootstrap = conversationBootstrap({ bootstrap: { libraries: {} as never } }, base);
      type CoordinationVerifier = (input: {
        cwd: string;
        expected_oracles: readonly string[];
      }) => Promise<{ oracle_results: unknown; report: unknown }>;
      const authority = bootstrap.authorities.coordinationWorkspaces as unknown as {
        verifier: { verifier?: CoordinationVerifier };
      };
      const verifier = authority.verifier.verifier;
      if (!verifier) throw new Error("coordination verifier was not composed");
      await expect(verifier({ cwd: base, expected_oracles: ["bun test scoped"] })).resolves.toEqual(
        { oracle_results: oracleResults, report },
      );
      expect(oracles).toHaveBeenCalledWith(base, ["bun test scoped"]);
      expect(collect).toHaveBeenCalledWith(base, { requireReviewEvidence: false });
    } finally {
      collect.mockRestore();
      oracles.mockRestore();
    }
  });
});

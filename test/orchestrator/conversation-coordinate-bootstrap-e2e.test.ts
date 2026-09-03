import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import { AGENT_ENGINE, AGENT_ROLE_SOURCE } from "../../src/core/agent-contract.js";
import {
  ROLE_MODEL,
  ROLE_READ_ONLY_TOOL_INTENTS,
  ROLE_SANDBOX,
  ROLE_WORKFLOW_TOOL_INTENTS,
} from "../../src/core/role-contract.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import type { EngineProcess, EngineProcessSpawnOptions } from "../../src/dispatch/session-types.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { sanitizedGitEnvironment } from "../../src/git-environment.js";
import {
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../../src/orchestrator/conversation/bootstrap.js";
import { CONVERSATION_COORDINATION_DIRECTIVE_KIND } from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import type { CoordinationTaskContractV1 } from "../../src/orchestrator/conversation/conversation-coordination-records.js";
import { runConversationDelegationVerificationOracles } from "../../src/orchestrator/conversation/conversation-delegation-workspace-verification.js";
import {
  CONVERSATION_TURN_DELIVERY_MODE,
  CONVERSATION_TURN_NATIVE_SESSION_USE,
  CONVERSATION_TURN_PROMPT_PREFIX,
  CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE,
} from "../../src/orchestrator/conversation/turn-delivery-contract.js";
import type { ConversationTurnEnvelopeV1 } from "../../src/orchestrator/conversation/turn-delivery-types.js";
import { type PolicyVerifyReport, VERIFY_GATE_ORDER } from "../../src/verify/core.js";

const CLAUDE_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d19";
const CODEX_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d20";
const TASK_ID = "autopilot-task-1";
const CHANGED_PATH = "src/autopilot.ts";
const CHANGED_CONTENT = "export const autopilot = true;\n";
const VERIFY_COMMAND = "git diff --check HEAD^ HEAD";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function passingVerifyReport(head: string): PolicyVerifyReport {
  return Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed at ${head}`, evidence_refs: [`e2e:${name}`] },
    ]),
  ) as PolicyVerifyReport;
}

function completedProcess(stdout: string): EngineProcess {
  const bytes = new TextEncoder().encode(`${stdout}\n`);
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function materialized(input: AgentBinding): MaterializedAgentBinding {
  const roleHash = digestHex(digestV1("VF-COORDINATION-E2E-ROLE\0v1\0", input.roleRef));
  const provenance = {
    roleSource: AGENT_ROLE_SOURCE.BUILTIN,
    roleHash,
    skillHashes: [] as string[],
  };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] as string[] };
  const envPolicy = conversationEnvPolicy(input.engine);
  const coordinator = input.engine === AGENT_ENGINE.CLAUDE;
  const model = coordinator ? ROLE_MODEL.SONNET : ROLE_MODEL.GPT_5_4;
  const sandbox = coordinator ? ROLE_SANDBOX.READ_ONLY : ROLE_SANDBOX.WORKSPACE_WRITE;
  const toolIntents = coordinator
    ? [...ROLE_READ_ONLY_TOOL_INTENTS]
    : [...ROLE_WORKFLOW_TOOL_INTENTS];
  const renderedTools = coordinator ? ["Read"] : [];
  const resolved = {
    role: {
      spec: {
        name: input.roleRef,
        description: `coordination e2e ${input.roleRef}`,
        body: `coordination e2e ${input.roleRef}`,
        tools: toolIntents,
        model: ROLE_MODEL.SONNET,
        sandbox,
      },
      source: AGENT_ROLE_SOURCE.BUILTIN,
      resolved_hash: roleHash,
      metadata: {},
    },
    skills: [],
    engine: input.engine,
    model,
    sessionMode: input.sessionMode,
    tool_intents: toolIntents,
    sandbox,
    env_policy: envPolicy,
    isolation: null,
    provenance,
    trace_metadata: traceMetadata,
  };
  return {
    resolved,
    spawn: createSpawnOptionsProjection({
      engine: input.engine,
      model,
      sessionMode: input.sessionMode,
      rendered_prompt: `coordination e2e ${input.roleRef}`,
      rendered_tools: renderedTools,
      sandbox,
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  } as MaterializedAgentBinding;
}

function turnEnvelope(argv: readonly string[], options: EngineProcessSpawnOptions) {
  const source = [options.stdinText, ...argv].find((value) =>
    value.includes(CONVERSATION_TURN_PROMPT_PREFIX),
  );
  if (!source) throw new Error("coordination attempt lacked a turn envelope");
  const start = source.lastIndexOf(CONVERSATION_TURN_PROMPT_PREFIX);
  const payload = source.slice(start + CONVERSATION_TURN_PROMPT_PREFIX.length);
  const contract = payload.indexOf("\n\n## Coordination Control Contract");
  return JSON.parse(
    payload.slice(0, contract < 0 ? undefined : contract).trim(),
  ) as ConversationTurnEnvelopeV1;
}

const claudeOutput = (directive: unknown): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: CLAUDE_SESSION_ID,
    result: JSON.stringify(directive),
  });

const codexOutput = (directive: unknown): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: CODEX_SESSION_ID }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "message", type: "agent_message", text: JSON.stringify(directive) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

const libraries: ConversationBootstrapOptions["libraries"] = {
  plan: { create: async () => ({ content: "unused" }) },
  review: {
    review: async ({ head_sha }) => ({
      reviewed_head: head_sha,
      reviewer: "human:e2e",
      outcome: "approved",
      evidence_refs: ["e2e:review"],
    }),
  },
  verify: { run: async () => passingVerifyReport("library") },
  orchestrate: {
    dryRun: async () => ({
      participants: [],
      evaluator_auto_added: false,
      engines_available: ["claude", "codex"],
      models_valid: true,
    }),
    execute: async () => ({ units: [], reviews: [] }),
  },
};

test("bootstrap coordinates exact-session clarification, verified execution, detached review, and promotion", async () => {
  const root = mkdtempSync(join(tmpdir(), "vf-coordinate-bootstrap-e2e-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# coordination fixture\n");
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeFlow Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "test: initialize coordination fixture"]);
  const baseHead = git(repo, ["rev-parse", "HEAD"]);

  const launches: Array<{
    argv: string[];
    cwd: string | undefined;
    envelope: ConversationTurnEnvelopeV1;
  }> = [];
  let task: CoordinationTaskContractV1 | null = null;
  let executorHead: string | null = null;
  let reviewHead: string | null = null;
  let verifyCalls = 0;
  let idSequence = 0;

  try {
    const bootstrap = createConversationBootstrap({
      repoRoot: repo,
      stateDir: join(root, "state"),
      readiness: () => [
        { engine: "claude", ready: true, admitted: true },
        { engine: "codex", ready: true, admitted: true },
      ],
      registeredRoles: ["coordination-coordinator", "coordination-executor"],
      bindingFactory: {
        materialize: (input) => materialized(input),
        preview: () => {
          throw new Error("coordinate e2e must not preview bindings");
        },
      } as ConversationBootstrapOptions["bindingFactory"],
      session: {
        sourceEnv: {},
        spawn: (argv, options) => {
          const envelope = turnEnvelope(argv, options);
          launches.push({ argv: [...argv], cwd: options.cwd, envelope });
          const ordinal = launches.length;
          if (ordinal === 1) {
            const executorId =
              envelope.instruction.kind === "coordinator-plan"
                ? envelope.instruction.executor_participant_ids[0]
                : undefined;
            const sourceRef =
              envelope.instruction.kind === "coordinator-plan"
                ? envelope.instruction.topic_message_ref
                : undefined;
            if (!executorId || !sourceRef) throw new Error("coordinator plan lacks authority");
            task = {
              task_id: TASK_ID,
              executor_participant_id: executorId,
              goal: "Implement the autopilot fixture",
              scope: ["src/"],
              forbidden: ["src/security/"],
              must_haves: ["export the autopilot marker"],
              verify_oracles: [VERIFY_COMMAND],
              source_message_refs: [sourceRef],
            };
            return completedProcess(
              claudeOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
                task,
              }),
            );
          }
          if (!task) throw new Error("executor ran before a task was delegated");
          if (ordinal === 2)
            return completedProcess(
              codexOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
                clarification: {
                  task_id: TASK_ID,
                  question_id: "question-1",
                  question: "Should the fixture export a boolean marker?",
                  blocking_reason: "The requested value was not explicit.",
                  attempted_interpretations: ["Export a boolean marker"],
                  required_decision: "Confirm the marker representation.",
                },
              }),
            );
          if (ordinal === 3)
            return completedProcess(
              claudeOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
                resolution: {
                  task_id: TASK_ID,
                  question_id: "question-1",
                  answer: "Use a boolean marker because it is the narrowest reversible default.",
                  source: "safe-default",
                  source_refs: [],
                  assumptions: ["A boolean marker preserves the fixture's narrow scope."],
                },
              }),
            );
          if (ordinal === 4) {
            const cwd =
              options.cwd ??
              (() => {
                throw new Error("executor lacks a worktree");
              })();
            expect(git(cwd, ["symbolic-ref", "HEAD"])).toStartWith("refs/heads/vf/coordinate/");
            mkdirSync(join(cwd, "src"), { recursive: true });
            writeFileSync(join(cwd, CHANGED_PATH), CHANGED_CONTENT);
            git(cwd, ["add", CHANGED_PATH]);
            git(cwd, ["commit", "--quiet", "-m", "feat: add autopilot fixture"]);
            git(cwd, ["diff", "--check", "HEAD^", "HEAD"]);
            executorHead = git(cwd, ["rev-parse", "HEAD"]);
            return completedProcess(
              codexOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
                completion: {
                  task_id: TASK_ID,
                  summary: "Implemented and committed the autopilot fixture.",
                  changed_paths: [CHANGED_PATH],
                  evidence_refs: ["e2e:executor-commit"],
                  verification: { commands: [VERIFY_COMMAND], passed: true },
                },
              }),
            );
          }
          if (ordinal === 5 && envelope.instruction.kind === "coordinator-review") {
            const cwd =
              options.cwd ??
              (() => {
                throw new Error("review lacks a worktree");
              })();
            expect(() => git(cwd, ["symbolic-ref", "HEAD"])).toThrow();
            expect(readFileSync(join(cwd, CHANGED_PATH), "utf8")).toBe(CHANGED_CONTENT);
            reviewHead = git(cwd, ["rev-parse", "HEAD"]);
            const workspace = envelope.instruction.workspace;
            if (!workspace?.verified_head)
              throw new Error("review lacks verified workspace evidence");
            return completedProcess(
              claudeOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
                finalization: {
                  completed_task_ids: [TASK_ID],
                  reviewed_head: workspace.verified_head,
                  summary: "Reviewed the exact verified executor commit.",
                  evidence_refs: [...workspace.evidence_refs, "e2e:detached-review"],
                },
              }),
            );
          }
          throw new Error(`unexpected coordination attempt ${ordinal}`);
        },
      },
      coordinationVerifier: async ({ cwd, expected_oracles: expectedOracles }) => {
        verifyCalls += 1;
        expect(readFileSync(join(cwd, CHANGED_PATH), "utf8")).toBe(CHANGED_CONTENT);
        git(cwd, ["diff", "--check", "HEAD^", "HEAD"]);
        expect(git(cwd, ["status", "--porcelain=v1"])).toBe("");
        return {
          report: passingVerifyReport(git(cwd, ["rev-parse", "HEAD"])),
          oracle_results: await runConversationDelegationVerificationOracles(cwd, expectedOracles),
        };
      },
      id: (kind) => `${kind}-coordinate-e2e-${++idSequence}`,
      schedule: (run) => run(),
      libraries,
    });
    const created = await bootstrap.service.create({
      topic: "Implement an autopilot fixture through direct CLI delegation",
      policy: "coordinate",
    });

    if (created.result.status !== "completed") {
      const events = await bootstrap.service.events(created.conversation_id, 0);
      const diagnostics = events
        ?.filter(({ event }) => event.type === "error")
        .map(({ event }) => (event.type === "error" ? event.payload : null));
      throw new Error(
        `coordination failed in ${root} after ${launches.length} launches: ${JSON.stringify({
          result: created.result,
          diagnostics,
          events: events?.map(({ event }) => event),
        })}`,
      );
    }
    expect(created.result.status).toBe("completed");
    expect(created.result.artifact_refs).toHaveLength(5);
    expect(launches).toHaveLength(5);
    expect(verifyCalls).toBe(1);
    if (!executorHead || !reviewHead) throw new Error("coordination heads were not observed");
    expect(executorHead).not.toBe(baseHead);
    expect(reviewHead).toBe(executorHead);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(executorHead);
    expect(readFileSync(join(repo, CHANGED_PATH), "utf8")).toBe(CHANGED_CONTENT);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("");

    for (const index of [2, 3, 4]) {
      expect(launches[index]?.envelope.delivery_mode).toBe(
        CONVERSATION_TURN_DELIVERY_MODE.EXACT_DELTA,
      );
      expect(launches[index]?.envelope.native_session_use).toBe(
        CONVERSATION_TURN_NATIVE_SESSION_USE.REQUIRED_EXACT,
      );
      expect(launches[index]?.envelope.recipient_history).toMatchObject({
        source: CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE.NATIVE_SESSION,
        replayed_response_count: 0,
        entries: [],
      });
    }
    expect(launches[2]?.argv).toContain(CLAUDE_SESSION_ID);
    expect(launches[3]?.argv).toContain(CODEX_SESSION_ID);
    expect(launches[4]?.argv).toContain(CLAUDE_SESSION_ID);
    expect(launches[2]?.envelope.public_responses).toHaveLength(1);
    expect(launches[3]?.envelope.public_responses).toHaveLength(1);
    expect(launches[4]?.envelope.public_responses).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

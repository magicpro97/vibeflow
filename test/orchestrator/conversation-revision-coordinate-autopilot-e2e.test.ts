import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { actionIdempotencyScopeDigest } from "../../src/actions/index.js";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import {
  ROLE_READ_ONLY_TOOL_INTENTS,
  ROLE_WORKFLOW_TOOL_INTENTS,
} from "../../src/core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import type { EngineProcess, EngineProcessSpawnOptions } from "../../src/dispatch/session-types.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { sanitizedGitEnvironment } from "../../src/git-environment.js";
import {
  type ConversationBootstrap,
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../../src/orchestrator/conversation/bootstrap.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
  CONVERSATION_COORDINATION_TOOL,
} from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import type { CoordinationTaskContractV1 } from "../../src/orchestrator/conversation/conversation-coordination-records.js";
import { runConversationDelegationVerificationOracles } from "../../src/orchestrator/conversation/conversation-delegation-workspace-verification.js";
import { CONVERSATION_LIFECYCLE } from "../../src/orchestrator/conversation/conversation-lifecycle-contract.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { resolveRevisionBase } from "../../src/orchestrator/conversation/revision-source.js";
import { readRuntimeConversationCoordinationState } from "../../src/orchestrator/conversation/runtime-coordination-state.js";
import {
  CONVERSATION_TURN_INSTRUCTION_KIND,
  CONVERSATION_TURN_PROMPT_PREFIX,
} from "../../src/orchestrator/conversation/turn-delivery-contract.js";
import type { ConversationTurnEnvelopeV1 } from "../../src/orchestrator/conversation/turn-delivery-types.js";
import { type PolicyVerifyReport, VERIFY_GATE_ORDER } from "../../src/verify/core.js";

const PARENT_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d11";
const COORDINATOR_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d12";
const EXECUTOR_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d13";
const DIRECT_CHILD_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d14";
const TASK_ID = "revision-autopilot-task";
const CHANGED_PATH = "src/revision-autopilot.ts";
const CHANGED_CONTENT = "export const revisionAutopilot = true;\n";
const VERIFY_COMMAND = "git diff --check HEAD^ HEAD";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

function claudeOutput(sessionId: string, value: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: JSON.stringify(value),
  });
}

function codexOutput(value: unknown): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: EXECUTOR_SESSION_ID }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "message", type: "agent_message", text: JSON.stringify(value) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
}

function envelope(argv: readonly string[], options: EngineProcessSpawnOptions) {
  const source = [options.stdinText, ...argv].find((value) =>
    value.includes(CONVERSATION_TURN_PROMPT_PREFIX),
  );
  if (!source) throw new Error("attempt lacked a turn envelope");
  const payload = source.slice(
    source.lastIndexOf(CONVERSATION_TURN_PROMPT_PREFIX) + CONVERSATION_TURN_PROMPT_PREFIX.length,
  );
  const contract = payload.indexOf("\n\n## Coordination Control Contract");
  return JSON.parse(
    payload.slice(0, contract < 0 ? undefined : contract).trim(),
  ) as ConversationTurnEnvelopeV1;
}

function materialized(input: AgentBinding): MaterializedAgentBinding {
  const roleHash = digestHex(digestV1("VF-REVISION-COORDINATION-E2E-ROLE\0v1\0", input.roleRef));
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] as string[] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] as string[] };
  const executor = input.roleRef === CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR;
  const sandbox = executor ? ("workspace-write" as const) : ("read-only" as const);
  const tools = executor ? [...ROLE_WORKFLOW_TOOL_INTENTS] : [...ROLE_READ_ONLY_TOOL_INTENTS];
  const envPolicy = conversationEnvPolicy(input.engine);
  const model = input.engine === "claude" ? "sonnet" : "gpt-5.4";
  const resolved = {
    role: {
      spec: {
        name: input.roleRef,
        description: `revision coordination e2e ${input.roleRef}`,
        body: `revision coordination e2e ${input.roleRef}`,
        tools,
        model: "sonnet" as const,
        sandbox,
      },
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
    },
    skills: [],
    engine: input.engine,
    model,
    sessionMode: input.sessionMode,
    tool_intents: tools,
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
      rendered_prompt: `revision coordination e2e ${input.roleRef}`,
      rendered_tools: executor ? [] : ["Read"],
      sandbox,
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  } as MaterializedAgentBinding;
}

function passingVerifyReport(head: string): PolicyVerifyReport {
  return Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed at ${head}`, evidence_refs: [`e2e:${name}`] },
    ]),
  ) as PolicyVerifyReport;
}

async function waitForCompleted(bootstrap: ConversationBootstrap, conversationId: string) {
  const deadline = Date.now() + 8_000;
  let snapshot = await bootstrap.service.snapshot(conversationId);
  while (snapshot?.lifecycle !== CONVERSATION_LIFECYCLE.COMPLETED && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await bootstrap.service.snapshot(conversationId);
  }
  if (snapshot?.lifecycle !== CONVERSATION_LIFECYCLE.COMPLETED) {
    const events = await bootstrap.service.events(conversationId, 0);
    throw new Error(
      `conversation ${conversationId} remained ${snapshot?.lifecycle ?? "absent"}: ${JSON.stringify(
        events?.slice(-12).map(({ event }) => event),
      )}`,
    );
  }
  return snapshot;
}

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

function browserAuthority(rootSessionId: string, label: string) {
  const controlSessionDigest = digestV1("VF-REVISION-COORDINATION-BROWSER\0v1\0", label);
  const principalDigest = digestV1("VF-BROWSER-ACTION-PRINCIPAL\0v1\0", {
    schema_version: "1.0",
    control_session_digest: controlSessionDigest,
  });
  return {
    schema_version: "1.0" as const,
    principal_digest: principalDigest,
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation" as const,
      root_session_id: rootSessionId,
    }),
    control_session_digest: controlSessionDigest,
    csrf_epoch_digest: digestV1("VF-REVISION-COORDINATION-CSRF\0v1\0", label),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: `browser-${digestHex(principalDigest)}`,
      credential_class: "loopback-session" as const,
    },
  };
}

test("approved direct revisions enter coordinator autopilot and return to one direct lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "vf-revision-coordinate-e2e-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# revision coordination fixture\n");
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "VibeFlow Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "test: initialize revision fixture"]);
  const baseHead = git(repo, ["rev-parse", "HEAD"]);
  const launches: Array<{ argv: string[]; turn: ConversationTurnEnvelopeV1 }> = [];
  const barrierLaunches: string[][] = [];
  let task: CoordinationTaskContractV1 | null = null;
  let verifiedHead: string | null = null;
  let verifyCalls = 0;
  let ids = 0;
  let claudeBarrierCount = 0;

  try {
    const bootstrap = createConversationBootstrap({
      repoRoot: repo,
      stateDir,
      readiness: () => [
        { engine: "claude", ready: true, admitted: true },
        { engine: "codex", ready: true, admitted: true },
      ],
      registeredRoles: Object.values(CONVERSATION_ROLE_NAME),
      bindingFactory: {
        materialize: (input) => materialized(input),
        preview: () => {
          throw new Error("revision coordination e2e must not preview bindings");
        },
      } as ConversationBootstrapOptions["bindingFactory"],
      session: {
        sourceEnv: {},
        spawn: (argv, options) => {
          if (
            ![options.stdinText, ...argv].some((value) =>
              value.includes(CONVERSATION_TURN_PROMPT_PREFIX),
            )
          ) {
            barrierLaunches.push([...argv]);
            if (argv[0] === "codex")
              return completedProcess(codexOutput({ answer: "Executor start admitted." }));
            if (argv[0] !== "claude") throw new Error("unexpected revision barrier engine");
            claudeBarrierCount += 1;
            return completedProcess(
              claudeOutput(
                claudeBarrierCount === 1 ? COORDINATOR_SESSION_ID : DIRECT_CHILD_SESSION_ID,
                { answer: "Claude start admitted." },
              ),
            );
          }
          const turn = envelope(argv, options);
          launches.push({ argv: [...argv], turn });
          const ordinal = launches.length;
          if (ordinal === 1)
            return completedProcess(
              claudeOutput(PARENT_SESSION_ID, { answer: "Ready to delegate implementation." }),
            );
          if (ordinal === 2) {
            if (turn.instruction.kind !== CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_PLAN)
              throw new Error("approved child did not start with the coordinator");
            const executorId = turn.instruction.executor_participant_ids[0];
            if (!executorId) throw new Error("coordinator lacks an executor");
            task = {
              task_id: TASK_ID,
              executor_participant_id: executorId,
              goal: "Implement the revision autopilot fixture",
              scope: ["src/"],
              forbidden: ["src/security/"],
              must_haves: ["export the revision autopilot marker"],
              verify_oracles: [VERIFY_COMMAND],
              source_message_refs: [turn.instruction.topic_message_ref],
            };
            return completedProcess(
              claudeOutput(COORDINATOR_SESSION_ID, {
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
                task,
              }),
            );
          }
          if (!task) throw new Error("executor started without a task");
          if (ordinal === 3)
            return completedProcess(
              codexOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
                clarification: {
                  task_id: TASK_ID,
                  question_id: "revision-question",
                  question: "Should the marker be a boolean?",
                  blocking_reason: "The representation is not explicit.",
                  attempted_interpretations: ["Export a boolean marker"],
                  required_decision: "Confirm the marker representation.",
                },
              }),
            );
          if (ordinal === 4)
            return completedProcess(
              claudeOutput(COORDINATOR_SESSION_ID, {
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
                resolution: {
                  task_id: TASK_ID,
                  question_id: "revision-question",
                  answer: "Use a boolean because it is the narrowest reversible default.",
                  source: CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT,
                  source_refs: [],
                  assumptions: ["The fixture only needs an observable marker."],
                },
              }),
            );
          if (ordinal === 5) {
            const cwd =
              options.cwd ??
              (() => {
                throw new Error("executor lacks a worktree");
              })();
            mkdirSync(join(cwd, "src"), { recursive: true });
            writeFileSync(join(cwd, CHANGED_PATH), CHANGED_CONTENT);
            git(cwd, ["add", CHANGED_PATH]);
            git(cwd, ["commit", "--quiet", "-m", "feat: add revision autopilot fixture"]);
            git(cwd, ["diff", "--check", "HEAD^", "HEAD"]);
            verifiedHead = git(cwd, ["rev-parse", "HEAD"]);
            return completedProcess(
              codexOutput({
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
                completion: {
                  task_id: TASK_ID,
                  summary: "Implemented and committed the revision autopilot fixture.",
                  changed_paths: [CHANGED_PATH],
                  evidence_refs: ["e2e:executor-commit"],
                  verification: { commands: [VERIFY_COMMAND], passed: true },
                },
              }),
            );
          }
          if (ordinal === 6 && turn.instruction.kind === "coordinator-review") {
            if (!turn.instruction.workspace?.verified_head)
              throw new Error("coordinator review lacks a verified head");
            return completedProcess(
              claudeOutput(COORDINATOR_SESSION_ID, {
                schema_version: "1.0",
                kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
                finalization: {
                  completed_task_ids: [TASK_ID],
                  reviewed_head: turn.instruction.workspace.verified_head,
                  summary: "Reviewed the exact host-verified executor commit.",
                  evidence_refs: [
                    ...turn.instruction.workspace.evidence_refs,
                    "e2e:coordinator-review",
                  ],
                },
              }),
            );
          }
          if (ordinal === 7) {
            expect(turn.instruction.kind).toBe(CONVERSATION_TURN_INSTRUCTION_KIND.DIRECT);
            return completedProcess(
              claudeOutput(DIRECT_CHILD_SESSION_ID, { answer: "Returned to one direct lane." }),
            );
          }
          throw new Error(`unexpected revision coordination attempt ${ordinal}`);
        },
      },
      coordinationVerifier: async ({ cwd, expected_oracles: expectedOracles }) => {
        verifyCalls += 1;
        expect(readFileSync(join(cwd, CHANGED_PATH), "utf8")).toBe(CHANGED_CONTENT);
        git(cwd, ["diff", "--check", "HEAD^", "HEAD"]);
        return {
          report: passingVerifyReport(git(cwd, ["rev-parse", "HEAD"])),
          oracle_results: await runConversationDelegationVerificationOracles(cwd, expectedOracles),
        };
      },
      id: (kind) => `${kind}-revision-coordinate-${++ids}`,
      schedule: (run) => run(),
      libraries,
    });
    const parent = await bootstrap.service.create({
      topic: "Implement a scoped change through an autonomous coordinator",
      policy: CONVERSATION_POLICY.DIRECT,
      participants: [{ role_ref: CONVERSATION_ROLE_NAME.DIRECT, engine: "claude" }],
    });
    expect(parent.result.status).toBe("completed");
    const base = resolveRevisionBase({
      artifactRoot: join(stateDir, "artifacts"),
      traceRoot: join(stateDir, "trace"),
      conversationId: parent.conversation_id,
      home: bootstrap.authorities.homeAuthorities,
    });
    const authority = browserAuthority(base.lineage.root_session_id, "add-executor");
    const proposed = await bootstrap.authorities.browser.actions.propose({
      conversation_id: parent.conversation_id,
      request: {
        schema_version: "1.0",
        idempotency_key: "add-coordination-executor",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision",
          conversation_id: base.parent.node.conversation_id,
          revision_id: base.parent.node.revision_id,
          last_seq: base.parent.source.journal_head.last_seq,
          conversation_lock_digest: base.lock.lock_digest,
        },
        candidate: {
          type: HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
          participant: {
            role_ref: CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
            engine: "codex",
            model: null,
            skill_refs: [],
          },
        },
      },
      authority,
    });
    const addProposal = proposed.response.proposal;
    expect(bootstrap.authorities.artifactStore.read(parent.conversation_id)).toMatchObject({
      policy: CONVERSATION_POLICY.DIRECT,
      bindings: [{ input: { roleRef: CONVERSATION_ROLE_NAME.DIRECT } }],
    });
    expect(bootstrap.authorities.homeAuthorities.publishedRevisionTransitions()).toEqual([]);
    expect(
      await bootstrap.authorities.browser.actions.pending(parent.conversation_id),
    ).toHaveLength(1);
    expect(launches).toHaveLength(1);

    const approved = await bootstrap.authorities.browser.actions.approve({
      conversation_id: parent.conversation_id,
      proposal_id: addProposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: addProposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority,
    });
    await bootstrap.authorities.browser.actions.commit({
      conversation_id: parent.conversation_id,
      proposal_id: addProposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: addProposal.proposal_digest,
        approval_id: approved.approval.approval_id,
      },
      authority,
    });
    const addTransition = bootstrap.authorities.homeAuthorities
      .publishedRevisionTransitions()
      .find(
        ({ authority: transitionAuthority }) =>
          (transitionAuthority as { proposal?: { proposal_id?: string } }).proposal?.proposal_id ===
          addProposal.proposal_id,
      );
    const coordinateId = (
      addTransition?.authority as { operation?: { child?: { conversation_id?: string } } }
    ).operation?.child?.conversation_id;
    if (!coordinateId) throw new Error("coordinate child was not published");
    const coordinateManifest = bootstrap.authorities.artifactStore.read(coordinateId);
    expect(coordinateManifest).toMatchObject({ policy: CONVERSATION_POLICY.COORDINATE });
    expect(
      coordinateManifest?.bindings.map((binding) => ({
        role: binding.input.roleRef,
        engine: binding.input.engine,
        host_tools: binding.host_tools,
      })),
    ).toEqual([
      { role: CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR, engine: "claude", host_tools: [] },
      { role: CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR, engine: "codex", host_tools: [] },
    ]);
    expect((await waitForCompleted(bootstrap, coordinateId)).lifecycle).toBe(
      CONVERSATION_LIFECYCLE.COMPLETED,
    );
    const coordination = await readRuntimeConversationCoordinationState({
      artifactStore: bootstrap.authorities.artifactStore,
      traceStore: bootstrap.authorities.traceStore,
      conversationId: coordinateId,
      revisionId: coordinateManifest?.revision_id ?? "",
    });
    expect(coordination).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.COMPLETED,
      clarification_count: 1,
      user_escalation_count: 0,
      last_resolution: { source: CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT },
    });
    expect(launches).toHaveLength(6);
    expect(barrierLaunches).toHaveLength(2);
    expect(launches[1]?.argv).toContain(COORDINATOR_SESSION_ID);
    expect(launches[2]?.argv).toContain(EXECUTOR_SESSION_ID);
    expect(launches[3]?.argv).toContain(COORDINATOR_SESSION_ID);
    expect(launches[4]?.argv).toContain(EXECUTOR_SESSION_ID);
    expect(launches[5]?.argv).toContain(COORDINATOR_SESSION_ID);
    expect(verifyCalls).toBe(1);
    if (!verifiedHead) throw new Error("executor head was not observed");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(verifiedHead);
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(baseHead);
    expect(readFileSync(join(repo, CHANGED_PATH), "utf8")).toBe(CHANGED_CONTENT);

    const workspaceRecordRoot = join(
      stateDir,
      "artifacts",
      "coordination-workspaces",
      "v1",
      "records",
    );
    const workspaceRecordsBefore = existsSync(workspaceRecordRoot)
      ? readdirSync(workspaceRecordRoot)
          .filter((name) => name.endsWith(".json"))
          .sort()
      : [];
    const worktreesBefore = git(repo, ["worktree", "list", "--porcelain"]);
    const executor = coordinateManifest?.bindings.find(
      (binding) => binding.input.roleRef === CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
    );
    if (!executor) throw new Error("coordinate child lacks the executor binding");
    const removeBase = resolveRevisionBase({
      artifactRoot: join(stateDir, "artifacts"),
      traceRoot: join(stateDir, "trace"),
      conversationId: coordinateId,
      home: bootstrap.authorities.homeAuthorities,
    });
    const removeAuthority = browserAuthority(removeBase.lineage.root_session_id, "remove-executor");
    const removeProposed = await bootstrap.authorities.browser.actions.propose({
      conversation_id: coordinateId,
      request: {
        schema_version: "1.0",
        idempotency_key: "remove-coordination-executor",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision",
          conversation_id: removeBase.parent.node.conversation_id,
          revision_id: removeBase.parent.node.revision_id,
          last_seq: removeBase.parent.source.journal_head.last_seq,
          conversation_lock_digest: removeBase.lock.lock_digest,
        },
        candidate: {
          type: HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
          participant_id: executor.participant_id,
        },
      },
      authority: removeAuthority,
    });
    const removeProposal = removeProposed.response.proposal;
    expect(bootstrap.authorities.artifactStore.read(coordinateId)?.policy).toBe(
      CONVERSATION_POLICY.COORDINATE,
    );
    const removeApproved = await bootstrap.authorities.browser.actions.approve({
      conversation_id: coordinateId,
      proposal_id: removeProposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: removeProposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority: removeAuthority,
    });
    await bootstrap.authorities.browser.actions.commit({
      conversation_id: coordinateId,
      proposal_id: removeProposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: removeProposal.proposal_digest,
        approval_id: removeApproved.approval.approval_id,
      },
      authority: removeAuthority,
    });
    const removeTransition = bootstrap.authorities.homeAuthorities
      .publishedRevisionTransitions()
      .find(
        ({ authority: transitionAuthority }) =>
          (transitionAuthority as { proposal?: { proposal_id?: string } }).proposal?.proposal_id ===
          removeProposal.proposal_id,
      );
    const directId = (
      removeTransition?.authority as { operation?: { child?: { conversation_id?: string } } }
    ).operation?.child?.conversation_id;
    if (!directId) throw new Error("direct child was not published");
    const directManifest = bootstrap.authorities.artifactStore.readRecord(directId);
    expect(directManifest?.manifest).toMatchObject({
      policy: CONVERSATION_POLICY.DIRECT,
      bindings: [
        {
          host_tools: ["propose_action"],
          input: { roleRef: CONVERSATION_ROLE_NAME.DIRECT, engine: "claude" },
        },
      ],
    });
    expect((await waitForCompleted(bootstrap, directId)).lifecycle).toBe(
      CONVERSATION_LIFECYCLE.COMPLETED,
    );
    expect(
      directManifest?.artifacts.filter(
        (artifact) => artifact.artifact_type === CONVERSATION_ARTIFACT_TYPE.COORDINATION,
      ),
    ).toEqual([]);
    const directTrace = await bootstrap.authorities.traceStore.readConversation(directId);
    expect(
      directTrace.some(
        ({ stored_event: event }) =>
          event.event.type === CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION &&
          event.event.payload.tool === CONVERSATION_COORDINATION_TOOL,
      ),
    ).toBeFalse();
    const directCoordination = await readRuntimeConversationCoordinationState({
      artifactStore: bootstrap.authorities.artifactStore,
      traceStore: bootstrap.authorities.traceStore,
      conversationId: directId,
      revisionId: directManifest?.manifest.revision_id ?? "",
    });
    expect(directCoordination).toMatchObject({
      epoch_id: null,
      phase: CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING,
      committed_records: [],
      pending_records: [],
    });
    const workspaceRecordsAfter = existsSync(workspaceRecordRoot)
      ? readdirSync(workspaceRecordRoot)
          .filter((name) => name.endsWith(".json"))
          .sort()
      : [];
    expect(workspaceRecordsAfter).toEqual(workspaceRecordsBefore);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
    expect(launches).toHaveLength(7);
    expect(barrierLaunches).toHaveLength(3);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

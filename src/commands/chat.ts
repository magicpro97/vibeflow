import {
  type ObservedConversationResultV1,
  durableCliIdempotencyKey,
  durableCliPrincipalDigest,
  executeDurableQueuedConversationMessageV1,
} from "../orchestrator/conversation/conversation-command-compatibility.js";
import {
  type DurableConversationCreateV1,
  executeDurableConversationCreateV1,
} from "../orchestrator/conversation/conversation-command-create-compatibility.js";
import {
  CONVERSATION_EXIT,
  type ConversationCommandDeps,
  assertNoResumeCreateFlags,
  c,
  classifyConversationError,
  classifyConversationResult,
  conversationBootstrap,
  conversationJsonErrorCode,
  conversationService,
  executeConversationCreate,
  executeConversationMessage,
  jsonWrite,
  out,
  parseConversationArgv,
  parseMaxRounds,
  parseOptionalResumeId,
  parseParticipantSpec,
} from "./_shared.js";

interface ChatDeps extends ConversationCommandDeps {
  durable?: {
    create(
      input: DurableConversationCreateV1,
      onDelta?: (chunk: string) => void,
      options?: { signal?: AbortSignal },
    ): Promise<ObservedConversationResultV1>;
    message(
      input: Parameters<typeof executeDurableQueuedConversationMessageV1>[1],
      onDelta?: (chunk: string) => void,
      options?: { signal?: AbortSignal },
    ): Promise<ObservedConversationResultV1>;
  };
}

export async function chat(argv: string[], deps: ChatDeps = {}): Promise<number> {
  const parsed = parseConversationArgv(argv, [
    "json",
    "policy",
    "resume",
    "max-rounds",
    "no-baseline",
  ]);
  const json = parsed.flags.json === true;
  const options = parsed.flags["no-baseline"] === true ? { baselineEnabled: false } : undefined;
  if (parsed.unknownFlags.length) {
    if (json) {
      jsonWrite({ ok: false, code: "unknown_flags", flags: parsed.unknownFlags });
      return CONVERSATION_EXIT.validation;
    }
    out("vf", c.red(`chat: unknown flag(s): ${parsed.unknownFlags.join(", ")}`), {
      level: "error",
    });
    return CONVERSATION_EXIT.validation;
  }
  const content = parsed.positionals.join(" ").trim();
  try {
    const resumeId = parseOptionalResumeId(parsed);
    if (!content) {
      if (json) {
        jsonWrite({ ok: false, code: "missing_topic" });
        return CONVERSATION_EXIT.validation;
      }
      out("vf", c.red('chat: missing topic — e.g. `vf chat "Explain this code"`'), {
        level: "error",
      });
      return CONVERSATION_EXIT.validation;
    }
    if (resumeId) {
      assertNoResumeCreateFlags(parsed, ["policy", "participant", "max-rounds", "no-baseline"]);
    }
    const participants = parsed.participants.map(parseParticipantSpec);
    const maxRounds = parseMaxRounds(parsed.flags["max-rounds"]);
    const bootstrap = deps.durable
      ? null
      : conversationBootstrap({ ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}) });
    const durable: NonNullable<ChatDeps["durable"]> = deps.durable ?? {
      create(input, onDelta, createOptions) {
        return executeDurableConversationCreateV1(
          bootstrap as NonNullable<typeof bootstrap>,
          input,
          onDelta,
          createOptions,
        );
      },
      message(input, onDelta, messageOptions) {
        return executeDurableQueuedConversationMessageV1(
          bootstrap as NonNullable<typeof bootstrap>,
          input,
          onDelta,
          messageOptions,
        );
      },
    };
    if (resumeId) {
      const resumed =
        deps.service || deps.createService
          ? await executeConversationMessage(
              conversationService(deps),
              resumeId,
              content,
              json ? undefined : (chunk) => process.stdout.write(chunk),
            )
          : await durable.message(
              {
                conversation_id: resumeId,
                principal_digest: durableCliPrincipalDigest("vf.chat"),
                idempotency_key: durableCliIdempotencyKey("vf.chat.message", {
                  conversation_id: resumeId,
                }),
                content,
              },
              json ? undefined : (chunk) => process.stdout.write(chunk),
            );
      const exit = classifyConversationResult(resumed.status, resumed.events);
      if (json) {
        jsonWrite({
          ok: exit === CONVERSATION_EXIT.ok,
          conversation_id: resumed.conversationId,
          child_conversation_id: resumed.childConversationId ?? null,
          status: resumed.status,
          output: resumed.output,
        });
        return exit;
      }
      return exit;
    }
    const execution =
      deps.service || deps.createService
        ? await executeConversationCreate(
            conversationService(deps),
            {
              topic: content,
              ...(typeof parsed.flags.policy === "string" ? { policy: parsed.flags.policy } : {}),
              ...(participants.length ? { participants } : {}),
              ...(maxRounds ? { max_rounds: maxRounds } : {}),
            },
            json ? undefined : (chunk) => process.stdout.write(chunk),
            options,
          )
        : await durable.create(
            {
              principal_digest: durableCliPrincipalDigest("vf.chat"),
              idempotency_key: durableCliIdempotencyKey("vf.chat.create", {
                topic: content,
                ...(typeof parsed.flags.policy === "string" ? { policy: parsed.flags.policy } : {}),
                ...(participants.length ? { participants } : {}),
                ...(maxRounds ? { max_rounds: maxRounds } : {}),
              }),
              request: {
                topic: content,
                ...(typeof parsed.flags.policy === "string" ? { policy: parsed.flags.policy } : {}),
                ...(participants.length ? { participants } : {}),
                ...(maxRounds ? { max_rounds: maxRounds } : {}),
              },
              ...(options ? { options } : {}),
            },
            json ? undefined : (chunk) => process.stdout.write(chunk),
          );
    const exit = classifyConversationResult(execution.status, execution.events);
    if (json) {
      jsonWrite({
        ok: exit === CONVERSATION_EXIT.ok,
        conversation_id: execution.conversationId,
        revision_id: execution.revisionId ?? null,
        status: execution.status,
        artifact_refs: execution.artifactRefs,
        output: execution.output,
      });
      return exit;
    }
    return exit;
  } catch (error) {
    if (json) {
      const exit = classifyConversationError(error);
      jsonWrite({ ok: false, code: conversationJsonErrorCode(exit) });
      return exit;
    }
    out("vf", c.red(`chat: ${error instanceof Error ? error.message : String(error)}`), {
      level: "error",
    });
    return classifyConversationError(error);
  }
}

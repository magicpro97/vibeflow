import {
  brainstormErrorJson,
  brainstormErrorMessageForExit,
  brainstormExecutionJson,
  normalizedBrainstormErrorExit,
  projectBrainstormDryRunParticipant,
} from "../orchestrator/conversation/brainstorm-output.js";
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
import type {
  ConversationCreateRequest,
  DryRunResult,
} from "../orchestrator/conversation/types.js";
import {
  CONVERSATION_EXIT,
  type ConversationCommandDeps,
  assertNoResumeCreateFlags,
  c,
  classifyConversationError,
  classifyConversationResult,
  conversationBootstrap,
  conversationService,
  executeConversationCreate,
  executeConversationMessage,
  jsonWrite,
  out,
  parseConversationArgv,
  parseMaxRounds,
  parseOptionalResumeId,
  parseParticipantSpec,
  publicResumeValidationMessage,
} from "./_shared.js";
type BrainstormDeps = ConversationCommandDeps & {
  dryRun?: (
    request: ConversationCreateRequest,
    options?: { baselineEnabled?: boolean },
  ) => Promise<DryRunResult>;
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
};
const hasEvaluator = (participants: readonly { role_ref: string }[]): boolean =>
  participants.some((participant) => participant.role_ref === "brainstorm-evaluator");
const writeBrainstormError = (exit: number): number => {
  jsonWrite(brainstormErrorJson(exit));
  return exit;
};
export async function brainstorm(argv: string[], deps: BrainstormDeps = {}): Promise<number> {
  const parsed = parseConversationArgv(argv, [
    "json",
    "yes",
    "resume",
    "max-rounds",
    "no-baseline",
  ]);
  const json = parsed.flags.json === true;
  const options = parsed.flags["no-baseline"] === true ? { baselineEnabled: false } : undefined;
  if (parsed.unknownFlags.length) {
    if (json) return writeBrainstormError(CONVERSATION_EXIT.validation);
    out("vf", c.red(`brainstorm: unknown flag(s): ${parsed.unknownFlags.join(", ")}`), {
      level: "error",
    });
    return CONVERSATION_EXIT.validation;
  }
  const topic = parsed.positionals.join(" ").trim();
  try {
    const resumeId = parseOptionalResumeId(parsed);
    if (!topic && !resumeId) {
      if (json) return writeBrainstormError(CONVERSATION_EXIT.validation);
      out("vf", c.red('brainstorm: missing topic — e.g. `vf brainstorm "Compare options"`'), {
        level: "error",
      });
      return CONVERSATION_EXIT.validation;
    }
    if (resumeId) assertNoResumeCreateFlags(parsed, ["participant", "max-rounds", "no-baseline"]);
    const explicit = parsed.participants.map(parseParticipantSpec);
    const maxRounds = parseMaxRounds(parsed.flags["max-rounds"]);
    const request: ConversationCreateRequest = {
      topic,
      policy: "debate",
      ...(explicit.length ? { participants: explicit } : {}),
      ...(maxRounds ? { max_rounds: maxRounds } : {}),
    };
    const bootstrap = deps.durable
      ? null
      : conversationBootstrap({ ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}) });
    const durable: NonNullable<BrainstormDeps["durable"]> = deps.durable ?? {
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
              topic,
              json ? undefined : (chunk) => process.stdout.write(chunk),
            )
          : await durable.message(
              {
                conversation_id: resumeId,
                principal_digest: durableCliPrincipalDigest("vf.brainstorm"),
                idempotency_key: durableCliIdempotencyKey("vf.brainstorm.message", {
                  conversation_id: resumeId,
                }),
                content: topic,
              },
              json ? undefined : (chunk) => process.stdout.write(chunk),
            );
      const exit = classifyConversationResult(resumed.status, resumed.events);
      if (json) {
        jsonWrite(
          await brainstormExecutionJson(
            conversationService(deps),
            resumed,
            options?.baselineEnabled ?? true,
            [],
          ),
        );
      }
      return exit;
    }
    const service = conversationService(deps);
    const preview = deps.dryRun
      ? await deps.dryRun(request, options)
      : await service.dryRun(request, options);
    const nonEvaluators = preview.participants.filter(
      (participant) => participant.role_ref !== "brainstorm-evaluator",
    );
    const evaluators = preview.participants.filter(
      (participant) => participant.role_ref === "brainstorm-evaluator",
    );
    if (nonEvaluators.length < 2) {
      throw new Error("brainstorm requires at least two non-evaluator participants");
    }
    if (
      evaluators.length !== 1 ||
      (explicit.length > 0 && !hasEvaluator(explicit) && !preview.evaluator_auto_added)
    ) {
      throw new Error("brainstorm requires exactly one evaluator");
    }
    if (parsed.flags.yes !== true) {
      if (json) {
        return jsonWrite(
          Object.freeze({
            status: "dry_run" as const,
            dry_run: true,
            participants: preview.participants.map(projectBrainstormDryRunParticipant),
            evaluator_auto_added: preview.evaluator_auto_added,
            engines_available: preview.engines_available,
            models_valid: preview.models_valid,
          }),
        );
      }
      out(
        "vf",
        c.dim(
          `brainstorm: dry run with ${preview.participants.length} participants (${preview.engines_available.join(", ") || "no ready engines"})`,
        ),
      );
      return CONVERSATION_EXIT.ok;
    }
    const execution =
      deps.service || deps.createService
        ? await executeConversationCreate(
            service,
            request,
            json ? undefined : (chunk) => process.stdout.write(chunk),
            options,
          )
        : await durable.create(
            {
              principal_digest: durableCliPrincipalDigest("vf.brainstorm"),
              idempotency_key: durableCliIdempotencyKey("vf.brainstorm.create", {
                topic,
                participants: explicit,
                max_rounds: maxRounds,
              }),
              request: {
                topic,
                policy: "debate",
                ...(explicit.length ? { participants: explicit } : {}),
                ...(maxRounds ? { max_rounds: maxRounds } : {}),
              },
              ...(options ? { options } : {}),
            },
            json ? undefined : (chunk) => process.stdout.write(chunk),
          );
    const exit = classifyConversationResult(execution.status, execution.events);
    if (json) {
      jsonWrite(
        await brainstormExecutionJson(
          service,
          execution,
          options?.baselineEnabled ?? true,
          preview.participants,
        ),
      );
    }
    return exit;
  } catch (error) {
    const exit = normalizedBrainstormErrorExit(classifyConversationError(error));
    const message = publicResumeValidationMessage(error) ?? brainstormErrorMessageForExit(exit);
    if (json) return writeBrainstormError(exit);
    out("vf", c.red(`brainstorm: ${message}`), {
      level: "error",
    });
    return exit;
  }
}

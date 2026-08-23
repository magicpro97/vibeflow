import {
  CONVERSATION_EXIT,
  type ConversationCommandDeps,
  assertNoResumeCreateFlags,
  c,
  classifyConversationError,
  classifyConversationResult,
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

export async function chat(argv: string[], deps: ConversationCommandDeps = {}): Promise<number> {
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
    const service = conversationService(deps);
    if (resumeId) {
      const resumed = await executeConversationMessage(
        service,
        resumeId,
        content,
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
    const execution = await executeConversationCreate(
      service,
      {
        topic: content,
        ...(typeof parsed.flags.policy === "string" ? { policy: parsed.flags.policy } : {}),
        ...(participants.length ? { participants } : {}),
        ...(maxRounds ? { max_rounds: maxRounds } : {}),
      },
      json ? undefined : (chunk) => process.stdout.write(chunk),
      options,
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

import { readFileSync } from "node:fs";
import {
  type AskInvocation,
  type ParsedTarget,
  askInvocation,
  framePrompt,
  inheritSpawn,
  langFence,
  parseTarget,
  pickEngine,
  resumeInvocation,
  sliceRange,
} from "../ask-support.js";
import { ENGINES, type Engine, c, cwd } from "../core.js";
import { out } from "../logbus.js";
import {
  type DurableQueuedConversationMessageV1,
  type ObservedConversationResultV1,
  durableCliIdempotencyKey,
  durableCliPrincipalDigest,
  executeDurableAskV1,
  executeDurableQueuedConversationMessageV1,
  repoRelativePrivateRange,
} from "../orchestrator/conversation/conversation-command-compatibility.js";
import { preflightAllAsync } from "../preflight.js";
import type { EngineReadiness } from "../preflight/types.js";
import {
  type ConversationCommandDeps,
  classifyConversationResult,
  conversationBootstrap,
  conversationService,
  executeConversationCreate,
  executeConversationMessage,
} from "./_shared.js";
export {
  type AskInvocation,
  type ParsedTarget,
  askInvocation,
  captureSpawn,
  captureSpawnAsync,
  framePrompt,
  inheritSpawn,
  langFence,
  materializeArgs,
  parseTarget,
  pickEngine,
  resumeInvocation,
  sliceRange,
  streamSpawnAsync,
} from "../ask-support.js";

export interface AskDeps {
  readiness?: (engines: Engine[]) => EngineReadiness[] | Promise<EngineReadiness[]>;
  spawn?: (inv: AskInvocation, prompt: string) => number | Promise<number>;
  readText?: (path: string) => string;
  service?: ConversationCommandDeps["service"];
  createService?: ConversationCommandDeps["createService"];
  bootstrap?: ConversationCommandDeps["bootstrap"];
  durable?: {
    ask(
      input: Parameters<typeof executeDurableAskV1>[1],
      onDelta?: (chunk: string) => void,
    ): Promise<ObservedConversationResultV1>;
    message(
      input: DurableQueuedConversationMessageV1,
      onDelta?: (chunk: string) => void,
    ): Promise<ObservedConversationResultV1>;
  };
}

function fail(msg: string): number {
  out("vf", c.red(`ask: ${msg}`), { level: "error" });
  return 2;
}

export async function ask(
  positionals: string[],
  flags: Record<string, string | boolean> = {},
  deps: AskDeps = {},
): Promise<number> {
  // --resume may arrive as boolean `true` (last token) OR as a string, because
  // parseFlags binds the following non-dash token as the flag's VALUE:
  // `vf ask --resume "why?"` → flags.resume === "why?". Treat any truthy value as
  // resume, and fold a string value back in as the first word of the question.
  const resume = flags.resume === true || typeof flags.resume === "string";
  const resumeLead = typeof flags.resume === "string" ? flags.resume : "";
  const conversationId =
    typeof flags.conversation === "string" && flags.conversation.trim()
      ? flags.conversation.trim()
      : null;

  if (deps.spawn) {
    const readiness = await (
      deps.readiness ?? ((e: Engine[]) => preflightAllAsync(e, { probe: true }))
    )(ENGINES);
    const engine = pickEngine(
      readiness,
      typeof flags.engine === "string" ? flags.engine : undefined,
    );
    if (typeof engine === "string" && !(ENGINES as string[]).includes(engine)) return fail(engine);
    const eng = engine as Engine;
    if (resume) {
      const question = [resumeLead, ...positionals].join(" ").trim();
      if (!question)
        return fail('missing question — e.g. `vf ask --resume "and why is that safe?"`');
      const inv = resumeInvocation(eng);
      if (typeof inv === "string") return fail(inv);
      out("vf", c.dim(`ask: ${eng} · continuing previous conversation`));
      return await deps.spawn(inv, question);
    }
    const target = parseTarget(positionals[0]);
    if (typeof target === "string") return fail(target);
    const question = positionals.slice(1).join(" ").trim();
    if (!question)
      return fail('missing question — e.g. `vf ask src/x.ts:5-12 "what does this do?"`');
    const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"));
    let text: string;
    try {
      text = readText(target.path);
    } catch {
      return fail(`no such file: ${target.path}`);
    }
    const sliced = sliceRange(text, target.start, target.end);
    if (typeof sliced === "string") return fail(sliced);
    const lang = langFence(target.path);
    const prompt = framePrompt(
      target.path,
      target.start,
      target.end,
      lang,
      sliced.snippet,
      question,
    );
    const inv = askInvocation(eng);
    out("vf", c.dim(`ask: ${eng} · ${target.path}:${target.start}-${target.end}`));
    return await deps.spawn(inv, prompt);
  }

  if (resume && !conversationId)
    return fail(
      "ask resume now requires --conversation <id>; native latest-session resume is disabled",
    );

  const target =
    !resume && positionals[0] && typeof parseTarget(positionals[0]) !== "string"
      ? (parseTarget(positionals[0]) as ParsedTarget)
      : null;
  const question = (
    resume ? [resumeLead, ...positionals] : target ? positionals.slice(1) : positionals
  )
    .join(" ")
    .trim();
  if (!question)
    return fail(
      conversationId
        ? 'missing question — e.g. `vf ask --conversation conversation-123 "revise that answer"`'
        : 'missing question — e.g. `vf ask src/x.ts:5-12 "what does this do?"`',
    );

  if (deps.service || deps.createService) {
    const service = conversationService(
      {
        ...(deps.service ? { service: deps.service } : {}),
        ...(deps.createService ? { createService: deps.createService } : {}),
        ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}),
      },
      cwd(),
    );
    if (conversationId) {
      const prompt =
        target === null
          ? question
          : (() => {
              const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"));
              let text: string;
              try {
                text = readText(target.path);
              } catch {
                throw new Error(`no such file: ${target.path}`);
              }
              const sliced = sliceRange(text, target.start, target.end);
              if (typeof sliced === "string") throw new Error(sliced);
              return framePrompt(
                target.path,
                target.start,
                target.end,
                langFence(target.path),
                sliced.snippet,
                question,
              );
            })();
      const resumed = await executeConversationMessage(service, conversationId, prompt, (chunk) =>
        process.stdout.write(chunk),
      );
      return classifyConversationResult(resumed.status, resumed.events);
    }
    if (!target) return fail('missing <path>:<lines> — e.g. `vf ask src/x.ts:5-12 "why?"`');
    const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"));
    let text: string;
    try {
      text = readText(target.path);
    } catch {
      return fail(`no such file: ${target.path}`);
    }
    const sliced = sliceRange(text, target.start, target.end);
    if (typeof sliced === "string") return fail(sliced);
    const readiness = await (
      deps.readiness ?? ((e: Engine[]) => preflightAllAsync(e, { probe: true }))
    )(ENGINES);
    const engine = pickEngine(
      readiness,
      typeof flags.engine === "string" ? flags.engine : undefined,
    );
    if (typeof engine === "string" && !(ENGINES as string[]).includes(engine)) return fail(engine);
    const execution = await executeConversationCreate(
      service,
      {
        topic: framePrompt(
          target.path,
          target.start,
          target.end,
          langFence(target.path),
          sliced.snippet,
          question,
        ),
        policy: "direct",
        participants: [
          {
            role_ref: "direct",
            engine: engine as Engine,
          },
        ],
      },
      (chunk) => process.stdout.write(chunk),
    );
    return classifyConversationResult(execution.status, execution.events);
  }

  const bootstrap = deps.durable
    ? null
    : conversationBootstrap({ ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}) });
  const durable = deps.durable ?? {
    ask: (input: Parameters<typeof executeDurableAskV1>[1], onDelta?: (chunk: string) => void) =>
      executeDurableAskV1(bootstrap as NonNullable<typeof bootstrap>, input, onDelta),
    message: (input: DurableQueuedConversationMessageV1, onDelta?: (chunk: string) => void) =>
      executeDurableQueuedConversationMessageV1(
        bootstrap as NonNullable<typeof bootstrap>,
        input,
        onDelta,
      ),
  };
  const principalDigest = durableCliPrincipalDigest("vf.ask");
  if (conversationId) {
    const resumed = await durable.message(
      {
        conversation_id: conversationId,
        principal_digest: principalDigest,
        idempotency_key: durableCliIdempotencyKey("vf.ask.resume", {
          conversation_id: conversationId,
          question,
          ...(target
            ? {
                path: target.path,
                start: target.start,
                end: target.end,
              }
            : {}),
        }),
        content: question,
        ...(target
          ? (() => {
              const selected = repoRelativePrivateRange(
                cwd(),
                target.path,
                target.start,
                target.end,
              );
              if (typeof selected === "string") throw new Error(selected);
              return { private_file_range: selected };
            })()
          : {}),
      },
      (chunk) => process.stdout.write(chunk),
    );
    return classifyConversationResult(resumed.status, resumed.events);
  }
  if (!target) return fail('missing <path>:<lines> — e.g. `vf ask src/x.ts:5-12 "why?"`');
  const selected = repoRelativePrivateRange(cwd(), target.path, target.start, target.end);
  if (typeof selected === "string") return fail(selected);
  const readiness = await (
    deps.readiness ?? ((e: Engine[]) => preflightAllAsync(e, { probe: true }))
  )(ENGINES);
  const engine = pickEngine(readiness, typeof flags.engine === "string" ? flags.engine : undefined);
  if (typeof engine === "string" && !(ENGINES as string[]).includes(engine)) return fail(engine);
  const created = await durable.ask(
    {
      principal_digest: principalDigest,
      idempotency_key: durableCliIdempotencyKey("vf.ask.create", {
        question,
        ...selected,
        engine,
      }),
      request: {
        kind: "fresh",
        question,
        repo_relative_path: selected.repo_relative_path,
        start_line: selected.start_line,
        end_line: selected.end_line,
        engine: engine as Engine,
      },
    },
    (chunk) => process.stdout.write(chunk),
  );
  return classifyConversationResult(created.status, created.events);
}

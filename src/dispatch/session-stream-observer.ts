import type { Engine } from "../core.js";
import { normalizedAttemptError } from "./attempt-handle.js";
import type { OwnedProcessTerminalKind } from "./owned-process-contract.js";
import type { SessionStdoutState } from "./session-output.js";
import type { InternalResumeBinding } from "./session-types.js";

export function createSessionStreamObserver(input: {
  attemptId: string;
  engine: Engine;
  onAcknowledged: () => void;
  onActivity: () => void;
  onChunk?: (chunk: { stream: "stdout" | "stderr"; content: string }) => void;
  onError: (error: Error) => void;
  onTerminal: (kind: OwnedProcessTerminalKind) => void;
  privateValues: string[];
  readResumeBinding: () => InternalResumeBinding | undefined;
  stdout: SessionStdoutState;
  writeResumeBinding: (binding: InternalResumeBinding) => void;
}) {
  const emitChunk = (stream: "stdout" | "stderr", content: string) => {
    try {
      input.onChunk?.({ stream, content });
    } catch (error) {
      input.onError(normalizedAttemptError(error));
    }
  };
  const consumeOutput = (stream: "stdout" | "stderr", content: string, flush: boolean) => {
    const resume = input.readResumeBinding();
    const projected = input.stdout.consume(
      stream,
      content,
      flush,
      resume?.nativeSessionId,
      input.privateValues,
    );
    const observed = projected.observation;
    if (observed?.nativeSessionId && !resume) {
      input.writeResumeBinding({
        attemptId: input.attemptId,
        engine: input.engine,
        nativeSessionId: observed.nativeSessionId,
      });
    }
    if (observed?.terminal) input.onTerminal(observed.terminal.kind);
    if (observed?.acknowledged) input.onAcknowledged();
    for (const frame of projected.frames) emitChunk(frame.stream, frame.content);
  };
  const readStream = async (
    stream: ReadableStream<Uint8Array> | null | undefined,
    kind: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        consumeOutput(kind, decoder.decode(), true);
        return;
      }
      const content = decoder.decode(value, { stream: true });
      if (!content) continue;
      input.onActivity();
      consumeOutput(kind, content, false);
    }
  };
  return { readStream };
}

import type { Engine } from "../core.js";
import { normalizedAttemptError } from "./attempt-handle.js";
import type { OwnedProcessTerminalKind } from "./owned-process-contract.js";
import type { EngineOutputStream } from "./session-contract.js";
import type { SessionStdoutState } from "./session-output.js";
import type { InternalResumeBinding } from "./session-types.js";

export function createSessionStreamObserver(input: {
  attemptId: string;
  clearResumeBinding: () => void;
  engine: Engine;
  onAcknowledged: () => void;
  onActivity: () => void;
  onChunk?: (chunk: { stream: EngineOutputStream; content: string }) => void;
  onError: (error: Error) => void;
  onTerminal: (kind: OwnedProcessTerminalKind) => void;
  privateValues: string[];
  requestedResumeId?: string;
  readResumeBinding: () => InternalResumeBinding | undefined;
  stdout: SessionStdoutState;
  writeResumeBinding: (binding: InternalResumeBinding) => void;
}) {
  let resumeProofRejected = false;
  const emitChunk = (stream: EngineOutputStream, content: string) => {
    try {
      input.onChunk?.({ stream, content });
    } catch (error) {
      input.onError(normalizedAttemptError(error));
    }
  };
  const consumeOutput = (stream: EngineOutputStream, content: string, flush: boolean) => {
    const resume = input.readResumeBinding();
    const projected = input.stdout.consume(
      stream,
      content,
      flush,
      resume?.nativeSessionId ?? input.requestedResumeId,
      input.privateValues,
    );
    const observed = projected.observation;
    if (observed?.nativeSessionMismatch && !resumeProofRejected) {
      resumeProofRejected = true;
      input.clearResumeBinding();
      if (
        observed.nativeSessionMismatchId &&
        !input.privateValues.includes(observed.nativeSessionMismatchId)
      )
        input.privateValues.push(observed.nativeSessionMismatchId);
      input.onError(new Error(`${input.engine} exact native session acknowledgement mismatched`));
    } else if (!resumeProofRejected && observed?.nativeSessionId && !resume) {
      input.writeResumeBinding({
        attemptId: input.attemptId,
        engine: input.engine,
        nativeSessionId: observed.nativeSessionId,
      });
    }
    if (observed?.terminal) input.onTerminal(observed.terminal.kind);
    if (!resumeProofRejected && observed?.acknowledged) input.onAcknowledged();
    for (const frame of projected.frames) emitChunk(frame.stream, frame.content);
  };
  const readStream = async (
    stream: ReadableStream<Uint8Array> | null | undefined,
    kind: EngineOutputStream,
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

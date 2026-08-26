import type { Engine } from "../core.js";
import { TRACE_LIMITS } from "../orchestrator/trace/limits.js";
import { projectPublicEngineFrames, sanitizePublicEngineText } from "./public-redaction.js";
import { observeSessionStdout } from "./session-protocol.js";
import { observeSessionTerminal } from "./session-terminal.js";
import type { EngineSessionAdapterOptions } from "./session-types.js";

const OUTPUT_TRUNCATION = "[redacted-oversize]\n";
const RETAINED_STDOUT_BYTES = TRACE_LIMITS.maxTextBytes - Buffer.byteLength(OUTPUT_TRUNCATION);
type PublicStream = "stdout" | "stderr";
interface PublicFrame {
  readonly stream: PublicStream;
  readonly content: string;
}

/** Bounded internal state for public output retention and raw protocol observation. */
export class SessionStdoutState {
  readonly #retained = Buffer.alloc(RETAINED_STDOUT_BYTES);
  readonly #publicBuffers = { stdout: "", stderr: "" };
  readonly #discardingOversize = { stdout: false, stderr: false };
  #protocolBuffer = "";
  #discardingOversizeProtocol = false;
  readonly #openCodeFlushed = { stdout: false, stderr: false };
  #pendingOpenCodeFrames: PublicFrame[] = [];
  #pendingOpenCodeBytes = 0;
  #pendingOpenCodeTruncated = false;
  readonly #protocol: EngineSessionAdapterOptions["protocol"];
  readonly #engine: Engine;
  #start = 0;
  #length = 0;
  #truncated = false;

  constructor(protocol: EngineSessionAdapterOptions["protocol"], engine: Engine) {
    this.#protocol = protocol;
    this.#engine = engine;
  }

  consume(
    stream: PublicStream,
    content: string,
    flush: boolean,
    nativeSessionId: string | undefined,
    privateValues: readonly string[],
  ): {
    frames: PublicFrame[];
    observation?: {
      acknowledged: boolean;
      nativeSessionId?: string;
      terminal?: ReturnType<typeof observeSessionTerminal>;
    };
  } {
    const buffered = this.#publicBuffers[stream] + content;
    const observation = stream === "stdout" ? this.#observe(content, flush) : undefined;
    const projected = projectPublicEngineFrames(
      buffered,
      nativeSessionId ?? observation?.nativeSessionId,
      flush,
      privateValues,
      this.#discardingOversize[stream],
    );
    this.#publicBuffers[stream] = projected.remainder;
    this.#discardingOversize[stream] = projected.discardingOversize;
    const frames = this.#releaseOpenCodeFrames(
      stream,
      projected.frames,
      nativeSessionId ?? observation?.nativeSessionId,
      flush,
      privateValues,
    );
    for (const frame of frames) {
      if (frame.stream === "stdout") this.#retainPublicFrame(frame.content);
    }
    return { frames, ...(observation ? { observation } : {}) };
  }

  #releaseOpenCodeFrames(
    stream: PublicStream,
    frames: readonly string[],
    nativeSessionId: string | undefined,
    flush: boolean,
    privateValues: readonly string[],
  ): PublicFrame[] {
    const projected = frames.map((content) => ({ stream, content }));
    if (this.#engine !== "opencode") return projected;
    if (flush) this.#openCodeFlushed[stream] = true;
    for (const frame of projected) {
      if (this.#pendingOpenCodeTruncated) continue;
      const bytes = Buffer.byteLength(frame.content);
      if (this.#pendingOpenCodeBytes + bytes > RETAINED_STDOUT_BYTES) {
        const retainedStream =
          frame.stream === "stdout" ||
          this.#pendingOpenCodeFrames.some((pending) => pending.stream === "stdout")
            ? "stdout"
            : frame.stream;
        this.#pendingOpenCodeFrames = [{ stream: retainedStream, content: OUTPUT_TRUNCATION }];
        this.#pendingOpenCodeBytes = Buffer.byteLength(OUTPUT_TRUNCATION);
        this.#pendingOpenCodeTruncated = true;
        continue;
      }
      this.#pendingOpenCodeFrames.push(frame);
      this.#pendingOpenCodeBytes += bytes;
    }
    if (!nativeSessionId && !(this.#openCodeFlushed.stdout && this.#openCodeFlushed.stderr)) {
      return [];
    }
    const released = this.#pendingOpenCodeFrames;
    this.#pendingOpenCodeFrames = [];
    this.#pendingOpenCodeBytes = 0;
    this.#pendingOpenCodeTruncated = false;
    return nativeSessionId
      ? released.map((frame) => ({
          ...frame,
          content: sanitizePublicEngineText(frame.content, [nativeSessionId], privateValues),
        }))
      : released;
  }

  #retainPublicFrame(content: string): void {
    const bytes = Buffer.from(content);
    if (bytes.length === 0) return;
    if (bytes.length >= RETAINED_STDOUT_BYTES) {
      this.#truncated ||= this.#length > 0 || bytes.length > RETAINED_STDOUT_BYTES;
      bytes.copy(this.#retained, 0, bytes.length - RETAINED_STDOUT_BYTES);
      this.#start = 0;
      this.#length = RETAINED_STDOUT_BYTES;
      return;
    }

    const writeAt = (this.#start + this.#length) % RETAINED_STDOUT_BYTES;
    const first = Math.min(bytes.length, RETAINED_STDOUT_BYTES - writeAt);
    bytes.copy(this.#retained, writeAt, 0, first);
    if (first < bytes.length) bytes.copy(this.#retained, 0, first);
    const overflow = Math.max(0, this.#length + bytes.length - RETAINED_STDOUT_BYTES);
    if (overflow > 0) {
      this.#start = (this.#start + overflow) % RETAINED_STDOUT_BYTES;
      this.#truncated = true;
    }
    this.#length = Math.min(RETAINED_STDOUT_BYTES, this.#length + bytes.length);
  }

  #observe(
    content: string,
    flush: boolean,
  ): {
    acknowledged: boolean;
    nativeSessionId?: string;
    terminal?: ReturnType<typeof observeSessionTerminal>;
  } {
    const incremental =
      this.#protocol === "bridge" || this.#engine === "copilot" || this.#engine === "antigravity";
    if (incremental) return observeSessionStdout(this.#protocol, this.#engine, content);

    let input = this.#protocolBuffer + content;
    this.#protocolBuffer = "";
    if (this.#discardingOversizeProtocol) {
      const discardedThrough = input.indexOf("\n");
      if (discardedThrough < 0) {
        if (flush) this.#discardingOversizeProtocol = false;
        return { acknowledged: false };
      }
      input = input.slice(discardedThrough + 1);
      this.#discardingOversizeProtocol = false;
    }

    let acknowledged = false;
    let nativeSessionId: string | undefined;
    let terminal = undefined as ReturnType<typeof observeSessionTerminal>;
    const observeRecord = (record: string) => {
      if (Buffer.byteLength(record) > TRACE_LIMITS.maxRecordBytes) return;
      const observed = observeSessionStdout(this.#protocol, this.#engine, record);
      terminal ??= observeSessionTerminal(this.#protocol, this.#engine, record);
      acknowledged ||= observed.acknowledged;
      if (
        observed.nativeSessionId &&
        (this.#engine === "claude" || nativeSessionId === undefined)
      ) {
        nativeSessionId = observed.nativeSessionId;
      }
    };

    let start = 0;
    let newline = input.indexOf("\n", start);
    while (newline >= 0) {
      observeRecord(input.slice(start, newline + 1));
      start = newline + 1;
      newline = input.indexOf("\n", start);
    }
    const remainder = input.slice(start);
    if (flush) observeRecord(remainder);
    else if (Buffer.byteLength(remainder) > TRACE_LIMITS.maxRecordBytes) {
      this.#discardingOversizeProtocol = true;
    } else {
      this.#protocolBuffer = remainder;
    }
    return {
      acknowledged,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(terminal ? { terminal } : {}),
    };
  }

  publicOutput(nativeIds: readonly string[], privateValues: readonly string[]): string {
    const retained = Buffer.allocUnsafe(this.#length);
    const first = Math.min(this.#length, RETAINED_STDOUT_BYTES - this.#start);
    this.#retained.copy(retained, 0, this.#start, this.#start + first);
    if (first < this.#length) this.#retained.copy(retained, first, 0, this.#length - first);
    let offset = 0;
    if (this.#truncated) {
      while (offset < retained.length && (retained[offset] as number) >> 6 === 2) offset++;
    }
    return sanitizePublicEngineText(
      `${this.#truncated ? OUTPUT_TRUNCATION : ""}${retained.subarray(offset).toString()}`,
      nativeIds,
      privateValues,
    );
  }
}

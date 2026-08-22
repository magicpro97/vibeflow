import type { Engine } from "../core.js";
import { TRACE_LIMITS } from "../orchestrator/trace/limits.js";
import { projectPublicEngineFrames, sanitizePublicEngineText } from "./public-redaction.js";
import { observeSessionStdout } from "./session-protocol.js";
import type { EngineSessionAdapterOptions } from "./session-types.js";

const OUTPUT_TRUNCATION = "[redacted-oversize]\n";
const RETAINED_STDOUT_BYTES = TRACE_LIMITS.maxTextBytes - Buffer.byteLength(OUTPUT_TRUNCATION);

/** Bounded internal state for public output retention and raw protocol observation. */
export class SessionStdoutState {
  readonly #retained = Buffer.alloc(RETAINED_STDOUT_BYTES);
  readonly #publicBuffers = { stdout: "", stderr: "" };
  readonly #discardingOversize = { stdout: false, stderr: false };
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
    stream: "stdout" | "stderr",
    content: string,
    flush: boolean,
    nativeSessionId: string | undefined,
    privateValues: readonly string[],
  ): {
    frames: string[];
    observation?: { acknowledged: boolean; nativeSessionId?: string };
  } {
    const buffered = this.#publicBuffers[stream] + content;
    const observation =
      stream === "stdout"
        ? this.#observe(buffered, content, flush, this.#discardingOversize.stdout)
        : undefined;
    const projected = projectPublicEngineFrames(
      buffered,
      nativeSessionId ?? observation?.nativeSessionId,
      flush,
      privateValues,
      this.#discardingOversize[stream],
    );
    this.#publicBuffers[stream] = projected.remainder;
    this.#discardingOversize[stream] = projected.discardingOversize;
    if (stream === "stdout") {
      for (const frame of projected.frames) this.#retainPublicFrame(frame);
    }
    return { frames: projected.frames, ...(observation ? { observation } : {}) };
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
    buffered: string,
    content: string,
    flush: boolean,
    discardingOversize: boolean,
  ): { acknowledged: boolean; nativeSessionId?: string } {
    const incremental =
      this.#protocol === "bridge" || this.#engine === "copilot" || this.#engine === "antigravity";
    let input = incremental ? content : buffered;
    if (!incremental && discardingOversize) {
      const discardedThrough = input.indexOf("\n");
      if (discardedThrough < 0) return { acknowledged: false };
      input = input.slice(discardedThrough + 1);
    }
    const end = incremental || flush ? input.length : input.lastIndexOf("\n") + 1;
    return end > 0
      ? observeSessionStdout(this.#protocol, this.#engine, input.slice(0, end))
      : { acknowledged: false };
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

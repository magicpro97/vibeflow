import { parseAgentTurnOutput } from "../debate.js";

export class DirectOutputStreamV1 {
  private readonly buffered: string[] = [];
  private mode: "undecided" | "structured-candidate" | "plain" = "undecided";

  constructor(private readonly emitPlain: (content: string) => void) {}

  push(content: string): void {
    if (!content) return;
    if (this.mode === "plain") {
      this.emitPlain(content);
      return;
    }
    this.buffered.push(content);
    const prefix = this.buffered.join("").trimStart();
    if (!prefix) return;
    if (prefix.startsWith("{") || prefix.startsWith("`")) {
      this.mode = "structured-candidate";
      return;
    }
    this.mode = "plain";
    for (const chunk of this.buffered.splice(0)) this.emitPlain(chunk);
  }

  finish(output: string): ReturnType<typeof parseAgentTurnOutput> {
    const parsed = parseAgentTurnOutput(output);
    if (parsed.structured) {
      if (this.mode === "plain")
        throw new Error("structured output contradicted streamed plain output");
      this.buffered.length = 0;
      if (parsed.answer) this.emitPlain(parsed.answer);
      return parsed;
    }
    const authoritativeOutputReplacedBuffer =
      this.mode === "structured-candidate" &&
      this.buffered.length > 0 &&
      this.buffered.join("") !== output;
    if (authoritativeOutputReplacedBuffer) {
      this.buffered.length = 0;
      if (output) this.emitPlain(output);
      this.mode = "plain";
      return parsed;
    }
    if (this.mode !== "plain") {
      if (this.buffered.length) for (const chunk of this.buffered.splice(0)) this.emitPlain(chunk);
      else if (output) this.emitPlain(output);
      this.mode = "plain";
    }
    return parsed;
  }
}

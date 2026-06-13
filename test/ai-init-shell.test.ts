import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiGenerate } from "../src/adapters.js";

describe("aiGenerate argv form (B3 fix)", () => {
  // The fix: VIBEFLOW_AI is tokenized and passed argv-form to spawnSync.
  // No shell is invoked, so metacharacters in VIBEFLOW_AI or in the prompt
  // are literal data, not commands.

  test("VIBEFLOW_AI='cat' + prompt reads prompt back from stdin", () => {
    // `cat` with no file args reads stdin and writes to stdout. With
    // argv form, VIBEFLOW_AI='cat' runs /bin/cat with the prompt piped
    // via stdin. cat writes its stdin back, so we get the prompt back.
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "cat";
    try {
      const out = aiGenerate("hello-world", () => "FALLBACK");
      expect(out).toBe("hello-world");
    } finally {
      if (prev === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prev;
    }
  });

  test("VIBEFLOW_AI='cat' + prompt with shell metachar does NOT execute the metachar", () => {
    // A prompt like "$(rm -rf /)" piped to argv-form cat just echoes it
    // back as literal text. If a shell were involved, the command
    // substitution would run. We assert the literal text comes back.
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "cat";
    try {
      const out = aiGenerate("$(rm -rf /)", () => "FALLBACK");
      expect(out).toBe("$(rm -rf /)");
    } finally {
      if (prev === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prev;
    }
  });

  test("VIBEFLOW_AI with shell metachar does NOT break out (cmd treated as literal name)", () => {
    // If VIBEFLOW_AI='echo; touch /tmp/pwn-ai' and a shell were involved,
    // the touch would run. With argv form, the whole string is tokenized
    // and `echo;` is treated as the exec name (which doesn't exist), so
    // the spawn fails and we fall back.
    const marker = `/tmp/pwn-ai-${process.pid}-${Date.now()}`;
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = `echo; touch ${marker}; echo safe`;
    try {
      const out = aiGenerate("hello", () => "FALLBACK");
      // The marker must NOT have been created — that would prove a shell
      // parsed the `;` and ran `touch <marker>` as its own command.
      expect(existsSync(marker)).toBe(false);
      // And we fall back because the literal-name exec doesn't exist.
      expect(out).toBe("FALLBACK");
    } finally {
      if (prev === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prev;
    }
  });

  test("VIBEFLOW_AI tokenizes into argv: 'my-llm --model x' runs 'my-llm' with ['--model','x']", () => {
    // Multi-token VIBEFLOW_AI must split. Use a script that prints its argv
    // so we can observe the args actually passed. `cat` is the simplest:
    // it echoes its argv... no wait, `cat` echoes stdin. Use `printf %s`
    // joined — but printf is a single binary with no shell. Better: use
    // `sh -c 'echo "$@"' --` — but that needs a shell. Simplest: write
    // a small node script inline.
    const dir = mkdtempSync(join(tmpdir(), "vf-ai-"));
    const script = join(dir, "print-args");
    writeFileSync(
      script,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nlet input = "";\nprocess.stdin.on("data", (c) => input += c);\nprocess.stdin.on("end", () => {\n  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));\n});\n`,
    );
    chmodSync(script, 0o755);
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = `${script} --model gpt-x`;
    try {
      const out = aiGenerate("hello-prompt", () => "FALLBACK");
      const parsed = JSON.parse(out);
      expect(parsed.args).toEqual(["--model", "gpt-x"]);
      expect(parsed.input).toBe("hello-prompt");
    } finally {
      if (prev === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VIBEFLOW_AI unset → fallback", () => {
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = undefined;
    try {
      const out = aiGenerate("hello", () => "FALLBACK");
      expect(out).toBe("FALLBACK");
    } finally {
      if (prev !== undefined) process.env.VIBEFLOW_AI = prev;
    }
  });
});

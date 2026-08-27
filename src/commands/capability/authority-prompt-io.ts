import { readSync } from "node:fs";

const MAX_AUTHORITY_PROMPT_BYTES = 4_096;

export interface AuthorityPromptIoV1 {
  write(message: string): void;
  readLine(): string | null;
}

function terminalLine(): string | null {
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  while (bytes.length < MAX_AUTHORITY_PROMPT_BYTES) {
    const count = readSync(process.stdin.fd, byte, 0, 1, null);
    if (count === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString("utf8");
    const value = byte[0];
    if (value === 0x0a) break;
    if (value !== 0x0d && value !== undefined) bytes.push(value);
  }
  return Buffer.from(bytes).toString("utf8");
}

export const DEFAULT_AUTHORITY_PROMPT_IO = Object.freeze({
  write: (message: string) => {
    process.stderr.write(message);
  },
  readLine: terminalLine,
}) satisfies AuthorityPromptIoV1;

export function exactAuthorityConfirmation(
  io: AuthorityPromptIoV1,
  message: string,
  expected: string,
): boolean {
  io.write(`${message}\nType ${expected} to continue: `);
  return io.readLine() === expected;
}

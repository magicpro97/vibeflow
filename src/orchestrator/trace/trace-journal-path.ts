import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export function traceJournalPath(dir: string, id: string): string {
  return join(
    resolve(dir),
    "conversations",
    `${createHash("sha256").update("v1-trace-conversation\0").update(id).digest("hex")}.jsonl`,
  );
}

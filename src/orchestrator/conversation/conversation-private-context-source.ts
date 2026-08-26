import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 1_024 * 1_024;

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function portable(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function sameIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Stable no-follow read used only by the server-owned private broker. */
export function readConversationPrivateFileRange(input: {
  repoRoot: string;
  repoRelativePath: string;
  startLine: number;
  endLine: number;
}): { content: string; start_line: number; end_line: number } {
  const root = realpathSync(resolve(input.repoRoot));
  const target = resolve(root, input.repoRelativePath);
  const realBefore = realpathSync(target);
  if (!inside(root, realBefore) || portable(root, realBefore) !== input.repoRelativePath)
    throw new Error("private context source escapes repository");
  const fd = openSync(
    target,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (constants.O_NONBLOCK === undefined ? 0 : constants.O_NONBLOCK),
  );
  try {
    const opened = fstatSync(fd);
    const entry = lstatSync(target);
    if (
      !opened.isFile() ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !sameIdentity(opened, entry)
    )
      throw new Error("private context source is not a stable regular file");
    if (opened.size > MAX_FILE_BYTES) throw new Error("private context source is oversized");
    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_FILE_BYTES) throw new Error("private context source is oversized");
    const after = fstatSync(fd);
    const afterEntry = lstatSync(target);
    if (
      !sameIdentity(opened, after) ||
      !sameIdentity(after, afterEntry) ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      after.size !== size ||
      realpathSync(target) !== realBefore
    )
      throw new Error("private context source changed while reading");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    if (text.includes("\0")) throw new Error("private context source is not text");
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\r") {
        if (text[index + 1] === "\n") index += 1;
        starts.push(index + 1);
      } else if (text[index] === "\n") starts.push(index + 1);
    }
    if (input.startLine > starts.length) throw new Error("private context range is outside file");
    const endLine = Math.min(input.endLine, starts.length);
    const endOffset = endLine < starts.length ? (starts[endLine] as number) : text.length;
    const content = text.slice(starts[input.startLine - 1] as number, endOffset);
    if (Buffer.byteLength(content, "utf8") < 1 || Buffer.byteLength(content, "utf8") > 65_536)
      throw new Error("private context range is empty or oversized");
    return { content, start_line: input.startLine, end_line: endLine };
  } finally {
    closeSync(fd);
  }
}

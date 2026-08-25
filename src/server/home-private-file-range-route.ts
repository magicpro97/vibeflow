import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { readBoundedUtf8Body } from "./bounded-request-body.js";

const BODY_LIMIT = 8 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RANGE_LINES = 200;

type FileReadFailure = "binary" | "changed" | "forbidden" | "not_found" | "too_large";

class PinnedFileReadError extends Error {
  constructor(readonly reason: FileReadFailure) {
    super(reason);
  }
}

function outside(root: string, target: string): boolean {
  return target !== root && !target.startsWith(`${root}${sep}`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function readPinnedRepoFile(root: string, repoRelativePath: string): string {
  const target = resolve(root, repoRelativePath);
  let realBefore: string;
  try {
    realBefore = realpathSync(target);
  } catch {
    throw new PinnedFileReadError("not_found");
  }
  if (outside(root, realBefore) || portableRelative(root, realBefore) !== repoRelativePath)
    throw new PinnedFileReadError("forbidden");

  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (constants.O_NONBLOCK === undefined ? 0 : constants.O_NONBLOCK),
    );
  } catch {
    throw new PinnedFileReadError("not_found");
  }
  try {
    const openedBefore = fstatSync(fd);
    const entryBefore = lstatSync(target);
    if (
      !openedBefore.isFile() ||
      !entryBefore.isFile() ||
      entryBefore.isSymbolicLink() ||
      !sameFile(openedBefore, entryBefore)
    )
      throw new PinnedFileReadError("forbidden");
    if (openedBefore.size > MAX_FILE_BYTES) throw new PinnedFileReadError("too_large");

    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let byteLength = 0;
    while (byteLength < bytes.length) {
      const count = readSync(fd, bytes, byteLength, bytes.length - byteLength, null);
      if (count === 0) break;
      byteLength += count;
    }
    if (byteLength > MAX_FILE_BYTES) throw new PinnedFileReadError("too_large");

    const openedAfter = fstatSync(fd);
    const entryAfter = lstatSync(target);
    let realAfter: string;
    try {
      realAfter = realpathSync(target);
    } catch {
      throw new PinnedFileReadError("changed");
    }
    if (
      !stableFile(openedBefore, openedAfter) ||
      openedAfter.size !== byteLength ||
      !entryAfter.isFile() ||
      entryAfter.isSymbolicLink() ||
      !sameFile(openedAfter, entryAfter) ||
      realAfter !== realBefore
    )
      throw new PinnedFileReadError("changed");

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, byteLength));
    } catch {
      throw new PinnedFileReadError("binary");
    }
    if (content.includes("\0")) throw new PinnedFileReadError("binary");
    return content;
  } finally {
    closeSync(fd);
  }
}

function sliceTextByLines(content: string, startLine: number, endLine: number) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") index += 1;
      starts.push(index + 1);
      continue;
    }
    if (content[index] === "\n") starts.push(index + 1);
  }
  const totalLines = starts.length;
  if (startLine > totalLines) throw new Error("range starts after the file ends");
  const actualEndLine = Math.min(endLine, totalLines);
  const endOffset = actualEndLine < totalLines ? starts[actualEndLine] : content.length;
  return {
    content: content.slice(starts[startLine - 1] ?? 0, endOffset),
    startLine,
    endLine: actualEndLine,
  };
}

export async function handleHomePrivateFileRangeRoute(
  authority: {
    stage(input: {
      handoff_id: string;
      repo_relative_path: string;
      start_line: number;
      end_line: number;
      content: string;
      staged_at: string;
    }): unknown;
    createId(): string;
  },
  repo: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST")
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedUtf8Body(request, BODY_LIMIT));
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (!exactKeys(input, ["path", "start_line", "end_line"]))
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const path = input.path;
  const startLine = input.start_line;
  const endLine = input.end_line;
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    typeof startLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(endLine) ||
    endLine < startLine ||
    endLine - startLine + 1 > MAX_RANGE_LINES
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const rootLex = resolve(repo);
  const target = resolve(rootLex, path);
  if (
    path.startsWith("~") ||
    path.includes("\\") ||
    hasControlCharacter(path) ||
    outside(rootLex, target) ||
    portableRelative(rootLex, target) !== path
  )
    return Response.json({ error: "forbidden" }, { status: 403 });
  let root: string;
  let content: string;
  try {
    root = realpathSync(rootLex);
    content = readPinnedRepoFile(root, path);
  } catch (error) {
    if (!(error instanceof PinnedFileReadError))
      return Response.json({ error: "invalid_request" }, { status: 422 });
    const status =
      error.reason === "forbidden"
        ? 403
        : error.reason === "not_found"
          ? 404
          : error.reason === "too_large"
            ? 413
            : 422;
    return Response.json({ error: error.reason }, { status });
  }
  try {
    const excerpt = sliceTextByLines(content, startLine, endLine);
    const binding = authority.stage({
      handoff_id: authority.createId(),
      repo_relative_path: path,
      start_line: excerpt.startLine,
      end_line: excerpt.endLine,
      content: excerpt.content,
      staged_at: new Date().toISOString(),
    });
    return Response.json(binding, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error: (error as Error).message.includes("after the file ends")
          ? "invalid_range"
          : "invalid_request",
      },
      { status: 422 },
    );
  }
}

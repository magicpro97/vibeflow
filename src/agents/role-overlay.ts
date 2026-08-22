import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import { assertNoSymlinkPathComponents } from "../orchestrator/trace/path-safety.js";
import { isRoleRef, parseAgentRoleStrict } from "./role-loader.js";
import { type RoleContext, getRoleSpec } from "./role-templates.js";
import type { ResolvedRole, RoleModel, RoleSandbox, RoleSpec, ToolIntent } from "./role.js";

const MAX_ROLE_BYTES = 256 * 1024;
const ROLE_FIELDS = new Set(["name", "description", "tools", "model", "sandbox", "extends"]);
const TOOL_INTENTS = new Set<ToolIntent>(["read", "write", "edit", "bash", "grep", "glob", "web"]);
const MODELS = new Set<RoleModel>([
  "haiku",
  "sonnet",
  "opus",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.4-codex",
]);
const SANDBOXES = new Set<RoleSandbox>(["read-only", "workspace-write", "danger-full-access"]);

export interface ResolveRoleOverlayOptions {
  repoRoot: string;
  context?: RoleContext;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

function pathError(message: string): never {
  throw new Error(message);
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type BigIntStats = ReturnType<typeof fstatSync> & {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function stableSnapshot(fd: number): BigIntStats {
  return fstatSync(fd, { bigint: true }) as BigIntStats;
}

function stableEntry(path: string): BigIntStats {
  return lstatSync(path, { bigint: true }) as BigIntStats;
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameEntry(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function readBounded(fd: number): string {
  const data = Buffer.alloc(MAX_ROLE_BYTES + 1);
  let offset = 0;
  while (offset < data.length) {
    const count = readSync(fd, data, offset, data.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_ROLE_BYTES) throw new Error("file exceeds 256 KiB");
  return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset));
}

function exactRepoRole(roleRef: string, repoRoot: string): { path: string; text: string } | null {
  const requestedRepo = resolve(repoRoot);
  assertNoSymlinkPathComponents(requestedRepo, pathError);
  const canonicalRepo = realpathSync(requestedRepo);
  const rolesDir = join(canonicalRepo, ".vibeflow", "roles");
  const path = join(rolesDir, `${roleRef}.md`);
  const metadataPath = join(requestedRepo, ".vibeflow", "roles", `${roleRef}.md`);
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    assertNoSymlinkPathComponents(path, pathError);
    directoryFd = openSync(
      rolesDir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const directoryBefore = stableSnapshot(directoryFd);
    const directoryEntry = stableEntry(rolesDir);
    if (
      !directoryBefore.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      !directoryEntry.isDirectory() ||
      !sameEntry(directoryBefore, directoryEntry)
    ) {
      throw new Error("unsafe role directory");
    }
    const canonicalRoot = realpathSync(rolesDir);
    if (!isInside(canonicalRepo, canonicalRoot)) throw new Error("role root escapes repository");
    fileFd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const fileBefore = stableSnapshot(fileFd);
    const fileEntry = stableEntry(path);
    if (
      !fileBefore.isFile() ||
      fileEntry.isSymbolicLink() ||
      !fileEntry.isFile() ||
      fileBefore.nlink !== 1n ||
      fileEntry.nlink !== 1n ||
      !sameEntry(fileBefore, fileEntry)
    ) {
      throw new Error("not a regular file");
    }
    if (fileBefore.size > BigInt(MAX_ROLE_BYTES)) throw new Error("file exceeds 256 KiB");
    const text = readBounded(fileFd);
    const fileAfter = stableSnapshot(fileFd);
    const finalFileEntry = stableEntry(path);
    const directoryAfter = stableSnapshot(directoryFd);
    const finalDirectoryEntry = stableEntry(rolesDir);
    if (
      !unchanged(fileBefore, fileAfter) ||
      fileAfter.nlink !== 1n ||
      finalFileEntry.nlink !== 1n ||
      !sameEntry(fileAfter, finalFileEntry) ||
      !unchanged(directoryBefore, directoryAfter) ||
      !sameEntry(directoryAfter, finalDirectoryEntry)
    ) {
      throw new Error("role path changed during read");
    }
    assertNoSymlinkPathComponents(path, pathError);
    return { path: metadataPath, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : "unreadable file";
    throw new Error(`malformed repo role "${roleRef}": ${reason}`);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

function assertKnownFields(data: Record<string, unknown>, ref: string): void {
  const unknown = Object.keys(data).filter((key) => !ROLE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`malformed repo role "${ref}": unknown field ${unknown.join(", ")}`);
  }
}

function parseTools(value: unknown, ref: string): ToolIntent[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => TOOL_INTENTS.has(v as ToolIntent))
  ) {
    throw new Error(`malformed repo role "${ref}": invalid tools`);
  }
  return [...new Set(value as ToolIntent[])];
}

function hashRole(spec: RoleSpec): string {
  return createHash("sha256")
    .update("vf-role-v1\0")
    .update(
      JSON.stringify({
        name: spec.name,
        description: spec.description,
        body: spec.body,
        tools: spec.tools,
        model: spec.model,
        sandbox: spec.sandbox ?? null,
      }),
    )
    .digest("hex");
}

function resolved(
  spec: RoleSpec,
  source: ResolvedRole["source"],
  metadata: Record<string, string>,
): ResolvedRole {
  return { spec, source, resolved_hash: hashRole(spec), metadata };
}

function resolveNode(
  roleRef: string,
  options: ResolveRoleOverlayOptions,
  resolving: Set<string>,
): ResolvedRole {
  if (resolving.has(roleRef)) {
    throw new Error(`role overlay cycle: ${[...resolving, roleRef].join(" -> ")}`);
  }
  resolving.add(roleRef);
  try {
    const repoRole = exactRepoRole(roleRef, options.repoRoot);
    if (!repoRole) {
      const builtin = getRoleSpec(roleRef, options.context);
      if (!builtin) throw new Error(`unknown role: ${roleRef}`);
      return resolved(builtin, "builtin", { role: roleRef });
    }

    const { data, body } = parseFrontmatter(repoRole.text);
    assertKnownFields(data, roleRef);
    if (data.name !== roleRef || !isRoleRef(roleRef)) {
      throw new Error(`malformed repo role "${roleRef}": name must match exact file ref`);
    }

    const tools = parseTools(data.tools, roleRef);
    const description = data.description;
    if (description !== undefined && (typeof description !== "string" || !description.trim())) {
      throw new Error(`malformed repo role "${roleRef}": invalid description`);
    }
    const model = data.model;
    if (model !== undefined && (typeof model !== "string" || !MODELS.has(model as RoleModel))) {
      throw new Error(`malformed repo role "${roleRef}": invalid model`);
    }
    const sandbox = data.sandbox;
    if (
      sandbox !== undefined &&
      (typeof sandbox !== "string" || !SANDBOXES.has(sandbox as RoleSandbox))
    ) {
      throw new Error(`malformed repo role "${roleRef}": invalid sandbox`);
    }

    if (data.extends === undefined) {
      const spec = parseAgentRoleStrict(repoRole.text);
      if (!spec.body.trim()) {
        throw new Error(`malformed repo role "${roleRef}": prompt body is required`);
      }
      return resolved(spec, "repo", { path: repoRole.path });
    }

    if (typeof data.extends !== "string" || !isRoleRef(data.extends)) {
      throw new Error(`malformed repo role "${roleRef}": invalid extends`);
    }
    const base = resolveNode(data.extends, options, resolving);
    const overlayBody = body.trim();
    const spec: RoleSpec = {
      ...base.spec,
      name: roleRef,
      ...(typeof description === "string" ? { description } : {}),
      ...(tools ? { tools } : {}),
      ...(typeof model === "string" ? { model: model as RoleModel } : {}),
      ...(typeof sandbox === "string" ? { sandbox: sandbox as RoleSandbox } : {}),
      body: overlayBody ? `${base.spec.body.trimEnd()}\n\n${overlayBody}\n` : base.spec.body,
    };
    return resolved(spec, "repo", { path: repoRole.path, base: data.extends });
  } catch (error) {
    if (
      error instanceof Error &&
      /^(unknown role|role overlay cycle|malformed repo role)/.test(error.message)
    ) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : "invalid role";
    throw new Error(`malformed repo role "${roleRef}": ${reason}`);
  } finally {
    resolving.delete(roleRef);
  }
}

/** Resolve one strict repo shadow/overlay, falling back only when no exact file exists. */
export function resolveRoleOverlay(
  roleRef: string,
  options: ResolveRoleOverlayOptions,
): ResolvedRole {
  if (!isRoleRef(roleRef)) throw new Error(`unknown role: ${roleRef}`);
  return resolveNode(roleRef, options, new Set());
}

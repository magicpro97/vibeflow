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
import { AGENT_ROLE_SOURCE } from "../core/agent-contract.js";
import {
  ROLE_FRONTMATTER_FIELD,
  type ToolIntent,
  isRoleFrontmatterField,
  isRoleModel,
  isRoleSandbox,
  isRoleToolIntent,
} from "../core/role-contract.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { parseFrontmatter } from "../frontmatter.js";
import { assertNoSymlinkPathComponents } from "../orchestrator/trace/path-safety.js";
import { isRoleRef, parseAgentRoleStrict } from "./role-loader.js";
import { type RoleContext, getRoleSpec } from "./role-templates.js";
import type { ResolvedRole, RoleSpec } from "./role.js";

const MAX_ROLE_BYTES = 256 * 1024;

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
      !rel.startsWith(`..${process.platform === RUNTIME_PLATFORM.WINDOWS ? "\\" : "/"}`))
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

/** Pure snapshot validation seam that preserves the directory TOCTOU checks. */
export function assertRoleDirectorySnapshot(before: BigIntStats, entry: BigIntStats): void {
  if (
    !before.isDirectory() ||
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    !sameEntry(before, entry)
  ) {
    throw new Error("unsafe role directory");
  }
}

/** Pure snapshot validation seam that preserves every post-read TOCTOU check. */
export function assertStableRoleReadSnapshot(input: {
  fileBefore: BigIntStats;
  fileAfter: BigIntStats;
  finalFileEntry: BigIntStats;
  directoryBefore: BigIntStats;
  directoryAfter: BigIntStats;
  finalDirectoryEntry: BigIntStats;
}): void {
  if (
    !unchanged(input.fileBefore, input.fileAfter) ||
    input.fileAfter.nlink !== 1n ||
    input.finalFileEntry.nlink !== 1n ||
    !sameEntry(input.fileAfter, input.finalFileEntry) ||
    !unchanged(input.directoryBefore, input.directoryAfter) ||
    !sameEntry(input.directoryAfter, input.finalDirectoryEntry)
  ) {
    throw new Error("role path changed during read");
  }
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
    assertRoleDirectorySnapshot(directoryBefore, directoryEntry);
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
    assertStableRoleReadSnapshot({
      fileBefore,
      fileAfter,
      finalFileEntry,
      directoryBefore,
      directoryAfter,
      finalDirectoryEntry,
    });
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
  const unknown = Object.keys(data).filter((key) => !isRoleFrontmatterField(key));
  if (unknown.length > 0) {
    throw new Error(`malformed repo role "${ref}": unknown field ${unknown.join(", ")}`);
  }
}

function parseTools(value: unknown, ref: string): ToolIntent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRoleToolIntent)) {
    throw new Error(`malformed repo role "${ref}": invalid tools`);
  }
  return value.filter((tool, index, tools) => tools.indexOf(tool) === index);
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
      return resolved(builtin, AGENT_ROLE_SOURCE.BUILTIN, { role: roleRef });
    }

    const { data, body } = parseFrontmatter(repoRole.text);
    assertKnownFields(data, roleRef);
    if (data[ROLE_FRONTMATTER_FIELD.NAME] !== roleRef || !isRoleRef(roleRef)) {
      throw new Error(`malformed repo role "${roleRef}": name must match exact file ref`);
    }

    const tools = parseTools(data[ROLE_FRONTMATTER_FIELD.TOOLS], roleRef);
    const description = data[ROLE_FRONTMATTER_FIELD.DESCRIPTION];
    if (description !== undefined && (typeof description !== "string" || !description.trim())) {
      throw new Error(`malformed repo role "${roleRef}": invalid description`);
    }
    const model = data[ROLE_FRONTMATTER_FIELD.MODEL];
    if (model !== undefined && !isRoleModel(model)) {
      throw new Error(`malformed repo role "${roleRef}": invalid model`);
    }
    const sandbox = data[ROLE_FRONTMATTER_FIELD.SANDBOX];
    if (sandbox !== undefined && !isRoleSandbox(sandbox)) {
      throw new Error(`malformed repo role "${roleRef}": invalid sandbox`);
    }

    const extendsRole = data[ROLE_FRONTMATTER_FIELD.EXTENDS];
    if (extendsRole === undefined) {
      const spec = parseAgentRoleStrict(repoRole.text);
      if (!spec.body.trim()) {
        throw new Error(`malformed repo role "${roleRef}": prompt body is required`);
      }
      return resolved(spec, AGENT_ROLE_SOURCE.REPO, { path: repoRole.path });
    }

    if (typeof extendsRole !== "string" || !isRoleRef(extendsRole)) {
      throw new Error(`malformed repo role "${roleRef}": invalid extends`);
    }
    const base = resolveNode(extendsRole, options, resolving);
    const overlayBody = body.trim();
    const spec: RoleSpec = {
      ...base.spec,
      name: roleRef,
      ...(typeof description === "string" ? { description } : {}),
      ...(tools ? { tools } : {}),
      ...(isRoleModel(model) ? { model } : {}),
      ...(isRoleSandbox(sandbox) ? { sandbox } : {}),
      body: overlayBody ? `${base.spec.body.trimEnd()}\n\n${overlayBody}\n` : base.spec.body,
    };
    return resolved(spec, AGENT_ROLE_SOURCE.REPO, {
      path: repoRole.path,
      base: extendsRole,
    });
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

import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Skill } from "../core.js";
import { SKILL_SOURCE, SKILL_STATUS } from "../core/skill-contract.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { parseFrontmatter } from "../frontmatter.js";
import { assertNoSymlinkPathComponents } from "../orchestrator/trace/path-safety.js";
import { mergeBodies, parseSkillReference, resolveAllAdapters } from "./adapter.js";
import {
  type SkillDiscoveryRoots,
  type SkillSource,
  classifySkillSource,
  discoverSkills,
  skillDiscoveryRoots,
} from "./discovery.js";
import { parseRegistryLock } from "./registry-channel.js";
import {
  type DispatchSkillSelection,
  MAX_SKILL_FILE_BYTES,
  parseSkillText,
  readSkillFileSnapshot,
  selectDispatchSkills,
} from "./registry.js";
import { type ParseSkillOpts, trustedIdentityForSharedSkill } from "./review-proof.js";

interface CanonicalSkillNode {
  skill: Skill;
  source: SkillSource;
  body: string;
  text: string;
  pathKey: string;
}

interface CanonicalSkillGraph {
  roots: SkillDiscoveryRoots;
  nodes: CanonicalSkillNode[];
  byName: Map<string, CanonicalSkillNode>;
  byPath: Map<string, CanonicalSkillNode>;
}

export interface ResolvedSkill {
  ref: string;
  source: SkillSource;
  version: string | null;
  resolved_hash: string;
}

/** Internal materialization also retains the exact effective body used for injection. */
export interface MaterializedResolvedSkill extends ResolvedSkill {
  resolved_body: string;
  dependency_hashes: string[];
}

export interface SkillResolutionOptions {
  repoRoot: string;
  sharedRoot?: string;
  roots?: SkillDiscoveryRoots;
}

export interface DispatchSkillResolution extends DispatchSkillSelection {
  selection: DispatchSkillSelection;
  skills: MaterializedResolvedSkill[];
}

export interface DispatchSkillResolutionOptions extends SkillResolutionOptions {
  additionalSkillRefs?: readonly string[];
}

function rootsFor(options: SkillResolutionOptions): SkillDiscoveryRoots {
  return options.roots ?? skillDiscoveryRoots(options.repoRoot, options.sharedRoot);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === RUNTIME_PLATFORM.WINDOWS ? "\\" : "/"}`))
  );
}

function exactDiscoveryRoot(path: string, source: SkillSource, roots: SkillDiscoveryRoots): string {
  for (const candidate of roots[source]) {
    const root = resolve(candidate);
    const rel = relative(root, path);
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (inside(root, path) && parts.length === 2 && parts[1] === "SKILL.md") return root;
  }
  throw new Error(`skill path is not a canonical discovery entry: ${path}`);
}

function sharedHome(root: string): string | undefined {
  const catalog = dirname(root);
  return basename(root) === "skills" && basename(catalog) === ".vibeflow"
    ? dirname(catalog)
    : undefined;
}

function parseOptions(
  source: SkillSource,
  root: string,
  dir: string,
  registries: ReturnType<typeof parseRegistryLock>["registries"],
): ParseSkillOpts {
  if (source !== SKILL_SOURCE.SHARED) return { provenance: "local" };
  const identity = trustedIdentityForSharedSkill(basename(dir), registries, dir);
  const home = sharedHome(root);
  return {
    provenance: "discovered",
    ...(identity ? { trustedReviewIdentity: identity } : {}),
    ...(home ? { homedir: () => home } : {}),
  };
}

function pathError(message: string): never {
  throw new Error(message);
}

function canonicalNode(
  candidate: Skill,
  roots: SkillDiscoveryRoots,
  registries: ReturnType<typeof parseRegistryLock>["registries"],
): CanonicalSkillNode {
  if (typeof candidate.path !== "string" || !candidate.path) {
    throw new Error("cannot materialize skill: invalid discovery path");
  }
  const path = resolve(candidate.path);
  try {
    const source = classifySkillSource(path, roots);
    const root = exactDiscoveryRoot(path, source, roots);
    assertNoSymlinkPathComponents(path, pathError);
    const text = readSkillFileSnapshot(path);
    assertNoSymlinkPathComponents(path, pathError);
    const dir = dirname(path);
    const parsed = parseSkillText(text, path, dir, parseOptions(source, root, dir, registries));
    if (!parsed) throw new Error("invalid SKILL.md metadata");
    return { skill: parsed, source, body: parseFrontmatter(text).body, text, pathKey: path };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreadable skill";
    throw new Error(`cannot materialize skill at "${path}": ${reason}`);
  }
}

function canonicalGraph(
  allSkills: readonly Skill[],
  options: SkillResolutionOptions,
  rootSkill?: Skill,
): CanonicalSkillGraph {
  const roots = rootsFor(options);
  const registries = parseRegistryLock(options.repoRoot).registries;
  const candidates = new Map<string, Skill>();
  for (const candidate of [...allSkills, ...(rootSkill ? [rootSkill] : [])]) {
    if (typeof candidate.path !== "string" || !candidate.path) {
      throw new Error("cannot materialize skill: invalid discovery path");
    }
    candidates.set(resolve(candidate.path), candidate);
  }
  const rawNodes = [...candidates.values()].map((candidate) =>
    canonicalNode(candidate, roots, registries),
  );
  const snapshots = new Map(rawNodes.map((node) => [node.pathKey, node.text]));
  const resolved = resolveAllAdapters(
    rawNodes.map((node) => node.skill),
    {
      existsSync: (path) => snapshots.has(resolve(path)),
      readFileSync: (path) => {
        const text = snapshots.get(resolve(path));
        if (text === undefined) throw new Error("skill snapshot unavailable");
        return text;
      },
    },
  ).skills;
  const rawByPath = new Map(rawNodes.map((node) => [node.pathKey, node]));
  const nodes = resolved.map((skill) => {
    const raw = rawByPath.get(resolve(skill.path));
    if (!raw) throw new Error(`skill snapshot unavailable: ${skill.path}`);
    return { ...raw, skill };
  });
  const byName = new Map<string, CanonicalSkillNode>();
  const byPath = new Map<string, CanonicalSkillNode>();
  for (const node of nodes) {
    const key = node.skill.name.toLowerCase();
    if (byName.has(key)) throw new Error(`duplicate skill identity: ${node.skill.name}`);
    byName.set(key, node);
    byPath.set(node.pathKey, node);
  }
  return { roots, nodes, byName, byPath };
}

function findSkill(ref: string, index: Map<string, CanonicalSkillNode>): CanonicalSkillNode {
  const parsed = parseSkillReference(ref);
  if (!parsed) throw new Error(`invalid skill ref: ${ref}`);
  const node = index.get(parsed.baseName.toLowerCase());
  if (!node) throw new Error(`skill "${parsed.baseName}" is not installed`);
  if (parsed.version && node.skill.version !== parsed.version) {
    throw new Error(
      `skill "${parsed.baseName}" requires version ${parsed.version}, installed ${node.skill.version ?? "none"}`,
    );
  }
  if (node.skill.status === SKILL_STATUS.DEPRECATED)
    throw new Error(`skill "${node.skill.name}" is deprecated`);
  return node;
}

function effectiveBody(node: CanonicalSkillNode, orderedBaseBodies: readonly string[]): string {
  const ownBody = node.body;
  let resolvedBody: string | undefined;
  for (const baseBody of orderedBaseBodies) {
    resolvedBody =
      baseBody && ownBody ? mergeBodies(baseBody, ownBody) : ownBody ? ownBody : baseBody;
  }
  const body = resolvedBody ?? ownBody;
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw new Error(`cannot materialize skill "${node.skill.name}": effective body exceeds 1 MiB`);
  }
  return body;
}

function hashSkill(
  body: string,
  dependencies: readonly { kind: string; ref: string; hash: string }[],
): string {
  const hash = createHash("sha256");
  hash.update("vf-skill-v1\0");
  hash.update(`body:${Buffer.byteLength(body, "utf8")}\0`);
  hash.update(body);
  for (const dependency of dependencies) {
    hash.update(`\0${dependency.kind}:${dependency.ref}:${dependency.hash}`);
  }
  return hash.digest("hex");
}

function materializeNode(
  current: CanonicalSkillNode,
  graph: CanonicalSkillGraph,
  memo: Map<string, MaterializedResolvedSkill>,
  resolving: string[],
): MaterializedResolvedSkill {
  const key = current.skill.name.toLowerCase();
  const cached = memo.get(key);
  if (cached) return cached;
  const cycleAt = resolving.indexOf(key);
  if (cycleAt >= 0) {
    throw new Error(`skill dependency cycle: ${[...resolving.slice(cycleAt), key].join(" -> ")}`);
  }
  resolving.push(key);
  try {
    const dependencyRefs = [
      ...(current.skill.extends ?? []).map((ref) => ({ kind: "base", ref })),
      ...(current.skill.dependsOn ?? []).map((ref) => ({ kind: "dependency", ref })),
    ];
    const dependencies = dependencyRefs.map(({ kind, ref }) => {
      const materialized = materializeNode(findSkill(ref, graph.byName), graph, memo, resolving);
      return { kind, ref, materialized };
    });
    const body = effectiveBody(
      current,
      dependencies
        .filter((dependency) => dependency.kind === "base")
        .map((dependency) => dependency.materialized.resolved_body),
    );
    const dependencyHashes = dependencies.map(({ kind, ref, materialized }) => ({
      kind,
      ref,
      hash: materialized.resolved_hash,
    }));
    const result: MaterializedResolvedSkill = {
      ref: current.skill.name,
      source: current.source,
      version: current.skill.version ?? null,
      resolved_hash: hashSkill(body, dependencyHashes),
      resolved_body: body,
      dependency_hashes: dependencyHashes.map((dependency) => dependency.hash),
    };
    memo.set(key, result);
    return result;
  } finally {
    resolving.pop();
  }
}

/** Materialize one skill and recursively bind the ordered base/dependency graph. */
export function materializeResolvedSkill(
  skill: Skill,
  allSkills: readonly Skill[],
  options: SkillResolutionOptions,
): MaterializedResolvedSkill {
  const graph = canonicalGraph(allSkills, options, skill);
  const root = graph.byPath.get(resolve(skill.path));
  if (!root) throw new Error(`skill snapshot unavailable: ${skill.path}`);
  findSkill(root.skill.name, graph.byName);
  return materializeNode(root, graph, new Map(), []);
}

/** Existing workflow selection plus deterministic bodies/provenance for conversation dispatch. */
export function materializeDispatchSkills(
  allSkills: readonly Skill[],
  unitText: string,
  options: DispatchSkillResolutionOptions,
): DispatchSkillResolution {
  const graph = canonicalGraph(allSkills, options);
  const selection = selectDispatchSkills(
    graph.nodes.map((node) => node.skill),
    unitText,
  );
  const names = [...selection.skillNames];
  for (const ref of options.additionalSkillRefs ?? []) {
    const node = findSkill(ref, graph.byName);
    if (!names.includes(node.skill.name)) names.push(node.skill.name);
  }
  const memo = new Map<string, MaterializedResolvedSkill>();
  const skills = names.map((name) =>
    materializeNode(findSkill(name, graph.byName), graph, memo, []),
  );
  return { ...selection, selection, skills };
}

export const resolveDispatchSkills = materializeDispatchSkills;

/** Canonical binding entry point: callers provide refs/text, never Skill object authority. */
export function materializeDiscoveredDispatchSkills(
  unitText: string,
  options: Pick<DispatchSkillResolutionOptions, "repoRoot" | "additionalSkillRefs">,
): DispatchSkillResolution {
  const allSkills = discoverSkills(options.repoRoot);
  return materializeDispatchSkills(allSkills, unitText, options);
}

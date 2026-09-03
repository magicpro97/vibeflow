import type { CapabilityManifestDependencyScope } from "../../actions/capability-manifest-vocabulary-contract.js";
import { CAPABILITY_PACKAGE_PIN_TRUST } from "../../actions/capability-security-contract.js";
import { CapabilityValidationError, bytewise, packageId } from "../wire/primitives.js";
import { validateImmutablePackagePin } from "./pins.js";
import {
  type ResolutionCandidateV1,
  assertValidatedResolutionCandidate,
} from "./resolution-records.js";
export type {
  ResolutionCandidateV1,
  ResolutionCompatibilityContextV1,
  ValidatedResolutionCompatibilityV1,
} from "./resolution-records.js";
import { compareSemver, validateVersionRange, versionSatisfiesRange } from "./semver.js";
import type { PackagePinV1 } from "./types.js";

export interface ResolutionRequestV1 {
  package_id: string;
  version_range: string;
  source_identity?: string;
  content_sha256?: string;
}

export interface ResolutionResultV1 {
  packages: ResolutionCandidateV1[];
  pins: PackagePinV1[];
  dependency_bindings: Array<{
    from_package_id: string;
    required_scope: CapabilityManifestDependencyScope;
    package_id: string;
    version: string;
    content_sha256: string;
  }>;
  visited_partial_states: number;
}

export class DependencyResolutionError extends CapabilityValidationError {
  readonly resolution_code:
    | "ambiguous_source"
    | "source_unavailable"
    | "registry_corrupt"
    | "dependency_cycle"
    | "dependency_conflict"
    | "dependency_resolution_too_complex";

  constructor(resolutionCode: DependencyResolutionError["resolution_code"], message: string) {
    super(message, "resolution");
    this.name = "DependencyResolutionError";
    this.resolution_code = resolutionCode;
  }
}

function canonicalSourceFor(
  candidates: readonly ResolutionCandidateV1[],
  requests: readonly ResolutionRequestV1[],
  allowedTrust: ReadonlySet<PackagePinV1["trust"]>,
  id: string,
): string {
  const allForId = candidates.filter((candidate) => candidate.pin.id === id);
  const eligible = allForId.filter((candidate) => allowedTrust.has(candidate.pin.trust));
  if (eligible.length === 0)
    throw new DependencyResolutionError(
      "source_unavailable",
      allForId.length === 0
        ? `no source provides required package ${id}`
        : `no explicitly trusted source remains for ${id}`,
    );
  const sources = [...new Set(eligible.map((candidate) => candidate.source_identity))].sort(
    bytewise,
  );
  const requested = [
    ...new Set(
      requests
        .filter((request) => request.package_id === id && request.source_identity !== undefined)
        .map((request) => request.source_identity as string),
    ),
  ].sort(bytewise);
  if (requested.length > 1)
    throw new DependencyResolutionError(
      "ambiguous_source",
      `root requests select conflicting sources for ${id}`,
    );
  const explicit = requested[0];
  if (explicit !== undefined) {
    if (!sources.includes(explicit))
      throw new DependencyResolutionError(
        "source_unavailable",
        `selected source is unavailable for ${id}`,
      );
    return explicit;
  }
  if (sources.length !== 1)
    throw new DependencyResolutionError(
      "ambiguous_source",
      `multiple canonical sources remain for ${id}`,
    );
  return sources[0] as string;
}

function assertNoDuplicateVersionContent(candidates: readonly ResolutionCandidateV1[]): void {
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const key = `${candidate.pin.id}\0${candidate.pin.version}\0${candidate.source_identity}`;
    const prior = seen.get(key);
    if (prior !== undefined && prior !== candidate.pin.content_sha256)
      throw new DependencyResolutionError(
        "registry_corrupt",
        `duplicate ${candidate.pin.id}@${candidate.pin.version} has different content`,
      );
    seen.set(key, candidate.pin.content_sha256);
  }
}

function conflict(left: ResolutionCandidateV1, right: ResolutionCandidateV1): boolean {
  const conflicts = (owner: ResolutionCandidateV1, other: ResolutionCandidateV1) =>
    owner.conflicts.some(
      (item) =>
        item.package_id === other.pin.id &&
        (item.version_range === null ||
          versionSatisfiesRange(other.pin.version, item.version_range)),
    );
  return conflicts(left, right) || conflicts(right, left);
}

function stateKey(
  selected: ReadonlyMap<string, ResolutionCandidateV1>,
  constraints: ReadonlyMap<string, readonly string[]>,
): string {
  return [...new Set([...selected.keys(), ...constraints.keys()])]
    .sort(bytewise)
    .map(
      (id) =>
        `${id}:${selected.get(id)?.pin.pin_digest ?? "?"}:${[...(constraints.get(id) ?? [])].sort(bytewise).join(",")}`,
    )
    .join("|");
}

function hasDependencyCycle(selected: ReadonlyMap<string, ResolutionCandidateV1>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const candidate = selected.get(id);
    if (candidate) {
      for (const dependency of candidate.dependencies) {
        if (selected.has(dependency.package_id) && visit(dependency.package_id)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of [...selected.keys()].sort(bytewise)) if (visit(id)) return true;
  return false;
}

export function resolveDependencies(options: {
  requests: readonly ResolutionRequestV1[];
  candidates: readonly ResolutionCandidateV1[];
  locked_pins?: readonly PackagePinV1[];
  allowed_trust?: readonly PackagePinV1["trust"][];
  max_partial_states?: number;
}): ResolutionResultV1 {
  if (options.requests.length === 0)
    throw new DependencyResolutionError(
      "source_unavailable",
      "resolution requires at least one root request",
    );
  for (const request of options.requests) {
    packageId(request.package_id, "request.package_id");
    validateVersionRange(request.version_range);
  }
  for (const candidate of options.candidates) {
    assertValidatedResolutionCandidate(candidate);
    validateImmutablePackagePin(candidate.pin);
  }
  assertNoDuplicateVersionContent(options.candidates);
  const allowedTrust = new Set<PackagePinV1["trust"]>(
    options.allowed_trust ?? [
      CAPABILITY_PACKAGE_PIN_TRUST.VERIFIED,
      CAPABILITY_PACKAGE_PIN_TRUST.SOURCE_PINNED,
      CAPABILITY_PACKAGE_PIN_TRUST.LEGACY_VERIFIED,
    ],
  );
  const locked = new Map((options.locked_pins ?? []).map((pin) => [pin.id, pin]));
  const constraints = new Map<string, string[]>();
  for (const request of options.requests) {
    const rows = constraints.get(request.package_id) ?? [];
    rows.push(request.version_range);
    constraints.set(request.package_id, rows);
  }
  const maxStates = options.max_partial_states ?? 50_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 50_000)
    throw new DependencyResolutionError(
      "dependency_resolution_too_complex",
      "invalid resolution complexity bound",
    );
  const memo = new Set<string>();
  let states = 0;
  let cycleObserved = false;

  const solve = (
    selected: Map<string, ResolutionCandidateV1>,
    ranges: Map<string, string[]>,
  ): Map<string, ResolutionCandidateV1> | null => {
    const key = stateKey(selected, ranges);
    if (memo.has(key)) return null;
    if (states >= maxStates)
      throw new DependencyResolutionError(
        "dependency_resolution_too_complex",
        "dependency resolution exceeded the partial-state bound",
      );
    memo.add(key);
    states += 1;
    const unresolved = [...ranges.keys()].filter((id) => !selected.has(id)).sort(bytewise);
    if (unresolved.length === 0) return selected;
    const id = unresolved[0] as string;
    const requiredRanges = ranges.get(id) ?? [];
    const source = canonicalSourceFor(options.candidates, options.requests, allowedTrust, id);
    const contentConstraints = options.requests
      .filter((request) => request.package_id === id && request.content_sha256 !== undefined)
      .map((request) => request.content_sha256 as string);
    const choices = options.candidates.filter(
      (candidate) =>
        candidate.pin.id === id &&
        candidate.source_identity === source &&
        allowedTrust.has(candidate.pin.trust) &&
        requiredRanges.every((range) => versionSatisfiesRange(candidate.pin.version, range)) &&
        contentConstraints.every((content) => candidate.pin.content_sha256 === content),
    );
    choices.sort((left, right) => {
      const lockedPin = locked.get(id);
      const leftLocked = lockedPin?.pin_digest === left.pin.pin_digest ? 1 : 0;
      const rightLocked = lockedPin?.pin_digest === right.pin.pin_digest ? 1 : 0;
      return (
        rightLocked - leftLocked ||
        -compareSemver(left.pin.version, right.pin.version) ||
        -bytewise(left.pin.version, right.pin.version) ||
        bytewise(left.pin.pin_digest, right.pin.pin_digest)
      );
    });
    for (const choice of choices) {
      if ([...selected.values()].some((other) => conflict(choice, other))) continue;
      const nextSelected = new Map(selected).set(id, choice);
      const nextRanges = new Map([...ranges].map(([name, values]) => [name, [...values]]));
      let invalid = false;
      for (const dependency of choice.dependencies) {
        validateVersionRange(dependency.version_range);
        const rows = nextRanges.get(dependency.package_id) ?? [];
        rows.push(dependency.version_range);
        nextRanges.set(dependency.package_id, rows);
        const already = nextSelected.get(dependency.package_id);
        if (already && !rows.every((range) => versionSatisfiesRange(already.pin.version, range))) {
          invalid = true;
          break;
        }
      }
      if (invalid) continue;
      if (hasDependencyCycle(nextSelected)) {
        cycleObserved = true;
        continue;
      }
      const result = solve(nextSelected, nextRanges);
      if (result) return result;
    }
    return null;
  };

  const selected = solve(new Map(), constraints);
  if (!selected)
    throw new DependencyResolutionError(
      cycleObserved ? "dependency_cycle" : "dependency_conflict",
      cycleObserved
        ? "no complete dependency vector exists without a dependency cycle"
        : "no complete dependency vector satisfies all ranges/conflicts",
    );
  const packages = [...selected.values()].sort((a, b) => bytewise(a.pin.id, b.pin.id));
  const dependency_bindings = packages
    .flatMap((owner) =>
      owner.dependencies.map((dependency) => {
        const resolved = selected.get(dependency.package_id);
        if (!resolved)
          throw new DependencyResolutionError(
            "dependency_conflict",
            `dependency ${dependency.package_id} was not selected`,
          );
        return {
          from_package_id: owner.pin.id,
          required_scope: dependency.required_scope,
          package_id: resolved.pin.id,
          version: resolved.pin.version,
          content_sha256: resolved.pin.content_sha256,
        };
      }),
    )
    .sort((a, b) =>
      bytewise(
        `${a.from_package_id}\0${a.required_scope}\0${a.package_id}`,
        `${b.from_package_id}\0${b.required_scope}\0${b.package_id}`,
      ),
    );
  return {
    packages,
    pins: packages.map((candidate) => candidate.pin),
    dependency_bindings,
    visited_partial_states: states,
  };
}

import { CapabilityValidationError } from "../wire/primitives.js";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemverV1 {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(value: string): ParsedSemverV1 {
  const match = SEMVER.exec(value);
  if (!match) throw new CapabilityValidationError("version is not exact SemVer 2.0", "version");
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
    throw new CapabilityValidationError(
      "numeric prerelease identifiers have leading zeros",
      "version",
    );
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger))
    throw new CapabilityValidationError("version numeric component exceeds safe bounds", "version");
  return {
    raw: value,
    major: major as number,
    minor: minor as number,
    patch: patch as number,
    prerelease,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0)
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return Number(a) - Number(b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    return Buffer.from(a).compare(Buffer.from(b));
  }
  return 0;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

export function validateVersionRange(value: string): string {
  if (value === "*") return value;
  if (SEMVER.test(value)) {
    parseSemver(value);
    return value;
  }
  if (value.startsWith("^") || value.startsWith("~")) {
    parseSemver(value.slice(1));
    return value;
  }
  const comparators = value.split(" ");
  if (comparators.length !== 2)
    throw new CapabilityValidationError(
      "version range is outside the version-1 grammar",
      "version_range",
    );
  for (const comparator of comparators) {
    const match = /^(<=|>=|<|>|=)(.+)$/.exec(comparator);
    if (!match) throw new CapabilityValidationError("invalid version comparator", "version_range");
    parseSemver(match[2] as string);
  }
  return value;
}

function prereleaseAdmitted(version: ParsedSemverV1, comparators: string[]): boolean {
  if (version.prerelease.length === 0) return true;
  const core = `${version.major}.${version.minor}.${version.patch}-${version.prerelease.join(".")}`;
  return comparators.some((candidate) => candidate.split("+")[0] === core);
}

export function versionSatisfiesRange(versionText: string, range: string): boolean {
  const version = parseSemver(versionText);
  validateVersionRange(range);
  if (range === "*") return version.prerelease.length === 0;
  if (SEMVER.test(range)) return versionText === range;
  if (range.startsWith("^") || range.startsWith("~")) {
    const baseText = range.slice(1);
    const base = parseSemver(baseText);
    if (!prereleaseAdmitted(version, [baseText]) || compareSemver(versionText, baseText) < 0)
      return false;
    const upper = range.startsWith("~")
      ? `${base.major}.${base.minor + 1}.0`
      : base.major > 0
        ? `${base.major + 1}.0.0`
        : base.minor > 0
          ? `0.${base.minor + 1}.0`
          : `0.0.${base.patch + 1}`;
    return compareSemver(versionText, upper) < 0;
  }
  const comparators = range.split(" ");
  if (
    !prereleaseAdmitted(
      version,
      comparators.map((value) => value.replace(/^(?:<=|>=|<|>|=)/, "")),
    )
  )
    return false;
  return comparators.every((comparator) => {
    const match = /^(<=|>=|<|>|=)(.+)$/.exec(comparator) as RegExpExecArray;
    const observed = compareSemver(versionText, match[2] as string);
    return match[1] === "<"
      ? observed < 0
      : match[1] === "<="
        ? observed <= 0
        : match[1] === ">"
          ? observed > 0
          : match[1] === ">="
            ? observed >= 0
            : observed === 0;
  });
}

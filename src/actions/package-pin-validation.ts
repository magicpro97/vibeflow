import { digestV1 } from "../durability/index.js";
import {
  LEGACY_SOURCE_PACKAGE_ID_PREFIX,
  type LegacySource,
  isLegacySource,
} from "./capability-manifest-vocabulary-contract.js";
import type { PackagePinV1 } from "./preview-types.js";
import {
  ACTION_PACKAGE_PIN_SOURCE_KIND,
  ACTION_PACKAGE_PIN_TRUST_VALUE,
} from "./public-action-contract.js";
import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertRawSha256,
} from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";

export function validatePackagePin(pin: PackagePinV1, path: string): void {
  exactObject(
    pin,
    ["id", "version", "source", "content_sha256", "trust", "nonportable", "pin_digest"],
    [],
    path,
  );
  assertPackageId(pin.id, `${path}.id`);
  const version = assertOpaqueId(pin.version, `${path}.version`, 128);
  if (!isCanonicalSemver(version))
    invalid("package version is not canonical semver", `${path}.version`);
  assertRawSha256(pin.content_sha256, `${path}.content_sha256`);
  assertDigest(pin.pin_digest, `${path}.pin_digest`);
  const source = exactObject(
    pin.source,
    ["kind"],
    [
      "registry_origin",
      "source_url",
      "commit_oid",
      "signature_envelope_digest",
      "canonical_url",
      "repo_relative_alias",
      "legacy_source",
      "inspection_evidence_digest",
    ],
    `${path}.source`,
  );
  switch (source.kind) {
    case ACTION_PACKAGE_PIN_SOURCE_KIND.REGISTRY:
      exactObject(
        pin.source,
        ["kind", "registry_origin", "source_url", "commit_oid", "signature_envelope_digest"],
        [],
        `${path}.source`,
      );
      assertRegistryOrigin(source.registry_origin, `${path}.source.registry_origin`);
      assertCanonicalSourceUrl(source.source_url, `${path}.source.source_url`);
      if (source.commit_oid !== null)
        assertCommitOid(source.commit_oid, `${path}.source.commit_oid`);
      assertDigest(source.signature_envelope_digest, `${path}.source.signature_envelope_digest`);
      assertMatrix(pin, ACTION_PACKAGE_PIN_TRUST_VALUE.VERIFIED, false, path);
      break;
    case ACTION_PACKAGE_PIN_SOURCE_KIND.GIT:
      exactObject(pin.source, ["kind", "canonical_url", "commit_oid"], [], `${path}.source`);
      assertCanonicalSourceUrl(source.canonical_url, `${path}.source.canonical_url`);
      assertCommitOid(source.commit_oid, `${path}.source.commit_oid`);
      assertMatrix(pin, ACTION_PACKAGE_PIN_TRUST_VALUE.SOURCE_PINNED, false, path);
      break;
    case ACTION_PACKAGE_PIN_SOURCE_KIND.LOCAL_DEV:
      exactObject(pin.source, ["kind", "repo_relative_alias"], [], `${path}.source`);
      assertRepoRelativeAlias(source.repo_relative_alias, `${path}.source.repo_relative_alias`);
      assertMatrix(pin, ACTION_PACKAGE_PIN_TRUST_VALUE.DEV_UNVERIFIED, true, path);
      break;
    case ACTION_PACKAGE_PIN_SOURCE_KIND.LEGACY_ADOPT:
      exactObject(
        pin.source,
        ["kind", "legacy_source", "inspection_evidence_digest"],
        [],
        `${path}.source`,
      );
      if (!isLegacySource(source.legacy_source))
        invalid("invalid legacy source", `${path}.source.legacy_source`);
      assertDigest(source.inspection_evidence_digest, `${path}.source.inspection_evidence_digest`);
      assertLegacyIdentity(pin, source.legacy_source, path);
      assertMatrix(pin, ACTION_PACKAGE_PIN_TRUST_VALUE.LEGACY_VERIFIED, false, path);
      break;
    default:
      invalid("invalid package source kind", `${path}.source.kind`);
  }
  const { pin_digest: observed, ...preimage } = pin;
  if (observed !== digestV1("VF-PACKAGE-PIN\0v1\0", preimage))
    invalid("package pin digest mismatch", `${path}.pin_digest`);
}

export function isCanonicalSemver(value: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return false;
  const prerelease = match[4];
  return (
    prerelease === undefined ||
    prerelease
      .split(".")
      .every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"))
  );
}

export function isCanonicalVersionRange(value: string): boolean {
  if (value === "*") return true;
  if (isCanonicalSemver(value)) return true;
  if (/^[~^]/.test(value)) return isCanonicalSemver(value.slice(1));
  const comparators = value.split(" ");
  return (
    comparators.length === 2 &&
    comparators.every(
      (item) =>
        /^(?:<=|>=|<|>|=)/.test(item) && isCanonicalSemver(item.replace(/^(?:<=|>=|<|>|=)/, "")),
    )
  );
}

export function versionSatisfiesRange(version: string, range: string): boolean {
  if (!isCanonicalSemver(version) || !isCanonicalVersionRange(range)) return false;
  if (range === "*") return !version.includes("-");
  if (isCanonicalSemver(range)) return version === range;
  if (range.startsWith("^") || range.startsWith("~")) {
    const base = range.slice(1);
    if (!prereleaseAdmitted(version, [base]) || compareSemver(version, base) < 0) return false;
    const [major, minor, patch] = numericVersion(base);
    const upper = range.startsWith("~")
      ? `${major}.${minor + 1}.0`
      : major > 0
        ? `${major + 1}.0.0`
        : minor > 0
          ? `0.${minor + 1}.0`
          : `0.0.${patch + 1}`;
    return compareSemver(version, upper) < 0;
  }
  const comparators = range.split(" ");
  if (
    !prereleaseAdmitted(
      version,
      comparators.map((item) => item.replace(/^(?:<=|>=|<|>|=)/, "")),
    )
  )
    return false;
  return comparators.every((item) => {
    const match = /^(<=|>=|<|>|=)(.+)$/.exec(item);
    if (!match) return false;
    const comparison = compareSemver(version, match[2] as string);
    return match[1] === "<"
      ? comparison < 0
      : match[1] === "<="
        ? comparison <= 0
        : match[1] === ">"
          ? comparison > 0
          : match[1] === ">="
            ? comparison >= 0
            : comparison === 0;
  });
}

function numericVersion(value: string): [number, number, number] {
  const [major, minor, patch] = value.split(/[.+-]/, 3).map(Number);
  return [major as number, minor as number, patch as number];
}

function prereleaseAdmitted(version: string, comparatorVersions: string[]): boolean {
  const prerelease = version.split("+")[0]?.split("-")[1];
  if (!prerelease) return true;
  return comparatorVersions.some((candidate) => candidate.split("+")[0] === version.split("+")[0]);
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const core = value.split("+")[0] as string;
    const [numbers, prerelease] = core.split("-", 2);
    return { numbers: (numbers as string).split(".").map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] as number) - (b.numbers[index] as number);
    if (difference) return difference;
  }
  if (a.prerelease === undefined || b.prerelease === undefined)
    return a.prerelease === b.prerelease ? 0 : a.prerelease === undefined ? 1 : -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const leftPart = aParts[index];
    const rightPart = bParts[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return Buffer.from(leftPart).compare(Buffer.from(rightPart));
  }
  return 0;
}

function assertLegacyIdentity(pin: PackagePinV1, source: LegacySource, path: string): void {
  if (
    !pin.id.startsWith(LEGACY_SOURCE_PACKAGE_ID_PREFIX[source]) ||
    !/^0\.0\.0-legacy\.[a-f0-9]{12}$/.test(pin.version)
  )
    invalid("legacy package identity does not match its managed source", path);
}

function assertMatrix(
  pin: PackagePinV1,
  trust: PackagePinV1["trust"],
  nonportable: boolean,
  path: string,
): void {
  if (pin.trust !== trust || pin.nonportable !== nonportable)
    invalid("package source/trust/portability matrix mismatch", path);
}

function assertRegistryOrigin(value: unknown, path: string): void {
  const text = assertOpaqueId(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    invalid("invalid registry origin", path);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    text !== `https://${parsed.host}` ||
    parsed.hostname !== parsed.hostname.toLowerCase()
  )
    invalid("registry origin is not canonical", path);
}

function assertCanonicalSourceUrl(value: unknown, path: string): void {
  const text = assertOpaqueId(value, path, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    invalid("invalid package source URL", path);
  }
  if (
    !["https:", "ssh:", "git:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.hostname !== parsed.hostname.toLowerCase() ||
    parsed.href !== text
  )
    invalid("package source URL is not canonical or credential-free", path);
}

function assertCommitOid(value: unknown, path: string): void {
  const text = assertOpaqueId(value, path, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text))
    invalid("Git commit OID is not a full immutable OID", path);
}

function assertRepoRelativeAlias(value: unknown, path: string): void {
  const text = assertOpaqueId(value, path, 1_024);
  const segments = text.split("/");
  if (
    text !== text.normalize("NFC") ||
    text.startsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    text.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    invalid("local source alias is not normalized repo-relative", path);
}

function invalid(message: string, path: string): never {
  throw new ActionValidationError(message, path);
}

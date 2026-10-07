/** Dependency-neutral version-string formats shared by CLI and browser-side
 *  consumers. NO imports: this module rides into the SPA bundle. */

/** Accept only a plain dotted-numeric version, optionally with a
 *  prerelease/build suffix (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build`). This is the
 *  trust gate on the version string BEFORE it is cached or printed: the npm
 *  registry response (and the on-disk cache) are untrusted, and the string is
 *  rendered straight to the terminal — a value carrying ANSI/control chars
 *  would inject terminal escapes. `cmpSemver` already coerces to numbers so
 *  comparison is safe; this closes the DISPLAY vector. */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+([-+][\w.]+)*$/.test(v);
}

interface FullVersion {
  readonly nums: readonly [number, number, number];
  /** Prerelease identifiers string, or null for a release. */
  readonly pre: string | null;
}

const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parseFullVersion(v: string): FullVersion | null {
  const m = FULL_VERSION.exec(v);
  if (m === null) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4],
  };
}

/** SemVer §11 identifier-list compare: numeric < alphanumeric, numeric compared
 *  numerically, alphanumeric lexically (ASCII), fewer fields lower when prefix-equal. */
function comparePrerelease(a: string, b: string): number {
  const xa = a.split(".");
  const xb = b.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    const ia = xa[i];
    const ib = xb[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    // §11: a NUMERIC identifier must not carry a leading zero; `01` is not a
    // number here — it falls to the alphanumeric (ASCII) branch.
    const na = /^(?:0|[1-9]\d*)$/u.test(ia);
    const nb = /^(?:0|[1-9]\d*)$/u.test(ib);
    if (na && nb) {
      const d = Number(ia) - Number(ib);
      if (d !== 0) return d > 0 ? 1 : -1;
      continue;
    }
    if (na !== nb) return na ? -1 : 1;
    if (ia !== ib) return ia > ib ? 1 : -1;
  }
  return 0;
}

/** Full SemVer 2.0.0 precedence compare: -1 | 0 | 1, prerelease-aware.
 *  `1.0.0-rc.1` < `1.0.0-rc.2` < `1.0.0`; build metadata (`+…`) is ignored.
 *  Malformed/partial strings fall back to the numeric-triple coercion that
 *  `cmpSemver` uses (segments coerce via parseInt; missing = 0). */
export function cmpVersionPrecedence(a: string, b: string): number {
  const pa = parseFullVersion(a);
  const pb = parseFullVersion(b);
  if (pa === null || pb === null) {
    const parse = (v: string): number[] =>
      (v.split(/[-+]/u)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    const na = parse(a);
    const nb = parse(b);
    for (let i = 0; i < 3; i += 1) {
      const d = (na[i] ?? 0) - (nb[i] ?? 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  for (const [x, y] of [
    [pa.nums[0], pb.nums[0]],
    [pa.nums[1], pb.nums[1]],
    [pa.nums[2], pb.nums[2]],
  ] as const) {
    const d = x - y;
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // a release outranks its prereleases
  if (pb.pre === null) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

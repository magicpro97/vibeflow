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

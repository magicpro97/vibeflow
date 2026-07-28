import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function skillBundleHash(
  dir: string,
  inject: {
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isFile(): boolean; isDirectory(): boolean };
    readFileSync?: (path: string) => string | Buffer;
  } = {},
): string {
  const _readdir = inject.readdirSync ?? readdirSync;
  const _stat = inject.statSync ?? statSync;
  const _read = inject.readFileSync ?? readFileSync;
  const hash = createHash("sha256");
  const walk = (base: string, prefix: string): void => {
    const entries = _readdir(base).sort();
    for (const e of entries) {
      if (e === ".git") continue;
      const full = join(base, e);
      const st = _stat(full);
      const rel = prefix ? `${prefix}/${e}` : e;
      if (st.isDirectory()) {
        walk(full, rel);
      } else if (st.isFile()) {
        hash.update(`${rel}\0`);
        hash.update(_read(full) as string | Uint8Array);
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

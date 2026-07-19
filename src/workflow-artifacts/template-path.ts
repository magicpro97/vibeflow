import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path under the shipped `templates/` directory, working in BOTH:
 *  - dev / test mode: source files live at `src/workflow-artifacts/` (depth 2),
 *    so `templates/` is `../../templates` from here.
 *  - production: `bun build` flattens everything into a single `dist/cli.js`
 *    (depth 1), so `templates/` (shipped via package.json `files`) is
 *    `../templates` from the bundle.
 *
 * The bundle path and the source path differ by one level, and `import.meta.url`
 * reflects whichever is running. We therefore try the prod-bundle path first
 * (`../templates`), then the dev-source path (`../../templates`), and return the
 * first that exists. Returns the resolved filesystem path, or null if neither
 * exists.
 *
 * Regression context (#285 → #292): the #285 split moved these files from
 * `src/` (depth 1) to `src/workflow-artifacts/` (depth 2) and changed the path
 * to `../../templates` so the src-mode tests passed — but the production bundle
 * is always `dist/cli.js` (depth 1), so `../../templates` resolved OUTSIDE the
 * package and every phase silently fell back to a stub. Trying both depths fixes
 * both modes.
 *
 * NOTE (Bun 1.3.14 Windows regression): `url.pathname` on Windows returns
 * `/F:/Code/vibeflow/...` (leading `/`), which `existsSync` can't resolve.
 * `fileURLToPath` normalises to `F:\Code\vibeflow\...` — works everywhere.
 */
export function resolveTemplatePath(relative: string): string | null {
  for (const prefix of ["../templates", "../../templates"]) {
    const url = new URL(`${prefix}/${relative}`, import.meta.url);
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  return null;
}

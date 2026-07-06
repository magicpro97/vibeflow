// E2E advisory gates (non-blocking playwright-selector lint warnings).
// Extracted from gates.ts to stay under the 400-line file-size cap (#515).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const E2E_GLOB = /^e2e\/.*\.(spec|e2e)\.ts$/;
const TEXT_SELECTOR_RE =
  /"(text=[^"]*[-￿][^"]*)"|hasText:\s*"([^"]*[-￿][^"]*)"|hasText:\s*\/([^/]*[-￿][^/]*)\//g;

function findE2eFiles(base: string): string[] {
  const out: string[] = [];
  const e2eDir = join(base, "e2e");
  if (!existsSync(e2eDir)) return out;
  try {
    for (const entry of readdirSync(e2eDir)) {
      const rel = `e2e/${entry}`;
      if (E2E_GLOB.test(rel)) out.push(rel);
    }
  } catch {
    /* no e2e directory */
  }
  return out;
}

/** Scan e2e specs for Unicode text selectors — fragile to normalization mismatches. */
export function e2eUnicodeSelectorWarning(base: string): string[] {
  const warnings: string[] = [];
  for (const rel of findE2eFiles(base)) {
    const abs = join(base, rel);
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      TEXT_SELECTOR_RE.lastIndex = 0;
      for (let m = TEXT_SELECTOR_RE.exec(line); m !== null; m = TEXT_SELECTOR_RE.exec(line)) {
        const text = m[1] || m[2] || m[3] || "";
        warnings.push(`e2e:${rel}:${i + 1} Unicode text selector "${text}" — prefer data-testid`);
      }
    }
  }
  return warnings;
}

/** Scan e2e specs for dynamic import() inside page.evaluate() — fails in bundled builds. */
export function e2eEvaluateDynamicImportWarning(base: string): string[] {
  const warnings: string[] = [];
  for (const rel of findE2eFiles(base)) {
    const abs = join(base, rel);
    let src = "";
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      /* file unreadable — treat as empty */
    }
    const lines = src.split("\n");
    let inEvaluate = false;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!inEvaluate) {
        const idx = line.indexOf(".evaluate(");
        if (idx === -1) continue;
        const rest = line.slice(idx + ".evaluate(".length).trim();
        if (/\bimport\s*\(/.test(rest)) {
          warnings.push(
            `e2e:${rel}:${i + 1} dynamic import() inside page.evaluate() — fails in bundled builds`,
          );
          continue;
        }
        if (rest.startsWith("(") || rest.startsWith("{") || rest === "") {
          // Multi-line .evaluate() call: the inline import() check
          // above already ran on this line. We don't re-check on
          // subsequent lines (the original multi-line tracker never
          // re-checked either; it only counted parens to find the
          // end of the call). Mark this evaluate call as consumed.
          inEvaluate = true;
          depth = 0;
          for (const ch of rest) {
            if (ch === "(" || ch === "{") depth++;
            else if (ch === ")" || ch === "}") depth--;
          }
        }
      }
    }
  }
  return warnings;
}

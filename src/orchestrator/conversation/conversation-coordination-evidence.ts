import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const EVIDENCE_REFERENCE = /^([^#\\]+?)(?:#L[1-9]\d*(?:-L[1-9]\d*)?)?$/;

/** Validates that model-authored repo evidence resolves to an existing in-repo regular file. */
export function validateConversationCoordinationRepoEvidence(
  repoRoot: string,
  references: readonly string[],
): boolean {
  if (references.length === 0) return false;
  let root: string;
  try {
    root = realpathSync(resolve(repoRoot));
  } catch {
    return false;
  }
  return references.every((reference) => {
    if (Array.from(reference).some((character) => character.charCodeAt(0) < 32)) return false;
    const matched = EVIDENCE_REFERENCE.exec(reference);
    const path = matched?.[1];
    if (!path || isAbsolute(path) || path === "." || path.split("/").includes("..")) return false;
    try {
      const target = realpathSync(resolve(root, path));
      const fromRoot = relative(root, target);
      return (
        fromRoot !== "" &&
        !fromRoot.startsWith("..") &&
        !isAbsolute(fromRoot) &&
        lstatSync(target).isFile()
      );
    } catch {
      return false;
    }
  });
}

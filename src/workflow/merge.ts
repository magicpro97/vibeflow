import { isManagedGenerated } from "./lifecycle.js";

/**
 * Root engine instruction files VibeFlow generates that can COLLIDE with files a human wrote
 * (unlike everything under `.viteflow/`, which is VibeFlow's own namespace). `vf init` used to
 * truncate these unconditionally — the data-loss bug. They must be merged, never clobbered.
 */
export const ENGINE_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
];

/** Markers fencing the VibeFlow-managed region inside an engine instruction file. Content OUTSIDE
 * this fence is the human's and is preserved verbatim across every re-init. */
export const VF_BLOCK_START = "<!-- vibeflow:start -->";
export const VF_BLOCK_END = "<!-- vibeflow:end -->";

/** How a managed engine file was reconciled on re-init — surfaced so the caller can report it. */
export type MergeMode = "fresh" | "block-update" | "replace-managed" | "preserve-merge";

export interface MergeOutcome {
  content: string;
  mode: MergeMode;
  /** True when existing human content was at risk and should be backed up before writing. */
  backup: boolean;
}

/** Wrap freshly generated content in the managed-region fence (trailing newline normalized). */
function fence(generated: string): string {
  return `${VF_BLOCK_START}\n${generated.trim()}\n${VF_BLOCK_END}\n`;
}

/**
 * Reconcile an existing engine instruction file with freshly generated content, NEVER losing
 * human-authored text. Four cases:
 *  - no existing file              → write the fenced managed block ("fresh").
 *  - existing has the VF fence     → swap ONLY the fenced region, keep everything outside it
 *                                    ("block-update"); idempotent on repeated re-init.
 *  - existing is a legacy fully-VF file (carries a generation marker, no fence) → replace it
 *    wholesale with the fenced block ("replace-managed"); there is no human content to keep.
 *  - existing is hand-edited (no fence, no marker) → keep the human file as-is and append the
 *    fenced block after it ("preserve-merge"); flag backup so the prior version is archived.
 */
export function mergeManagedBlock(existing: string | null, generated: string): MergeOutcome {
  const block = fence(generated);
  if (existing == null) return { content: block, mode: "fresh", backup: false };

  const start = existing.indexOf(VF_BLOCK_START);
  const end = existing.indexOf(VF_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + VF_BLOCK_END.length);
    const merged = `${before}${block.trimEnd()}${after}`;
    return {
      content: merged.endsWith("\n") ? merged : `${merged}\n`,
      mode: "block-update",
      backup: false,
    };
  }

  if (isManagedGenerated(existing)) {
    return { content: block, mode: "replace-managed", backup: false };
  }

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { content: `${base}\n${block}`, mode: "preserve-merge", backup: true };
}

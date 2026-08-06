// #693: CI Curator setup wizard core — the exact `.github/workflows/skill-curator.yml`
// the wizard installs, a deterministic unified-diff renderer, and an opaque
// single-use preview store. Purposely pure (no fs, no Browser globals) so it is
// unit-testable and mirrors the shape of policy-preview.ts.
//
// buildCuratorWorkflow() is the SOURCE OF TRUTH for what the wizard writes. The
// repo's committed .github/workflows/skill-curator.yml must stay byte-identical —
// a drifting copy would bake an empty diff into the preview. The store test asserts
// buildCuratorWorkflow() === that committed file.

import { createHash, randomUUID } from "node:crypto";

/** Exact canonical target the wizard may create/replace (no path traversal possible). */
export const CURATOR_SETUP_TARGET = ".github/workflows/skill-curator.yml";
/** Few-minute TTL so a confirmed preview cannot be applied stale. */
export const CURATOR_SETUP_TTL_MS = 5 * 60 * 1000;
export const CURATOR_SETUP_MAX = 20;
/** Caps preview input before LCS allocation; existing workflow content is untrusted. */
export const CURATOR_SETUP_PREVIEW_MAX_BYTES = 64 * 1024;
/** Exact phrase a user must type to confirm file creation. */
export const CURATOR_SETUP_CONFIRMATION = "CREATE CURATOR WORKFLOW";

/**
 * Deterministic weekly skill-curator GitHub workflow (cross-repo CI template):
 * runs the deterministic curator scan, uploads findings, and posts/updates a
 * single aggregate health issue (deduped by exact title, no label dependency).
 */
export function buildCuratorWorkflow(): string {
  return `name: Skill Curator Weekly Report

# Runs deterministic curator scan weekly, posts aggregate health report as
# a single issue. Re-runs update the same issue (no duplicates).
# Deduplication is by exact title match only — no label dependency.
# Writes one Git notes ref and one aggregate issue; no finding detail leaves the runner.

on:
  schedule:
    - cron: "0 0 * * 1"
  workflow_dispatch:

concurrency:
  group: skill-curator-report
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          clean: true
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: |
          set -euo pipefail
          bun install --frozen-lockfile
      - run: |
          set -euo pipefail
          bun run build

      - name: Run curator scan
        run: |
          set -euo pipefail
          node dist/cli.js skills curator scan --scope=repo --sync --yes || rc=$?
          if [ "\${rc:-0}" -gt 1 ]; then exit "$rc"; fi

      - name: Upload curator findings
        uses: actions/upload-artifact@v4
        with:
          name: curator-findings
          path: .vibeflow/curator/findings.json
          if-no-files-found: error

  report:
    needs: sync
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      issues: write
    steps:
      - name: Download curator findings
        uses: actions/download-artifact@v4
        with:
          name: curator-findings
          path: .vibeflow/curator

      - name: Build issue body
        id: body
        run: |
          set -euo pipefail
          FILE=".vibeflow/curator/findings.json"
          BODY="/tmp/curator-body.md"
          echo "## Weekly Skill Health Report" > "$BODY"
          echo "" >> "$BODY"
          echo "**Scan Date:** $(date -u '+%Y-%m-%d %H:%M UTC')" >> "$BODY"
          echo "" >> "$BODY"

          if [ ! -f "$FILE" ]; then
            TOTAL=0
          else
            TOTAL=$(jq '.findings | length' "$FILE")
          fi

          if [ "$TOTAL" -eq 0 ]; then
            echo "**Status:** No issues found" >> "$BODY"
          else
            echo "**Status:** $TOTAL issue(s) found" >> "$BODY"
            echo "" >> "$BODY"
            echo "### Summary" >> "$BODY"
            echo "" >> "$BODY"
            echo "| Type | Count |" >> "$BODY"
            echo "|------|-------|" >> "$BODY"

            for type in stale-anchor duplicate-owner unpinned-registry; do
              COUNT=$(jq --arg t "$type" '[.findings[] | select(.type == $t)] | length' "$FILE")
              if [ "$COUNT" -gt 0 ]; then
                echo "| $type | $COUNT |" >> "$BODY"
              fi
            done
          fi

      - name: Find existing report issue
        id: find
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          EXISTING=$(gh issue list \\
            --state all \\
            --search 'in:title "[skill-curator] Weekly Skill Health Report"' \\
            --limit 1000 \\
            --json number,title \\
            --jq '[.[] | select(.title == "[skill-curator] Weekly Skill Health Report") | .number][0] // empty' \\
          )
          echo "number=$EXISTING" >> "$GITHUB_OUTPUT"
          if [ -n "$EXISTING" ]; then
            echo "found=true" >> "$GITHUB_OUTPUT"
            echo "Issue #$EXISTING exists - will update."
          else
            echo "found=false" >> "$GITHUB_OUTPUT"
            echo "No existing issue - will create."
          fi

      - name: Create report issue
        if: steps.find.outputs.found == 'false'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          gh issue create \\
            --title "[skill-curator] Weekly Skill Health Report" \\
            --body-file /tmp/curator-body.md

      - name: Update existing report issue
        if: steps.find.outputs.found == 'true'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          gh issue edit "\${{ steps.find.outputs.number }}" \\
            --title "[skill-curator] Weekly Skill Health Report" \\
            --body-file /tmp/curator-body.md \\
            --state open
`;
}

/** Unify line endings so a CRLF on-disk file diffs exactly against the LF source. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

type Op = { type: "eq" | "del" | "add"; line: string };

/**
 * Render a unified diff between two file variants for CURATOR_SETUP_TARGET.
 * `--- a/<target> / +++ b/<target>` when `before` is non-empty, else
 * `--- /dev/null / +++ b/<target>` for a brand-new file. Pure string math (LCS) —
 * no process spawn, no blob hashes. O(n*m) memory over the two files only.
 */
export function unifiedDiff(before: string, after: string): string {
  const lines = (value: string) => {
    const normalized = normalize(value);
    return normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
  };
  const a = lines(before);
  const b = lines(after);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    const next = lcs[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      const line = a[i];
      if (line === undefined) break;
      ops.push({ type: "eq", line });
      i++;
      j++;
    } else if (j < m && (i >= n || (lcs[i + 1]?.[j] ?? 0) <= (lcs[i]?.[j + 1] ?? 0))) {
      const line = b[j];
      if (line === undefined) break;
      ops.push({ type: "add", line });
      j++;
    } else {
      const line = a[i];
      if (line === undefined) break;
      ops.push({ type: "del", line });
      i++;
    }
  }

  // Collapse the op stream into hunks: leading context, change run, trailing context.
  interface Hunk {
    lead: Op[];
    mid: Op[];
    tail: Op[];
  }
  const hunks: Hunk[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx]?.type === "eq") {
      idx++;
      continue;
    }
    const lead: Op[] = [];
    for (let k = idx - 1; k >= 0 && lead.length < 3 && ops[k]?.type === "eq"; k--) {
      const op = ops[k];
      if (op) lead.unshift(op);
    }
    const mid: Op[] = [];
    while (idx < ops.length && ops[idx]?.type !== "eq") {
      const op = ops[idx];
      if (op) mid.push(op);
      idx++;
    }
    const tail: Op[] = [];
    while (idx < ops.length && tail.length < 3 && ops[idx]?.type === "eq") {
      const op = ops[idx];
      if (op) tail.push(op);
      idx++;
    }
    hunks.push({ lead, mid, tail });
  }

  if (hunks.length === 0) return "";

  let out = "";
  if (before.length === 0 || normalize(before).length === 0) {
    out += "--- /dev/null\n";
  } else {
    out += `--- a/${CURATOR_SETUP_TARGET}\n`;
  }
  out += `+++ b/${CURATOR_SETUP_TARGET}\n`;

  for (const hunk of hunks) {
    const lines = [...hunk.lead, ...hunk.mid, ...hunk.tail];
    // old line range: 1-based start of the first involved line, count of old lines.
    let oldStart = 1;
    let oldCount = 0;
    let newStart = 1;
    let newCount = 0;
    // Walk the ORIGINAL op stream to find absolute positions for hunk anchors.
    // Simpler: recompute from the hunk's own lines is ambiguous; instead anchor on
    // the first lead line's index in `a`/`b`. The workflow is small; a best-effort
    // anchor is acceptable for a preview-only renderer.
    if (hunk.lead.length > 0) {
      const anchor = hunk.lead[0]?.line;
      if (anchor === undefined) continue;
      const ai = a.indexOf(anchor);
      const bi = b.indexOf(anchor);
      if (ai >= 0) oldStart = ai + 1;
      if (bi >= 0) newStart = bi + 1;
    }
    for (const l of lines) {
      if (l.type === "del") oldCount++;
      if (l.type === "add") newCount++;
    }
    oldCount += hunk.lead.length;
    newCount += hunk.lead.length;
    const ca = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
    const cb = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
    out += `@@ -${ca} +${cb} @@\n`;
    for (const l of lines) {
      out += l.type === "eq" ? ` ${l.line}\n` : l.type === "del" ? `-${l.line}\n` : `+${l.line}\n`;
    }
  }
  return out;
}

/** sha256 hex of exact file content — the stale-guard fingerprint. */
export function curatorContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface CuratorSetupPreview {
  id: string;
  repo: string;
  target: string;
  current: string;
  content: string;
  currentHash: string;
  createdAt: number;
  consumed: boolean;
}

export class CuratorSetupStore {
  private readonly previews = new Map<string, CuratorSetupPreview>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => string = randomUUID,
  ) {}
  create(repo: string, current: string): CuratorSetupPreview {
    while (this.previews.size >= CURATOR_SETUP_MAX)
      this.previews.delete(this.previews.keys().next().value as string);
    const content = buildCuratorWorkflow();
    const preview: CuratorSetupPreview = {
      id: this.random(),
      repo,
      target: CURATOR_SETUP_TARGET,
      current,
      content,
      currentHash: curatorContentHash(current),
      createdAt: this.now(),
      consumed: false,
    };
    this.previews.set(preview.id, preview);
    return preview;
  }
  consume(
    id: string,
    repo: string,
    current: string,
    confirmationText: string,
  ): CuratorSetupPreview | null {
    const preview = this.previews.get(id);
    if (
      !preview ||
      preview.consumed ||
      preview.repo !== repo ||
      this.now() - preview.createdAt > CURATOR_SETUP_TTL_MS ||
      preview.currentHash !== curatorContentHash(current) ||
      confirmationText !== CURATOR_SETUP_CONFIRMATION
    )
      return null;
    preview.consumed = true;
    return preview;
  }
}

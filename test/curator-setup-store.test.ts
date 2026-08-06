import { describe, expect, test } from "bun:test";
import {
  CURATOR_SETUP_CONFIRMATION,
  CURATOR_SETUP_TARGET,
  CURATOR_SETUP_TTL_MS,
  CuratorSetupStore,
  buildCuratorWorkflow,
  curatorContentHash,
  unifiedDiff,
} from "../src/curator-setup.js";

describe("buildCuratorWorkflow — exact target content #693", () => {
  const content = buildCuratorWorkflow();

  test("is a YAML GitHub workflow named 'Skill Curator Weekly Report'", () => {
    expect(content).toMatch(/^name:\s*Skill Curator Weekly Report/m);
    expect(content).toMatch(/^on:/m);
    expect(content).toMatch(/^jobs:/m);
    expect(content).toMatch(/^concurrency:/m);
  });

  test("scheduled weekly + dispatchable", () => {
    expect(content).toContain('cron: "0 0 * * 1"');
    expect(content).toContain("workflow_dispatch:");
  });

  test("sync + report jobs, least-privilege permissions", () => {
    expect(content).toContain("sync:");
    expect(content).toContain("report:");
    expect(content).toContain("contents: write");
    expect(content).toContain("contents: read");
    expect(content).toContain("issues: write");
    expect(content).toContain("needs: sync");
  });

  test("pinned action versions", () => {
    expect(content).toContain("actions/checkout@v4");
    expect(content).toContain("oven-sh/setup-bun@v2");
    expect(content).toContain("actions/upload-artifact@v4");
    expect(content).toContain("actions/download-artifact@v4");
  });

  test("runs deterministic repo scan, no local-only scope", () => {
    expect(content).toContain("node dist/cli.js skills curator scan --scope=repo --sync --yes");
    expect(content).toContain('if [ "${rc:-0}" -gt 1 ]; then exit "$rc"; fi');
    expect(content).not.toContain("--scope=local");
  });

  test("no private identifiers in the file body", () => {
    expect(content).not.toContain("magicpro97");
  });

  test("matches the current repo file byte-for-byte", async () => {
    const onDisk = await Bun.file(CURATOR_SETUP_TARGET).text();
    expect(content).toBe(onDisk);
  });
});

describe("unifiedDiff — exact unified diff rendering #693", () => {
  test("new file: --- /dev/null +++ b/ header with + lines", () => {
    const d = unifiedDiff("", "line1\nline2\n");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/.github/workflows/skill-curator.yml");
    expect(d).toContain("+line1");
    expect(d).toContain("+line2");
  });

  test("existing file: a/ + b/ headers and +/- lines", () => {
    const d = unifiedDiff("keep\nold\n", "keep\nnew\n");
    expect(d).toContain("--- a/.github/workflows/skill-curator.yml");
    expect(d).toContain("+++ b/.github/workflows/skill-curator.yml");
    expect(d).toContain("-old");
    expect(d).toContain("+new");
    expect(d).toContain(" keep"); // context line rendered with a leading space
  });

  test("trailing-newline handling (no spurious \\ No newline markers)", () => {
    expect(unifiedDiff("", "")).not.toContain("No newline");
    expect(unifiedDiff("x", "x")).not.toContain("No newline");
  });

  test("every non-header line of a new-file diff starts with '+'", () => {
    const lines = unifiedDiff("", buildCuratorWorkflow()).split("\n");
    for (const line of lines.slice(globalHeaderLineCount()).filter(Boolean)) {
      expect(line).toMatch(/^\+|^@@ |^--- |^\+\+\+ /);
    }
  });
});

function globalHeaderLineCount(): number {
  const d = unifiedDiff("", buildCuratorWorkflow());
  return d.split("\n").findIndex((l) => l.startsWith("@@ "));
}

describe("curatorContentHash — stable sha256 #693", () => {
  test("deterministic per content", () => {
    expect(curatorContentHash("abc")).toBe(curatorContentHash("abc"));
    expect(curatorContentHash("abc")).not.toBe(curatorContentHash("abd"));
  });
  test("hashes the EXACT workflow content", () => {
    const h = curatorContentHash(buildCuratorWorkflow());
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("CuratorSetupStore — opaque preview + single-use + TTL + hash guard #693", () => {
  test("create returns opaque id + exact target + current hash", () => {
    const now = 1000;
    const store = new CuratorSetupStore(
      () => now,
      () => "preview-1",
    );
    const p = store.create("repo-a", "");
    expect(p.id).toBe("preview-1");
    expect(p.target).toBe(CURATOR_SETUP_TARGET);
    expect(p.content).toBe(buildCuratorWorkflow());
    expect(p.currentHash).toBe(curatorContentHash(""));
    expect(p.createdAt).toBe(1000);
  });

  test("consume succeeds once with exact confirmation, given unchanged current", () => {
    const now = 1000;
    const store = new CuratorSetupStore(
      () => now,
      () => "id",
    );
    const p = store.create("repo-a", "old");
    expect(store.consume(p.id, "repo-a", "old", CURATOR_SETUP_CONFIRMATION)).not.toBeNull();
    expect(store.consume(p.id, "repo-a", "old", CURATOR_SETUP_CONFIRMATION)).toBeNull();
  });

  test("rejects wrong confirmation text", () => {
    const store = new CuratorSetupStore(
      () => 0,
      () => "id",
    );
    const p = store.create("repo-a", "");
    expect(store.consume(p.id, "repo-a", "", "nope")).toBeNull();
  });

  test("rejects wrong repo", () => {
    const store = new CuratorSetupStore(
      () => 0,
      () => "id",
    );
    const p = store.create("repo-a", "");
    expect(store.consume(p.id, "repo-b", "", CURATOR_SETUP_CONFIRMATION)).toBeNull();
  });

  test("rejects when current file hash changed since preview", () => {
    const store = new CuratorSetupStore(
      () => 0,
      () => "id",
    );
    const p = store.create("repo-a", "old");
    expect(store.consume(p.id, "repo-a", "edited", CURATOR_SETUP_CONFIRMATION)).toBeNull();
  });

  test("rejects stale preview after TTL", () => {
    let now = 0;
    const store = new CuratorSetupStore(
      () => now,
      () => "id",
    );
    const p = store.create("repo-a", "");
    now = CURATOR_SETUP_TTL_MS + 1;
    expect(store.consume(p.id, "repo-a", "", CURATOR_SETUP_CONFIRMATION)).toBeNull();
  });

  test("evicts oldest preview when max reached", () => {
    let id = 0;
    const store = new CuratorSetupStore(
      () => 0,
      () => `p${id++}`,
    );
    const created = Array.from({ length: 21 }, () => store.create("repo-a", ""));
    const evicted = created[0];
    if (!evicted) throw new Error("no previews created");
    expect(store.consume(evicted.id, "repo-a", "", CURATOR_SETUP_CONFIRMATION)).toBeNull();
    const last = created[created.length - 1];
    if (!last) throw new Error("no previews created");
    expect(store.consume(last.id, "repo-a", "", CURATOR_SETUP_CONFIRMATION)).not.toBeNull();
  });

  test("confirmation constant is the exact CREATE text", () => {
    expect(CURATOR_SETUP_CONFIRMATION).toBe("CREATE CURATOR WORKFLOW");
  });
});

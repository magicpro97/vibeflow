import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RevisionStartOwnerAuthority } from "../../src/orchestrator/conversation/revision-start-owner.js";

const operationId = `vf-operation-${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for revision start owner state");
}

test("an unprovable live cross-process owner cannot be claimed and becomes claimable after death", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-revision-start-owner-"));
  roots.push(root);
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../src/orchestrator/conversation/revision-start-owner.ts"),
  ).href;
  const source = [
    `import { RevisionStartOwnerAuthority } from ${JSON.stringify(moduleUrl)};`,
    `const token = new RevisionStartOwnerAuthority(${JSON.stringify(root)}).acquire(${JSON.stringify(operationId)});`,
    "token.assertHeld();",
    "setInterval(() => token.assertHeld(), 100);",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "ignore",
    stderr: "inherit",
  });
  const owners = new RevisionStartOwnerAuthority(root);
  try {
    await waitFor(() => owners.status(operationId) === "unprovable");
    expect(owners.claimDead(operationId)).toBeNull();
    child.kill();
    await child.exited;
    await waitFor(() => owners.status(operationId) === "dead");
    const recovered = owners.claimDead(operationId);
    expect(recovered).not.toBeNull();
    recovered?.assertHeld();
    recovered?.release();
    expect(owners.status(operationId)).toBe("absent");
  } finally {
    child.kill();
  }
});

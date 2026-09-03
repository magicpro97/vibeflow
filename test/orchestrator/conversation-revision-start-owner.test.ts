import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const owners = new RevisionStartOwnerAuthority(root);
  try {
    await waitFor(() => {
      const status = owners.status(operationId);
      return status === "live" || status === "unprovable";
    });
    expect(["live", "unprovable"]).toContain(owners.status(operationId));
    expect(owners.claimDead(operationId)).toBeNull();
    child.kill();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
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

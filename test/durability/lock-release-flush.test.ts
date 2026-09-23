import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Release durability: the lock record lives in a FILE descriptor, so emptying the owner slot
 * must be flushed with a file fsync. Routing it through syncDirectory once looked equivalent —
 * syncDirectory returns without syncing on Windows, so the released slot was never flushed and
 * a crash could resurrect stale ownership.
 *
 * A behavioural test cannot observe an fsync, so this pins the call shape at the one site that
 * regressed. If the release path is restructured, update the anchors — do not delete the check.
 */
describe("process lock release flushes the record file", () => {
  // Resolved from this file, not cwd: sibling tests chdir into temporary repositories, so a
  // relative read here would fail or read the wrong tree depending on test ordering.
  const source = readFileSync(
    fileURLToPath(new URL("../../src/durability/lock.ts", import.meta.url)),
    "utf8",
  );

  test("the release path fsyncs the lock file and syncs the directory separately", () => {
    const release = source.slice(source.indexOf("process lock release slot was not retained"));
    const body = release.slice(0, release.indexOf("finishRelease("));

    expect(body).toContain("fs.fsyncSync(current.fd)");
    expect(body).toContain("syncDirectory(current.root.fd)");
  });

  test("no syncDirectory call is handed a lock file descriptor", () => {
    // syncDirectory is a no-op on Windows by design; giving it current.fd silently drops the
    // flush there rather than failing, which is exactly how this shipped unnoticed.
    expect(source).not.toContain("syncDirectory(current.fd)");
    expect(source).not.toContain("syncDirectory(handle.fd)");
  });
});

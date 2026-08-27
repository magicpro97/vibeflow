import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNED_PROCESS_AUTHORITY_ERROR } from "../src/dispatch/owned-process-authority-contract.js";
import {
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STORAGE_NAME,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KIND,
} from "../src/dispatch/owned-process-contract.js";
import type { OwnedProcessPlatform } from "../src/dispatch/owned-process-platform.js";
import {
  OwnedProcessRecordStore,
  buildOwnedProcessRecord,
  ownedProcessPreimage,
} from "../src/dispatch/owned-process-record.js";
import { formatPlatformProcessStartIdentity } from "../src/durability/process-identity-contract.js";

const roots: string[] = [];
const OWNER_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "terminal-writer-owner");
const SUPERVISOR_IDENTITY = formatPlatformProcessStartIdentity(
  "freebsd",
  "terminal-writer-supervisor",
);
const CLI_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "terminal-writer-cli");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  store: OwnedProcessRecordStore;
  platform: OwnedProcessPlatform;
} {
  const root = mkdtempSync(join(tmpdir(), "vf-owned-terminal-writer-"));
  roots.push(root);
  return {
    root,
    store: new OwnedProcessRecordStore(root),
    platform: {
      strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
      platform: process.platform,
      observe: (pid) => {
        if (pid === process.pid)
          return { pid, identity: OWNER_IDENTITY, pgid: process.pid, sid: null };
        if (pid === 700) return { pid, identity: SUPERVISOR_IDENTITY, pgid: 700, sid: null };
        if (pid === 701) return { pid, identity: CLI_IDENTITY, pgid: 700, sid: null };
        return null;
      },
      terminateExactTree: () => undefined,
      proveQuiescent: () => true,
    },
  };
}

function persistedBytes(root: string, store: OwnedProcessRecordStore): Buffer {
  const [entry] = store.entries();
  if (!entry) throw new Error("missing owned process record fixture");
  return readFileSync(join(root, OWNED_PROCESS_STORAGE_NAME.RECORD_DIRECTORY, entry));
}

describe("owned process public writer authority", () => {
  test("rejects a second terminal digest and preserves the first terminal bytes", () => {
    const { root, store, platform } = fixture();
    const attemptId = "terminal-authority";
    const reserved = store.reserve(attemptId, "codex", platform);
    const releasedAt = new Date(Date.parse(reserved.updated_at) + 1_000).toISOString();
    const released = buildOwnedProcessRecord({
      ...ownedProcessPreimage(reserved),
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RELEASED,
      [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: "canonical release",
      [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: 0,
      [OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT]: true,
      [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: reserved.record_digest,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: releasedAt,
    });
    store.write(attemptId, reserved, released);
    const terminalBytes = persistedBytes(root, store);
    const rewritten = buildOwnedProcessRecord({
      ...ownedProcessPreimage(released),
      [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: "forged second release",
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: new Date(
        Date.parse(released.updated_at) + 1_000,
      ).toISOString(),
    });

    expect(() => store.write(attemptId, released, rewritten)).toThrow(
      OWNED_PROCESS_AUTHORITY_ERROR.WRITE_TRANSITION,
    );
    expect(persistedBytes(root, store).equals(terminalBytes)).toBe(true);

    store.write(attemptId, released, released);
    expect(persistedBytes(root, store).equals(terminalBytes)).toBe(true);
  });

  test("rejects rebinding durable process identity before persistence", () => {
    const { root, store, platform } = fixture();
    const attemptId = "identity-authority";
    const reserved = store.reserve(attemptId, "codex", platform);
    const initialBytes = persistedBytes(root, store);
    const rebound = buildOwnedProcessRecord({
      ...ownedProcessPreimage(reserved),
      [OWNED_PROCESS_RECORD_FIELD.OWNER_IDENTITY]: formatPlatformProcessStartIdentity(
        "freebsd",
        "forged-owner",
      ),
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: new Date(
        Date.parse(reserved.updated_at) + 1_000,
      ).toISOString(),
    });

    expect(() => store.write(attemptId, reserved, rebound)).toThrow(
      OWNED_PROCESS_AUTHORITY_ERROR.WRITE_TRANSITION,
    );
    expect(persistedBytes(root, store).equals(initialBytes)).toBe(true);
  });

  test("rejects replacing an existing running terminal observation", () => {
    const { root, store, platform } = fixture();
    const attemptId = "running-terminal-authority";
    const reserved = store.reserve(attemptId, "codex", platform);
    const running = buildOwnedProcessRecord({
      ...ownedProcessPreimage(reserved),
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: 700,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: SUPERVISOR_IDENTITY,
      [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: 701,
      [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: CLI_IDENTITY,
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RUNNING,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: new Date(
        Date.parse(reserved.updated_at) + 1_000,
      ).toISOString(),
    });
    store.write(attemptId, reserved, running);
    const observed = buildOwnedProcessRecord({
      ...ownedProcessPreimage(running),
      [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: new Date(
        Date.parse(running.updated_at) + 1_000,
      ).toISOString(),
    });
    store.write(attemptId, running, observed);
    const terminalBytes = persistedBytes(root, store);
    const replaced = buildOwnedProcessRecord({
      ...ownedProcessPreimage(observed),
      [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: OWNED_PROCESS_TERMINAL_KIND.OUTPUT_DRAIN_UNPROVEN,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: new Date(
        Date.parse(observed.updated_at) + 1_000,
      ).toISOString(),
    });

    expect(() => store.write(attemptId, observed, replaced)).toThrow(
      OWNED_PROCESS_AUTHORITY_ERROR.WRITE_TRANSITION,
    );
    expect(persistedBytes(root, store).equals(terminalBytes)).toBe(true);
  });
});

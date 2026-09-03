import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECOVERY_BOOTSTRAP_ACTIVATION_FAULT,
  activateRecoveryBootstrapForTrustedInstall,
  readActivatedRecoveryBootstrap,
} from "../../src/capabilities/authority-repair/bootstrap-activation.js";
import { recoveryBootstrapPaths } from "../../src/capabilities/authority-repair/paths.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";

const NOW = "2026-08-27T00:00:00.000Z";
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vf-recovery-bootstrap-"));
  roots.push(value);
  return value;
}

function options(fault?: (point: string) => void) {
  return {
    now: () => NOW,
    random_bytes: (size: number) => new Uint8Array(size).fill(0x2a),
    ...(fault ? { fault } : {}),
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("recovery bootstrap activation", () => {
  test("publishes one durable identity, receipt, and zero-byte journal idempotently", () => {
    const userRoot = root();
    const paths = recoveryBootstrapPaths(userRoot);
    const created = activateRecoveryBootstrapForTrustedInstall(userRoot, options());
    expect(created.disposition).toBe("created");
    expect(created.identity.bootstrap_id).toBe(`vf-recovery-bootstrap-${"2a".repeat(32)}`);
    expect(readFileSync(paths.journal)).toHaveLength(0);
    expect(readFileSync(paths.identity).toString("hex")).toBe(
      canonicalJsonBytes(created.identity).toString("hex"),
    );
    expect(readFileSync(paths.activation).toString("hex")).toBe(
      canonicalJsonBytes(created.receipt).toString("hex"),
    );
    expect(() => statSync(paths.pendingJournal)).toThrow();

    const existing = activateRecoveryBootstrapForTrustedInstall(userRoot, options());
    expect(existing.disposition).toBe("existing");
    expect(existing).toEqual({ ...created, disposition: "existing" });
    expect(readActivatedRecoveryBootstrap(userRoot)).toEqual(existing);

    if (process.platform !== "win32") {
      expect(statSync(paths.root).mode & 0o777).toBe(0o700);
      expect(statSync(paths.versionRoot).mode & 0o777).toBe(0o700);
      expect(statSync(paths.identity).mode & 0o777).toBe(0o600);
      expect(statSync(paths.activation).mode & 0o777).toBe(0o600);
      expect(statSync(paths.journal).mode & 0o777).toBe(0o600);
    }
  });

  test("resumes every published activation boundary without regenerating identity", () => {
    for (const point of Object.values(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT)) {
      const userRoot = root();
      expect(() =>
        activateRecoveryBootstrapForTrustedInstall(
          userRoot,
          options((observed) => {
            if (observed === point) throw new Error(`fault:${point}`);
          }),
        ),
      ).toThrow(`fault:${point}`);
      const identityBefore = readFileSync(recoveryBootstrapPaths(userRoot).identity);
      const resumed = activateRecoveryBootstrapForTrustedInstall(userRoot, options());
      expect(["resumed", "existing"]).toContain(resumed.disposition);
      expect(readFileSync(recoveryBootstrapPaths(userRoot).identity)).toEqual(identityBefore);
      expect(readActivatedRecoveryBootstrap(userRoot).identity).toEqual(resumed.identity);
    }
  });

  test("reconstructs a missing receipt only from a fully validated final journal", () => {
    const userRoot = root();
    const paths = recoveryBootstrapPaths(userRoot);
    const created = activateRecoveryBootstrapForTrustedInstall(userRoot, options());
    unlinkSync(paths.activation);
    const resumed = activateRecoveryBootstrapForTrustedInstall(userRoot, options());
    expect(resumed.disposition).toBe("resumed");
    expect(resumed.receipt).toEqual(created.receipt);
  });

  test("fails closed for missing or corrupt identity and illegal partial states", () => {
    const missing = root();
    expect(() => readActivatedRecoveryBootstrap(missing)).toThrow("identity is missing");

    const dependent = root();
    const dependentPaths = recoveryBootstrapPaths(dependent);
    mkdirSync(dependentPaths.versionRoot, { recursive: true, mode: 0o700 });
    writeFileSync(dependentPaths.journal, "", { mode: 0o600 });
    expect(() => activateRecoveryBootstrapForTrustedInstall(dependent, options())).toThrow(
      "identity is absent while dependent state exists",
    );

    const corrupt = root();
    const corruptPaths = recoveryBootstrapPaths(corrupt);
    activateRecoveryBootstrapForTrustedInstall(corrupt, options());
    if (process.platform !== "win32") chmodSync(corruptPaths.identity, 0o600);
    writeFileSync(corruptPaths.identity, "{}", { mode: 0o600 });
    expect(() => activateRecoveryBootstrapForTrustedInstall(corrupt, options())).toThrow(
      /bootstrap_identity|bootstrap identity/i,
    );

    const receiptOnly = root();
    const receiptOnlyPaths = recoveryBootstrapPaths(receiptOnly);
    activateRecoveryBootstrapForTrustedInstall(receiptOnly, options());
    unlinkSync(receiptOnlyPaths.journal);
    expect(() => activateRecoveryBootstrapForTrustedInstall(receiptOnly, options())).toThrow(
      "receipt exists without final or pending journal",
    );
  });
});

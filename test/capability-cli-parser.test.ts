import { describe, expect, test } from "bun:test";
import {
  CapabilityCliUsageError,
  parseAuthorityCliArgv,
  parseCapabilityCliArgv,
} from "../src/commands/capability/parser.js";

describe("capability CLI raw argv parser", () => {
  test("collects repeatable --for/--set/--private flags before generic collapse", () => {
    const parsed = parseCapabilityCliArgv(
      [
        "install",
        "acme.demo",
        "--for",
        "claude",
        "--for",
        "codex",
        "--set",
        "a=true",
        "--set",
        "b=1",
        "--private",
        "token=vf-private-input-binding-abc:sha256:1234567890123456789012345678901234567890123456789012345678901234",
        "--scope",
        "project",
      ],
      { stdinIsTTY: true, stdinHasData: false },
    );
    expect(parsed.kind).toBe("mutation");
    if (parsed.kind !== "mutation" || parsed.mode !== "direct") throw new Error("unreachable");
    expect(parsed.engines).toEqual(["claude", "codex"]);
    expect(parsed.publicInputs).toEqual([
      { input_id: "a", value: true },
      { input_id: "b", value: 1 },
    ]);
    expect(parsed.privateInputs).toEqual([
      {
        input_id: "token",
        reference: {
          private_input_binding_id: "vf-private-input-binding-abc",
          binding_digest: "sha256:1234567890123456789012345678901234567890123456789012345678901234",
        },
      },
    ]);
  });

  test("rejects duplicate singleton flags", () => {
    expect(() =>
      parseCapabilityCliArgv(["search", "demo", "--scope", "project", "--scope", "user"], {
        stdinIsTTY: true,
        stdinHasData: false,
      }),
    ).toThrow(CapabilityCliUsageError);
  });

  test("rejects unknown flags with a suggestion", () => {
    expect(() =>
      parseCapabilityCliArgv(["search", "demo", "--scop", "project"], {
        stdinIsTTY: true,
        stdinHasData: false,
      }),
    ).toThrow(/--scope/i);
  });

  test("rejects mixed direct flags with --request-file", () => {
    expect(() =>
      parseCapabilityCliArgv(
        [
          "install",
          "acme.demo",
          "--scope",
          "project",
          "--idempotency-key",
          "k1",
          "--request-file",
          "req.json",
        ],
        { stdinIsTTY: true, stdinHasData: false },
      ),
    ).toThrow(/request-file/i);
  });

  test("rejects --allow-network-read without direct dry-run capability mutation", () => {
    expect(() =>
      parseCapabilityCliArgv(
        ["install", "acme.demo", "--scope", "project", "--allow-network-read"],
        {
          stdinIsTTY: true,
          stdinHasData: false,
        },
      ),
    ).toThrow(/dry-run/i);
  });

  test("private-input bind requires explicit non-tty stdin controls", () => {
    expect(() =>
      parseCapabilityCliArgv(
        ["private-input", "bind", "acme.demo", "--scope", "project", "--input", "token"],
        { stdinIsTTY: false, stdinHasData: true },
      ),
    ).toThrow(/values-stdin/i);
    expect(() =>
      parseCapabilityCliArgv(
        [
          "private-input",
          "bind",
          "acme.demo",
          "--scope",
          "project",
          "--input",
          "token",
          "--values-stdin",
        ],
        { stdinIsTTY: false, stdinHasData: true },
      ),
    ).toThrow(/idempotency-key/i);
  });

  test("documented private-input bind shape accepts explicit non-tty authority", () => {
    const parsed = parseCapabilityCliArgv(
      [
        "private-input",
        "bind",
        "acme.reviewer",
        "--scope",
        "project",
        "--input",
        "api_key",
        "--values-stdin",
        "--idempotency-key",
        "private-input-1",
      ],
      { stdinIsTTY: false, stdinHasData: true },
    );
    expect(parsed.kind).toBe("private-input");
    if (parsed.kind !== "private-input") throw new Error("unreachable");
    expect(parsed.idempotencyKey).toBe("private-input-1");
    expect(parsed.inputIds).toEqual(["api_key"]);
  });

  test("non-interactive direct capability mutations require an outer idempotency key", () => {
    expect(() =>
      parseCapabilityCliArgv(["remove", "acme.demo", "--scope", "project"], {
        stdinIsTTY: false,
        stdinHasData: false,
      }),
    ).toThrow(/idempotency-key/i);
  });

  test("non-interactive install and retarget require explicit --for targets", () => {
    expect(() =>
      parseCapabilityCliArgv(
        ["install", "acme.demo", "--scope", "project", "--idempotency-key", "install-1"],
        { stdinIsTTY: false, stdinHasData: false },
      ),
    ).toThrow(/--for/i);
    expect(() =>
      parseCapabilityCliArgv(
        ["retarget", "acme.demo", "--scope", "project", "--idempotency-key", "retarget-1"],
        { stdinIsTTY: false, stdinHasData: false },
      ),
    ).toThrow(/--for/i);
  });
});

describe("authority CLI raw argv parser", () => {
  test("parses authority request-file mode without collapsing flags", () => {
    const parsed = parseAuthorityCliArgv(["grant", "create", "--request-file", "grant.json"], {
      stdinIsTTY: true,
      stdinHasData: false,
    });
    expect(parsed.kind).toBe("mutation");
    if (parsed.kind !== "mutation") throw new Error("unreachable");
    expect(parsed.mode).toBe("request-file");
    if (parsed.mode !== "request-file") throw new Error("unreachable");
    expect(parsed.requestFile).toBe("grant.json");
  });

  test("rejects authority --allow-network-read", () => {
    expect(() =>
      parseAuthorityCliArgv(
        ["grant", "create", "--request-file", "grant.json", "--allow-network-read"],
        { stdinIsTTY: true, stdinHasData: false },
      ),
    ).toThrow(/allow-network-read/i);
  });

  test("rejects non-interactive authority repair and scripted approvals", () => {
    expect(() =>
      parseAuthorityCliArgv(["repair"], { stdinIsTTY: false, stdinHasData: false }),
    ).toThrow(/interactive TTY/i);
    expect(() =>
      parseAuthorityCliArgv(["repair", "--yes"], { stdinIsTTY: true, stdinHasData: false }),
    ).toThrow(/does not accept --yes/i);
  });

  test("requires explicit scope for authority secret and trust mutations", () => {
    expect(() =>
      parseAuthorityCliArgv(
        [
          "secret",
          "revoke",
          "--package",
          "acme.demo",
          "--input",
          "token",
          "--idempotency-key",
          "secret-1",
        ],
        { stdinIsTTY: true, stdinHasData: false },
      ),
    ).toThrow(/scope/i);
    expect(() =>
      parseAuthorityCliArgv(
        ["trust", "add", "--trust-file", "trust.json", "--idempotency-key", "trust-1"],
        { stdinIsTTY: true, stdinHasData: false },
      ),
    ).toThrow(/scope/i);
  });
});

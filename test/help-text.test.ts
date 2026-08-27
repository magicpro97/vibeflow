import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printHelp } from "../src/commands.js";
import { parseCapabilityCliArgv } from "../src/commands/capability/parser.js";
import { COMMAND_HELP } from "../src/commands/help-commands.js";
import { hasCommandHelp, printCommandHelp } from "../src/commands/help.js";
import {
  DEFAULT_UI_PORT,
  EPHEMERAL_UI_PORT,
  UI_CLI_PORT,
  UI_HOOK_APPROVAL,
  UI_HOOK_ROUTE,
  UI_LAN_AUTHORITY,
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY,
  UI_LAN_TOKEN_HEADER,
  UI_SERVER_DISCOVERY,
} from "../src/core/ui-cli-contract.js";
import { skillsCommandHelp } from "../src/help/skills-command-help.js";

const SKILL_SUBS = [
  "list",
  "search",
  "resolve",
  "validate",
  "sync",
  "verify-sync",
  "import",
  "registry",
  "semantic-filter",
];

describe("help text", () => {
  test("printHelp() returns 0 (smoke check that the function runs)", () => {
    // printHelp writes via out()/logbus. Capture is complex; assert it doesn't throw.
    expect(printHelp()).toBe(0);
  });

  test("skills command help mentions every skills subcommand", () => {
    const block = skillsCommandHelp();
    for (const sub of SKILL_SUBS) {
      expect(block).toContain(sub);
    }
  });

  test("skills help documents explicit engine and skill targeting for sync", () => {
    const help = skillsCommandHelp();
    expect(help).toContain(
      "sync [--mode pointer|full] [--engine <name>] [--skill <name>] [--from-registry]",
    );
    expect(help).toContain("verify-sync [--engine <name>] [--from-registry]");
    expect(help).toContain("default engine: copilot");
    expect(help).toContain(
      "vf skills sync --mode pointer --engine codex --skill typed-protocol-contracts",
    );
  });

  test("src/commands/help.ts global help line mentions validate/sync/verify-sync/import", () => {
    // Global help text moved to src/commands/help.ts in issue #80 phase
    // 8/14. The line still contains the canonical skills subcommand
    // roster as a one-liner in the usage block.
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help.ts"), "utf8");
    const line = src.match(/skills \[sub\][^\n]*/);
    expect(line).not.toBeNull();
    for (const sub of ["list", "search", "resolve", "validate", "sync", "verify-sync", "import"]) {
      expect(line?.[0] ?? "").toContain(sub);
    }
  });

  test("config has a per-command help block naming its memory subcommand", () => {
    expect(hasCommandHelp("config")).toBe(true);
    // printCommandHelp returns 0 and renders the config block (covers the
    // new COMMAND_HELP.config arm in src/commands/help.ts).
    expect(printCommandHelp("config")).toBe(0);
  });

  test("demo has a per-command help block (covers the new COMMAND_HELP.demo arm)", () => {
    expect(hasCommandHelp("demo")).toBe(true);
    expect(printCommandHelp("demo")).toBe(0);
  });

  test("verify help documents the coverage and review-base authorities", () => {
    const help = COMMAND_HELP.verify?.() ?? "";
    expect(help).toContain("--coverage");
    expect(help).toContain("coverage/lcov.info");
    expect(help).toContain("--review-base <full-SHA>");
  });

  test("ui help distinguishes Home ports from repository intake", () => {
    const help = COMMAND_HELP.ui?.() ?? "";
    const normalizedHelp = help.replace(/\s+/gu, " ");
    expect(help).toContain("AI-first Home");
    expect(Object.isFrozen(UI_CLI_PORT)).toBe(true);
    expect(DEFAULT_UI_PORT).toBe(7799);
    expect(EPHEMERAL_UI_PORT).toBe(0);
    expect(help).toContain(`both use stable port ${DEFAULT_UI_PORT}`);
    expect(help).toContain(`--port ${EPHEMERAL_UI_PORT}`);
    expect(help).toContain("ephemeral free port");
    expect(help).toContain("TTY questionnaire in `vf init`");
    expect(help).not.toContain("intake wizard + workflow console");
    expect(help).not.toContain("--interactive");
    expect(Object.isFrozen(UI_LAN_AUTHORITY)).toBe(true);
    expect(Object.isFrozen(UI_HOOK_ROUTE)).toBe(true);
    expect(Object.isFrozen(UI_HOOK_APPROVAL)).toBe(true);
    expect(Object.isFrozen(UI_SERVER_DISCOVERY)).toBe(true);
    expect(normalizedHelp).toContain("Any non-loopback --host exposes the server");
    expect(normalizedHelp).toContain("single-use bootstrap URL");
    expect(normalizedHelp).toContain("unauthenticated root loads return 401");
    expect(normalizedHelp).toContain(`CSRF checks require the ${UI_LAN_TOKEN_HEADER} header`);
    expect(normalizedHelp).toContain("EventSource cannot set custom");
    expect(normalizedHelp).toContain(
      `streams use the ${UI_LAN_EVENT_SOURCE_TOKEN_QUERY} query parameter`,
    );
    expect(normalizedHelp).toContain("Page authority never authenticates Conversation Home");
    expect(normalizedHelp).toContain("Hook approval uses a separate loopback-only listener");
    expect(normalizedHelp).toContain("routes return 401");
    expect(help).toMatch(/Use\s+loopback\s+for conversations/u);
  });

  test("documented private-input example parses in a non-interactive shell", () => {
    const help = COMMAND_HELP.capability?.() ?? "";
    const line = help
      .split("\n")
      .find((candidate) => candidate.trimStart().startsWith("vf capability private-input bind"));
    expect(line).toBeDefined();
    expect(line).toContain("--idempotency-key private-input-1");
    const argv = (line ?? "").trim().split(/\s+/u).slice(2);
    const parsed = parseCapabilityCliArgv(argv, { stdinIsTTY: false, stdinHasData: true });
    expect(parsed.kind).toBe("private-input");
    if (parsed.kind !== "private-input") throw new Error("documented example parsed incorrectly");
    expect(parsed.idempotencyKey).toBe("private-input-1");
    expect(parsed.inputIds).toEqual(["api_key"]);
  });

  test("production UI launch consumers share the dependency-neutral port authority", () => {
    for (const relativePath of [
      "src/cli.ts",
      "src/commands/help.ts",
      "src/commands/help-commands.ts",
      "src/ui/vite.config.ts",
    ]) {
      const source = readFileSync(join(import.meta.dir, "..", relativePath), "utf8");
      expect(source).toContain("DEFAULT_UI_PORT");
      expect(source).not.toContain("7799");
    }
    const packageJson = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
    expect(packageJson).not.toContain("--port 7799");
  });

  test("init help names all engine targets and the real TTY opt-out", () => {
    const help = COMMAND_HELP.init?.() ?? "";
    expect(help).toContain("claude|codex|copilot|opencode|antigravity");
    expect(help).toContain("--no-ask");
    expect(help).not.toContain("--interactive");
  });

  test("doctor and orchestrate help expose owned-process and exact-session boundaries", () => {
    const doctorHelp = COMMAND_HELP.doctor?.() ?? "";
    expect(doctorHelp).toContain("--fix");
    expect(doctorHelp).toContain("exact proved orphan");
    expect(doctorHelp).toContain("PID alone is never ownership proof");

    const orchestrateHelp = COMMAND_HELP.orchestrate?.() ?? "";
    expect(orchestrateHelp).toContain("claude, codex, or opencode");
    expect(orchestrateHelp).toContain("other engines never claim exact resume");
  });

  test("review help documents only the routed evidence commands and binding contract", () => {
    expect(hasCommandHelp("review")).toBe(true);
    expect(printCommandHelp("review")).toBe(0);
    const help = COMMAND_HELP.review?.() ?? "";
    expect(help).toContain("evidence --base <sha> --result <file>");
    expect(help).toContain("check --base <sha>");
    expect(help).toContain("base SHA, head SHA, sorted name-status manifest");
    expect(help).toContain("changedDigest");
  });

  test("update-check has a per-command help block (covers the COMMAND_HELP['update-check'] arm)", () => {
    expect(hasCommandHelp("update-check")).toBe(true);
    expect(printCommandHelp("update-check")).toBe(0);
  });

  test("superpowers has dry-default sync help", () => {
    expect(hasCommandHelp("superpowers")).toBe(true);
    expect(printCommandHelp("superpowers")).toBe(0);
    const src = readFileSync(
      join(import.meta.dir, "..", "src/commands/help-superpowers.ts"),
      "utf8",
    );
    expect(src).toContain("vf superpowers sync");
    expect(src).toContain("dry run by default");
    expect(src).toContain("--yes");
  });

  test("status has a per-command help block (covers the COMMAND_HELP.status arm, #613)", () => {
    expect(hasCommandHelp("status")).toBe(true);
    expect(printCommandHelp("status")).toBe(0);
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help.ts"), "utf8");
    expect(src).toContain("--timeline <unit>");
  });

  test("eval has a per-command help block (covers the COMMAND_HELP.eval arm, #549)", () => {
    expect(hasCommandHelp("eval")).toBe(true);
    expect(printCommandHelp("eval")).toBe(0);
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help-commands.ts"), "utf8");
    expect(src).toContain("--min-pass-rate <0..1>");
  });

  test("chat and brainstorm have per-command help blocks", () => {
    expect(hasCommandHelp("chat")).toBe(true);
    expect(hasCommandHelp("brainstorm")).toBe(true);
    expect(printCommandHelp("chat")).toBe(0);
    expect(printCommandHelp("brainstorm")).toBe(0);
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help.ts"), "utf8");
    expect(src).toContain("canonical conversational entry");
    expect(src).toContain("shared debate policy");
    const conversation = readFileSync(
      join(import.meta.dir, "..", "src/commands/help-conversation.ts"),
      "utf8",
    );
    expect(conversation).toContain("1..100");
    expect(conversation).toContain("Create-only flags are rejected with --resume");
    expect(conversation).toContain("dispatch the full debate");
  });
});

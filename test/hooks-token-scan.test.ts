import { describe, expect, test } from "bun:test";
import { type SecretHit, scanSecrets } from "../src/hooks/token-scan.js";

// Dummy tokens are built by concatenation so no literal full token appears in
// this source — otherwise the armed PreToolUse secret gate would self-block the
// write of this very test file.
const AWS = `AKIA${"IOSFODNN7EXAMPL".slice(0, 15)}E`; // AKIA + 16 chars
const GH = `ghp_${"0".repeat(36)}`;
const OPENAI = `sk-${"a".repeat(48)}`;
const SLACK = `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`;
const GOOGLE = `AIza${"B".repeat(35)}`;
const PRIVKEY = `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`;
const JWT = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;

describe("token-scan: known token patterns", () => {
  test("flags AWS access key id", () => {
    const hits = scanSecrets(`const k='${AWS}'`);
    expect(hits.some((h) => h.label === "AWS access key id")).toBe(true);
  });

  test("flags GitHub token", () => {
    const hits = scanSecrets(GH);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe("GitHub token");
  });

  test("flags OpenAI key", () => {
    const hits = scanSecrets(OPENAI);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe("OpenAI key");
  });

  test("flags Slack token", () => {
    const hits = scanSecrets(SLACK);
    expect(hits.some((h) => h.label === "Slack token")).toBe(true);
  });

  test("flags Google API key", () => {
    const hits = scanSecrets(GOOGLE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe("Google API key");
  });

  test("flags private key block", () => {
    const hits = scanSecrets(PRIVKEY);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe("private key block");
  });

  test("flags JWT", () => {
    const hits = scanSecrets(JWT);
    expect(hits.some((h) => h.label === "JWT")).toBe(true);
  });

  test("hit carries label only — never any secret substring", () => {
    const [hit] = scanSecrets(GH) as SecretHit[];
    expect(hit?.label).toBe("GitHub token");
    // No field may carry a slice of the secret (it surfaces in hook logs).
    expect(JSON.stringify(hit)).not.toContain("ghp_");
  });

  test("clean code produces no hits", () => {
    expect(scanSecrets("const total = a + b; // sum")).toEqual([]);
  });

  test("empty / undefined content is safe", () => {
    expect(scanSecrets("")).toEqual([]);
    expect(scanSecrets(undefined)).toEqual([]);
  });
});

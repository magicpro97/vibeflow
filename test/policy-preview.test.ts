import { describe, expect, test } from "bun:test";
import {
  policyDiff,
  policyHash,
  projectPolicy,
  validatePolicyCandidate,
} from "../src/policy-preview.js";

const base = {
  tools: { codegraph: true, lsp: true },
  memory: false,
  notifications: true,
  failureProtection: {
    timeoutSeconds: 3600,
    autoWip: false,
    rollbackOnFail: false,
    requireGit: false,
  },
  envPolicy: { deny: ["AWS_SECRET_ACCESS_KEY"], allow: ["PATH"] },
  hooks: {
    templates: ["protect-secrets"],
    custom: [{ name: "destructive", kind: "command", pattern: "rm -rf", risk: "high" }],
  },
  updatedAt: "x",
};

describe("policy preview projection", () => {
  test("projects only bounded policy fields", () => {
    const projected = projectPolicy({ ...base, credentials: "secret", absolutePath: "/Users/me" });
    expect(projected).toEqual({
      envPolicy: { allow: ["PATH"], deny: ["AWS_SECRET_ACCESS_KEY"] },
      hooks: {
        custom: [{ kind: "command", name: "destructive", pattern: "rm -rf", risk: "high" }],
        templates: ["protect-secrets"],
      },
    });
  });

  test("diff ordering and hash stay deterministic", () => {
    const next = {
      ...base,
      envPolicy: { deny: ["AWS_SECRET_ACCESS_KEY", "TOKEN"], allow: ["PATH"] },
    };
    expect(policyDiff(base, next)).toEqual([
      {
        field: "envPolicy.deny",
        before: ["AWS_SECRET_ACCESS_KEY"],
        after: ["AWS_SECRET_ACCESS_KEY", "TOKEN"],
        relaxation: false,
      },
    ]);
    expect(policyHash(base)).toBe(
      policyHash({ ...base, envPolicy: { allow: ["PATH"], deny: ["AWS_SECRET_ACCESS_KEY"] } }),
    );
  });

  test("rejects unknown and malformed policy payloads", () => {
    expect(validatePolicyCandidate({ hooks: {}, envPolicy: {}, extra: true })).toBeNull();
    expect(validatePolicyCandidate({ hooks: { templates: ["bad"] } })).toBeNull();
    expect(validatePolicyCandidate({ envPolicy: { allow: ["A\nB"] } })).toBeNull();
  });

  test("marks custom rule removal as relaxation", () => {
    const next = {
      ...base,
      hooks: { templates: ["protect-secrets"], custom: [] },
    };
    expect(policyDiff(base, next)).toContainEqual({
      field: "hooks.custom",
      before: base.hooks.custom,
      after: [],
      relaxation: true,
    });
  });

  test("marks broader allow, disabled template, and removed custom guard as relaxation", () => {
    const next = {
      ...base,
      envPolicy: { deny: ["AWS_SECRET_ACCESS_KEY"], allow: ["PATH", "HOME"] },
      hooks: { templates: [], custom: [] },
    };
    expect(policyDiff(base, next).filter((d) => d.relaxation)).toHaveLength(3);
  });
});

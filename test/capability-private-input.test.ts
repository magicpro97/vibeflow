import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionIdempotencyScopeDigest } from "../src/actions/index.js";
import {
  CliCapabilityPrivateInputAuthorityV1,
  type PrivateInputBindRequestV1,
} from "../src/capabilities/private-input/authority.js";
import { digestV1 } from "../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-private-input-"));
  roots.push(root);
  const scope_identity_digest = digestV1("VF-TEST-SCOPE\0v1\0", root);
  return {
    root,
    scope_identity_digest,
    authority: new CliCapabilityPrivateInputAuthorityV1({
      root,
      scope: "project",
      scopeIdentityDigest: scope_identity_digest,
      now: () => "2026-08-25T00:00:00.000Z",
      principalDigest: digestV1("VF-TEST-PRINCIPAL\0v1\0", root),
      authorityScopeDigest: actionIdempotencyScopeDigest({
        kind: "capability",
        scope: "project",
        scope_identity_digest,
      }),
    }),
  };
}

function request(overrides: Partial<PrivateInputBindRequestV1> = {}): PrivateInputBindRequestV1 {
  return {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    package_id: "acme.demo",
    package_pin_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    manifest_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    idempotency_key: "bind-1",
    values: { token: "secret-value" },
    expires_at: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

describe("CLI private input authority", () => {
  test("commits one durable binding and exact idempotent replay", () => {
    const fx = fixture();
    const first = fx.authority.bind(request({ scope_identity_digest: fx.scope_identity_digest }));
    const second = fx.authority.bind(request({ scope_identity_digest: fx.scope_identity_digest }));
    expect(second).toEqual(first);
    expect(first.input_ids).toEqual(["token"]);
  });

  test("validates a returned reference and reports current presence", () => {
    const fx = fixture();
    const binding = fx.authority.bind(
      request({
        scope_identity_digest: fx.scope_identity_digest,
        values: { alpha: "a", beta: "b" },
      }),
    );
    fx.authority.validateReference({
      scope: "project",
      scope_identity_digest: fx.scope_identity_digest,
      package_id: "acme.demo",
      package_pin_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      manifest_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      input_id: "alpha",
      reference: {
        private_input_binding_id: binding.private_binding_id,
        binding_digest: binding.binding_digest,
      },
    });
    expect(
      fx.authority.readValidatedPresence({
        scope: "project",
        package_id: "acme.demo",
        package_pin_digest:
          "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        manifest_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        input_id: "alpha",
      }),
    ).toEqual({ kind: "private", present: true });
  });

  test("aggregates current and patched binding digests from selected heads", () => {
    const fx = fixture();
    const initial = fx.authority.bind(
      request({
        scope_identity_digest: fx.scope_identity_digest,
        values: { alpha: "a", beta: "b" },
      }),
    );
    const replacement = fx.authority.bind(
      request({
        scope_identity_digest: fx.scope_identity_digest,
        idempotency_key: "bind-2",
        values: { beta: "bb" },
      }),
    );
    const current = fx.authority.resolveCurrentBinding({
      scope: "project",
      scope_identity_digest: fx.scope_identity_digest,
      package_id: "acme.demo",
      package_pin_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      manifest_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      input_ids: ["alpha", "beta"],
    });
    const patched = fx.authority.resolvePatchedBinding({
      scope: "project",
      scope_identity_digest: fx.scope_identity_digest,
      package_id: "acme.demo",
      package_pin_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      manifest_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      current_binding_digest: current,
      current_input_ids: ["alpha", "beta"],
      replacements: [
        {
          input_id: "beta",
          reference: {
            private_input_binding_id: replacement.private_binding_id,
            binding_digest: replacement.binding_digest,
          },
        },
      ],
      patch_digest: digestV1("VF-TEST-PATCH\0v1\0", "beta"),
    });
    expect(initial.binding_digest).not.toBe(replacement.binding_digest);
    expect(patched.binding_digest).not.toBe(current);
    expect(patched.prior_binding_digest).toBe(current);
  });
});

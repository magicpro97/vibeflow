import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_ROOT_LOCATOR_KIND } from "../../src/actions/protocol-contract.js";
import { FilesystemSecretRevocationCandidateAuthorityV1 } from "../../src/capabilities/authority-mutation/index.js";
import { CliPrivateInputDurableStoreV1 } from "../../src/capabilities/private-input/storage.js";
import type {
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCurrentHeadRecordV1,
  HeadIdentity,
} from "../../src/capabilities/private-input/types.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/paths.js";
import { digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
const NOW = "2030-01-01T00:00:00.000Z";
const digest = (label: string) => digestV1("VF-TEST-AUTHORITY-EDGE\0v1\0", label);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `vf-${label}-`));
  roots.push(value);
  return value;
}

describe("ordinary authority secret-candidate coverage edges", () => {
  test("materializes an exact secret candidate from current private-input records", () => {
    const sourceRoot = tempRoot("secret-source");
    const destinationRoot = tempRoot("secret-destination");
    const source = new CliPrivateInputDurableStoreV1(sourceRoot);
    const scopeIdentity = digest("secret-scope");
    const row: CliBindingRowV1 = {
      input_id: "token",
      secret_handle_id_digest: digest("secret-handle"),
      broker_binding_epoch: 1,
      broker_scope_digest: digest("broker-scope"),
      broker_put_receipt_digest: digest("broker-receipt"),
      expected_current_head_digest: null,
    };
    const bindingPreimage = {
      schema_version: "1.0" as const,
      binding_kind: "broker-stage" as const,
      preparation_digest: null,
      scope: "project" as const,
      scope_identity_digest: scopeIdentity,
      package_id: "acme.tool",
      package_pin_digest: digest("package-pin"),
      manifest_digest: digest("manifest"),
      action_root_locator: {
        kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
        scope: "project" as const,
        scope_identity_digest: scopeIdentity,
      },
      bindings: [row],
      created_at: NOW,
      expires_at: "2030-01-01T01:00:00.000Z",
    };
    const bindingDigest = digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", bindingPreimage);
    const binding: CliBindingRecordV1 = {
      ...bindingPreimage,
      private_binding_id: `vf-private-input-binding-${bindingDigest.slice(7)}`,
      binding_digest: bindingDigest,
    };
    const identity: HeadIdentity = {
      scope: binding.scope,
      scope_identity_digest: binding.scope_identity_digest,
      package_id: binding.package_id,
      package_pin_digest: binding.package_pin_digest,
      manifest_digest: binding.manifest_digest,
      input_id: row.input_id,
    };
    const headPreimage = {
      schema_version: "1.0" as const,
      ...identity,
      private_binding_id: binding.private_binding_id,
      binding_digest: binding.binding_digest,
      expires_at: binding.expires_at,
      updated_at: NOW,
    };
    const head: CliCurrentHeadRecordV1 = {
      ...headPreimage,
      head_digest: digestV1("VF-CLI-PRIVATE-INPUT-CURRENT-HEAD\0v1\0", headPreimage),
    };
    source.writeJson(source.bindingPath(binding.private_binding_id), binding);
    source.writeJson(source.headPath(identity), head);
    const authority = new FilesystemSecretRevocationCandidateAuthorityV1({
      storage: {
        paths: { ...projectCapabilityPaths(destinationRoot), privateRoot: destinationRoot },
        scopeIdentityDigest: scopeIdentity,
        readStatus: () => ({
          lock: {
            packages: [
              {
                package_id: binding.package_id,
                pin: { pin_digest: binding.package_pin_digest },
                manifest_digest: binding.manifest_digest,
              },
            ],
          },
        }),
      } as never,
      action_root_path: () => sourceRoot,
    });
    const candidate = authority.resolve({
      kind: "binding",
      package_id: binding.package_id,
      input_id: row.input_id,
    });
    expect(candidate.secret_handle_id_digest).toBe(row.secret_handle_id_digest);

    const mismatchedPreimage = { ...headPreimage, manifest_digest: digest("other-manifest") };
    source.writeJson(source.headPath(identity), {
      ...mismatchedPreimage,
      head_digest: digestV1("VF-CLI-PRIVATE-INPUT-CURRENT-HEAD\0v1\0", mismatchedPreimage),
    });
    expect(() =>
      authority.resolve({
        kind: "binding",
        package_id: binding.package_id,
        input_id: row.input_id,
      }),
    ).toThrow(/escaped its source binding/);
    expect(() =>
      (
        authority as never as {
          materializeCandidate(
            binding: CliBindingRecordV1,
            row: CliBindingRowV1,
            head: CliCurrentHeadRecordV1,
          ): unknown;
        }
      ).materializeCandidate(binding, row, {
        ...head,
        private_binding_id: "vf-private-input-binding-wrong",
      }),
    ).toThrow(/escaped its source binding/);
  });
});

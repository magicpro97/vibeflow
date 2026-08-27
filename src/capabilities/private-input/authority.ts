import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { CapabilityPublicInputV1 } from "../../actions/request-types.js";
import { digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { privateActionInputBindingDigest } from "../planning/action-materialization.js";
import type {
  CapabilityPrivateInputAuthorityV1,
  CapabilityPrivateInputPatchBindingV1,
} from "../planning/input-materializer.js";
import type { CapabilityPrivateInputPresenceReaderV1 } from "../query/types.js";
import { bytewise } from "../wire/primitives.js";
import { bindCliPrivateInputs } from "./authority-bind.js";
import { materializeExecutionPrivateInputBinding } from "./execution-binding.js";
import {
  assertPackageIdentity,
  emptyBindingDigest,
  minimumTimestamp,
  uniqueSortedInputIds,
} from "./helpers.js";
import { assertPrivateInputScopeIdentity, readValidatedPrivateInputPresence } from "./presence.js";
import { CliPrivateInputDurableStoreV1 } from "./storage.js";
import type {
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCapabilityPrivateInputAuthorityOptions,
  HeadIdentity,
  PrivateInputBindRequestV1,
  PrivateReferenceV1,
  Scope,
} from "./types.js";

export type { PrivateInputBindRequestV1 } from "./types.js";

export class CliCapabilityPrivateInputAuthorityV1
  implements CapabilityPrivateInputAuthorityV1, CapabilityPrivateInputPresenceReaderV1
{
  private readonly store: CliPrivateInputDurableStoreV1;
  private readonly scope: Scope;
  private readonly scopeIdentityDigest: string;
  private readonly principalDigest: string;
  private readonly authorityScopeDigest: string;
  private readonly now: () => string;

  constructor(options: CliCapabilityPrivateInputAuthorityOptions) {
    this.store = new CliPrivateInputDurableStoreV1(options.root);
    this.scope = options.scope;
    this.scopeIdentityDigest = options.scopeIdentityDigest;
    this.principalDigest = options.principalDigest;
    this.authorityScopeDigest = options.authorityScopeDigest;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  bind(request: PrivateInputBindRequestV1) {
    return bindCliPrivateInputs({
      request,
      store: this.store,
      scope: this.scope,
      scopeIdentityDigest: this.scopeIdentityDigest,
      principalDigest: this.principalDigest,
      authorityScopeDigest: this.authorityScopeDigest,
      now: this.now,
    });
  }

  validateReference(input: {
    scope: Scope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_id: string;
    reference: PrivateReferenceV1;
  }): void {
    this.assertScopeIdentity(input.scope, input.scope_identity_digest);
    assertPackageIdentity(input.package_id, input.package_pin_digest, input.manifest_digest);
    const binding = this.requireBinding(input.reference.private_input_binding_id);
    if (binding.binding_digest !== input.reference.binding_digest)
      throw new CapabilityRuntimeError(
        "private input reference digest mismatch",
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    if (
      binding.scope !== input.scope ||
      binding.scope_identity_digest !== input.scope_identity_digest ||
      binding.package_id !== input.package_id ||
      binding.package_pin_digest !== input.package_pin_digest ||
      binding.manifest_digest !== input.manifest_digest
    ) {
      throw new CapabilityRuntimeError(
        "private input reference does not belong to the selected package identity",
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    }
    if (Date.parse(this.now()) >= Date.parse(binding.expires_at))
      throw new CapabilityRuntimeError(
        "private input reference has expired",
        CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE,
      );
    if (!binding.bindings.some((row) => row.input_id === input.input_id)) {
      throw new CapabilityRuntimeError(
        `private input reference does not contain ${input.input_id}`,
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    }
  }

  resolveCurrentBinding(input: {
    scope: Scope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_ids: string[];
  }): string {
    this.assertScopeIdentity(input.scope, input.scope_identity_digest);
    assertPackageIdentity(input.package_id, input.package_pin_digest, input.manifest_digest);
    const inputIds = uniqueSortedInputIds(input.input_ids);
    if (inputIds.length === 0) return emptyBindingDigest(this.packageIdentity(input));
    return privateActionInputBindingDigest(
      inputIds.map((inputId) => {
        const head = this.requireHead(this.headIdentity(input, inputId));
        return {
          input_id: inputId,
          value: {
            private_input_binding_id: head.private_binding_id,
            binding_digest: head.binding_digest,
          },
        } satisfies CapabilityPublicInputV1;
      }),
    );
  }

  resolvePatchedBinding(input: {
    scope: Scope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    current_binding_digest: string;
    current_input_ids: string[];
    replacements: Array<{ input_id: string; reference: PrivateReferenceV1 }>;
    patch_digest: string;
  }): CapabilityPrivateInputPatchBindingV1 {
    this.assertScopeIdentity(input.scope, input.scope_identity_digest);
    assertPackageIdentity(input.package_id, input.package_pin_digest, input.manifest_digest);
    const currentIds = uniqueSortedInputIds(input.current_input_ids);
    const currentBinding = this.resolveCurrentBinding({
      ...this.packageIdentity(input),
      input_ids: currentIds,
    });
    if (currentBinding !== input.current_binding_digest) {
      throw new CapabilityRuntimeError(
        "current private input binding digest is stale",
        CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE,
      );
    }
    const currentSources = new Map(
      currentIds.map((inputId) => [
        inputId,
        this.sourceFromHead(this.headIdentity(input, inputId)),
      ]),
    );
    const replacementSources = new Map(
      input.replacements
        .sort((left, right) => bytewise(left.input_id, right.input_id))
        .map((replacement) => [
          replacement.input_id,
          this.sourceFromReference({ ...this.packageIdentity(input), ...replacement }),
        ]),
    );
    const finalInputIds = [
      ...new Set([...currentSources.keys(), ...replacementSources.keys()]),
    ].sort(bytewise);
    if (finalInputIds.length === 0) {
      return {
        binding_digest: emptyBindingDigest(this.packageIdentity(input)),
        prior_binding_digest: input.current_binding_digest,
        patch_digest: input.patch_digest,
      };
    }
    const rows = finalInputIds.map((inputId) =>
      this.patchBindingRow(input, inputId, currentSources, replacementSources),
    );
    return {
      binding_digest: digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", {
        schema_version: "1.0",
        binding_kind: "plan-aggregate",
        preparation_digest: null,
        ...this.packageIdentity(input),
        action_root_locator: {
          kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
          scope: input.scope,
          scope_identity_digest: input.scope_identity_digest,
        },
        bindings: rows.map((row) => row.row),
        created_at: minimumTimestamp(rows.map((row) => row.created_at)),
        expires_at: minimumTimestamp(rows.map((row) => row.expires_at)),
      }),
      prior_binding_digest: input.current_binding_digest,
      patch_digest: input.patch_digest,
    };
  }

  materializeExecutionBinding(
    input: Parameters<
      NonNullable<CapabilityPrivateInputAuthorityV1["materializeExecutionBinding"]>
    >[0],
  ) {
    this.assertScopeIdentity(input.scope, input.scope_identity_digest);
    return materializeExecutionPrivateInputBinding(input, {
      readHead: (identity) => this.store.readHead(identity),
      readBinding: (privateBindingId) =>
        this.store.readBinding(this.store.bindingPath(privateBindingId)),
    });
  }

  readValidatedPresence(request: {
    scope: Scope;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_id: string;
  }): Extract<
    import("../wire/query.js").PublicCapabilityInputStateV1["current"],
    { kind: "unset" | "private" }
  > {
    return readValidatedPrivateInputPresence({
      request,
      expectedScope: this.scope,
      scopeIdentityDigest: this.scopeIdentityDigest,
      now: this.now,
      readHead: (identity) => this.store.readHead(identity),
      readBinding: (privateBindingId) =>
        this.store.readBinding(this.store.bindingPath(privateBindingId)),
    });
  }

  private patchBindingRow(
    input: {
      scope: Scope;
      scope_identity_digest: string;
      package_id: string;
      package_pin_digest: string;
      manifest_digest: string;
    },
    inputId: string,
    currentSources: Map<string, { record: CliBindingRecordV1; row: CliBindingRowV1 }>,
    replacementSources: Map<string, { record: CliBindingRecordV1; row: CliBindingRowV1 }>,
  ) {
    const selected = replacementSources.get(inputId) ?? currentSources.get(inputId);
    if (!selected)
      throw new CapabilityRuntimeError(
        `private input ${inputId} has no source binding`,
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    const currentHead = this.requireHead(this.headIdentity(input, inputId));
    if (
      currentHead.binding_digest !== selected.record.binding_digest ||
      currentHead.private_binding_id !== selected.record.private_binding_id
    ) {
      throw new CapabilityRuntimeError(
        `private input ${inputId} is not selected by the current head`,
        CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE,
      );
    }
    return {
      row: {
        input_id: inputId,
        secret_handle_id_digest: selected.row.secret_handle_id_digest,
        broker_binding_epoch: selected.row.broker_binding_epoch,
        broker_scope_digest: selected.row.broker_scope_digest,
        broker_put_receipt_digest: selected.row.broker_put_receipt_digest,
        expected_current_head_digest: currentHead.head_digest,
      } satisfies CliBindingRowV1,
      created_at: selected.record.created_at,
      expires_at: selected.record.expires_at,
    };
  }

  private sourceFromHead(identity: HeadIdentity): {
    record: CliBindingRecordV1;
    row: CliBindingRowV1;
  } {
    const head = this.requireHead(identity);
    const record = this.requireBinding(head.private_binding_id);
    if (record.binding_digest !== head.binding_digest)
      throw new CapabilityRuntimeError(
        "private input head binding digest mismatch",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    const row = record.bindings.find((candidate) => candidate.input_id === identity.input_id);
    if (!row)
      throw new CapabilityRuntimeError(
        `binding ${record.private_binding_id} does not contain ${identity.input_id}`,
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    return { record, row };
  }

  private sourceFromReference(input: {
    scope: Scope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_id: string;
    reference: PrivateReferenceV1;
  }): { record: CliBindingRecordV1; row: CliBindingRowV1 } {
    this.validateReference(input);
    const record = this.requireBinding(input.reference.private_input_binding_id);
    const row = record.bindings.find((candidate) => candidate.input_id === input.input_id);
    if (!row)
      throw new CapabilityRuntimeError(
        `binding ${record.private_binding_id} does not contain ${input.input_id}`,
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    return { record, row };
  }

  private requireBinding(privateBindingId: string): CliBindingRecordV1 {
    if (!/^vf-private-input-binding-[a-f0-9]{64}$/u.test(privateBindingId))
      throw new CapabilityRuntimeError(
        "invalid private binding identifier",
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    const record = this.store.readBinding(this.store.bindingPath(privateBindingId));
    if (!record)
      throw new CapabilityRuntimeError(
        "private binding was not found",
        CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND,
      );
    if (
      record.private_binding_id !== privateBindingId ||
      record.binding_digest !==
        `sha256:${privateBindingId.slice("vf-private-input-binding-".length)}`
    ) {
      throw new CapabilityRuntimeError(
        "private binding record integrity mismatch",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    }
    return record;
  }

  private requireHead(identity: HeadIdentity) {
    const head = this.store.readHead(identity);
    if (!head)
      throw new CapabilityRuntimeError(
        `current private input head for ${identity.input_id} is unavailable`,
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return head;
  }

  private headIdentity(
    input: {
      scope: Scope;
      scope_identity_digest: string;
      package_id: string;
      package_pin_digest: string;
      manifest_digest: string;
    },
    inputId: string,
  ): HeadIdentity {
    return { ...this.packageIdentity(input), input_id: inputId };
  }

  private packageIdentity(input: {
    scope: Scope;
    scope_identity_digest: string;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
  }) {
    return {
      scope: input.scope,
      scope_identity_digest: input.scope_identity_digest,
      package_id: input.package_id,
      package_pin_digest: input.package_pin_digest,
      manifest_digest: input.manifest_digest,
    };
  }

  private assertScopeIdentity(scope: Scope, scopeIdentityDigest: string): void {
    assertPrivateInputScopeIdentity({
      expectedScope: this.scope,
      expectedIdentityDigest: this.scopeIdentityDigest,
      scope,
      scopeIdentityDigest,
    });
  }
}

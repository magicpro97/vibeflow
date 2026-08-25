import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  type ConversationControlActionTypeV1,
  type ConversationControlEffectPlanV1,
  type ConversationControlPostconditionBindingV1,
  type ConversationNativeReferenceBindingV1,
  assertConversationControlEffectPlan,
  assertConversationControlPostconditionBinding,
  assertConversationNativeReferenceBinding,
} from "./conversation-control-effect-types.js";
import { RevisionNativeBindingStore } from "./revision-native-binding-store.js";

const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function decode<T>(bytes: Buffer, validate: (value: unknown) => asserts value is T): T {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_OBJECT_BYTES }).equals(bytes))
    throw new Error("non-canonical conversation control object");
  return structuredClone(value);
}

export class ConversationControlEffectStore {
  private readonly objects: string;
  private readonly lock: string;
  private readonly nativeIdentifiers: RevisionNativeBindingStore;

  constructor(artifactRoot: string) {
    this.objects = ensurePrivateDirectory(join(resolve(artifactRoot), "objects", "v1"));
    this.lock = join(this.objects, "conversation-control.writer.lock");
    this.nativeIdentifiers = new RevisionNativeBindingStore(artifactRoot);
  }

  private write<T extends object>(
    value: T,
    digest: string,
    validate: (value: unknown) => void,
    lock: ProcessLock,
  ): void {
    validate(value);
    if (!DIGEST.test(digest)) throw new Error("invalid conversation control object digest");
    createOrVerifyPrivateFile(
      join(this.objects, `${digestHex(digest)}.json`),
      canonicalJsonBytes(value),
      { lock, maxBytes: MAX_OBJECT_BYTES },
    );
  }

  writeClosure(input: {
    plan: ConversationControlEffectPlanV1;
    native_references: ConversationNativeReferenceBindingV1[];
    postconditions: ConversationControlPostconditionBindingV1[];
  }): void {
    assertConversationControlEffectPlan(input.plan);
    const natives = new Map(input.native_references.map((row) => [row.binding_digest, row]));
    const conditions = new Map(input.postconditions.map((row) => [row.binding_digest, row]));
    if (
      natives.size !== input.native_references.length ||
      conditions.size !== input.postconditions.length ||
      input.plan.effects.length !== natives.size ||
      input.plan.effects.length !== conditions.size
    )
      throw new Error("conversation control effect closure cardinality changed");
    for (const effect of input.plan.effects) {
      const native = natives.get(effect.native_reference_digest);
      const condition = conditions.get(effect.expected_control_postcondition_digest);
      if (
        !native ||
        !condition ||
        native.target_operation_id !== input.plan.target_operation_id ||
        native.effect_id !== effect.effect_id ||
        native.participant_id !== effect.participant_id ||
        native.adapter_fingerprint !== effect.adapter_fingerprint ||
        condition.target_operation_id !== input.plan.target_operation_id ||
        condition.effect_id !== effect.effect_id
      )
        throw new Error("conversation control effect closure changed");
      if (
        native.private_reference_content_digest !== null &&
        !this.nativeIdentifiers.read(native.private_reference_content_digest)
      )
        throw new Error("conversation control private native reference is absent");
    }
    const lock = acquireProcessLock(this.lock, {
      operation: `conversation-control:${digestHex(input.plan.plan_digest)}`,
    });
    try {
      for (const native of input.native_references)
        this.write(native, native.binding_digest, assertConversationNativeReferenceBinding, lock);
      for (const condition of input.postconditions)
        this.write(
          condition,
          condition.binding_digest,
          assertConversationControlPostconditionBinding,
          lock,
        );
      this.write(input.plan, input.plan.plan_digest, assertConversationControlEffectPlan, lock);
    } finally {
      lock.release();
    }
  }

  readPlan(planDigest: string): ConversationControlEffectPlanV1 | null {
    if (!DIGEST.test(planDigest)) throw new Error("invalid conversation control effect plan ref");
    const bytes = privateFileBytes(
      join(this.objects, `${digestHex(planDigest)}.json`),
      MAX_OBJECT_BYTES,
    );
    if (bytes === null) return null;
    const plan = decode(bytes, assertConversationControlEffectPlan);
    if (plan.plan_digest !== planDigest)
      throw new Error("conversation control effect plan reference changed");
    this.assertClosure(plan);
    return plan;
  }

  assertForAction(input: {
    plan_digest: string;
    action_type: ConversationControlActionTypeV1;
    target_operation_id: string;
    expected_pre_effect_fold_digest: string;
    expected_operation_header_digest?: string;
  }): ConversationControlEffectPlanV1 {
    const plan = this.readPlan(input.plan_digest);
    if (!plan || plan.target_operation_id !== input.target_operation_id)
      throw new Error("conversation control effect plan target changed");
    if (input.action_type === "conversation.stop_operation" && plan.effects.length !== 1)
      throw new Error("conversation stop effect cardinality changed");
    for (const effect of plan.effects) {
      const native = this.readNativeReference(effect.native_reference_digest);
      const postcondition = this.readPostcondition(effect.expected_control_postcondition_digest);
      if (!native || !postcondition)
        throw new Error("conversation control effect closure disappeared");
      const reconcile = input.action_type === "conversation.reconcile_revision_operation";
      if (
        postcondition.expected_pre_effect_fold_digest !== input.expected_pre_effect_fold_digest ||
        (reconcile
          ? effect.effect_kind !== "reconcile"
          : effect.effect_kind !== "cancel-or-prove-quiescent") ||
        (reconcile
          ? postcondition.condition.kind !== "reconciliation-resolution"
          : input.action_type === "conversation.stop_operation"
            ? postcondition.condition.kind !== "operation-terminal"
            : postcondition.condition.kind !== "participant-quiescent")
      )
        throw new Error("conversation control postcondition changed");
      if (
        input.action_type === "conversation.stop_operation" &&
        (effect.participant_id !== null ||
          effect.adapter_fingerprint !== "vf-host-operation-cancel/1" ||
          effect.mode !== "idempotent-cancel" ||
          native.reference_kind !== "operation-cancel-authority" ||
          native.authority_record_digest !== input.expected_operation_header_digest ||
          native.private_reference_content_digest !== null)
      )
        throw new Error("conversation stop native authority changed");
      if (
        input.action_type !== "conversation.stop_operation" &&
        native.reference_kind !== "participant-start-receipt"
      )
        throw new Error("revision control native authority changed");
    }
    return plan;
  }

  assertClosure(plan: ConversationControlEffectPlanV1): void {
    for (const effect of plan.effects) {
      const native = this.readNativeReference(effect.native_reference_digest);
      const condition = this.readPostcondition(effect.expected_control_postcondition_digest);
      if (
        !native ||
        !condition ||
        native.target_operation_id !== plan.target_operation_id ||
        native.effect_id !== effect.effect_id ||
        native.participant_id !== effect.participant_id ||
        native.adapter_fingerprint !== effect.adapter_fingerprint ||
        condition.target_operation_id !== plan.target_operation_id ||
        condition.effect_id !== effect.effect_id ||
        (native.private_reference_content_digest !== null &&
          !this.nativeIdentifiers.read(native.private_reference_content_digest))
      )
        throw new Error("conversation control effect object closure changed");
    }
  }

  readNativeReference(bindingDigest: string): ConversationNativeReferenceBindingV1 | null {
    return this.readObject(
      bindingDigest,
      assertConversationNativeReferenceBinding,
      "conversation native reference",
    );
  }

  readPostcondition(bindingDigest: string): ConversationControlPostconditionBindingV1 | null {
    return this.readObject(
      bindingDigest,
      assertConversationControlPostconditionBinding,
      "conversation control postcondition",
    );
  }

  private readObject<T>(
    digest: string,
    validate: (value: unknown) => asserts value is T,
    label: string,
  ): T | null {
    if (!DIGEST.test(digest)) throw new Error(`invalid ${label} ref`);
    const bytes = privateFileBytes(
      join(this.objects, `${digestHex(digest)}.json`),
      MAX_OBJECT_BYTES,
    );
    if (bytes === null) return null;
    const value = decode(bytes, validate);
    const actual = (value as { binding_digest?: unknown }).binding_digest;
    if (actual !== digest) throw new Error(`${label} reference changed`);
    return value;
  }
}

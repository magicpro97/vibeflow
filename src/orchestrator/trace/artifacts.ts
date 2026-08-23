import { TRACE_LIMITS, utf8Bytes } from "./limits.js";
import {
  type OpaqueIdentityInput,
  type OpaqueKeyLimits,
  type OpaqueKeyring,
  opaqueAliases,
  opaqueRegistryKeyPath,
  openOpaqueKeyring,
  refreshOpaqueKeyring,
  reserveOpaqueIds,
  rotateOpaqueKeyring,
} from "./opaque-keyring.js";
import type { InternalTraceStoreRecord, OpaqueArtifactId, OpaqueSessionRef } from "./types.js";

export { opaqueRegistryKeyPath };

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
export const artifactReferenceKeys = new Set([
  "ref",
  "previous_ref",
  "input_ref",
  "output_ref",
  "decision_matrix_ref",
  "baseline_comparison_ref",
]);
export const artifactReferenceArrayKeys = new Set(["evidence_refs", "provenance_refs"]);

export interface ArtifactResolution {
  readonly internalRef: string;
}
export type ArtifactProjectionInput = Readonly<OpaqueIdentityInput>;
export interface ArtifactProjectionReservation {
  readonly ids: readonly (OpaqueArtifactId | OpaqueSessionRef)[];
  commit(): void;
  rollback(): void;
}
export interface ArtifactProjectionAuthority extends ArtifactProjectionReservation {
  id(kind: ArtifactProjectionInput["kind"], value: string): OpaqueArtifactId | OpaqueSessionRef;
}
export interface ArtifactRegistry {
  register(conversationId: string, internalRef: string): OpaqueArtifactId;
  resolve(conversationId: string, opaqueId: string): ArtifactResolution | null;
  sessionRef?(conversationId: string, nativeSessionId: string): OpaqueSessionRef;
  prepareProjection?(inputs: readonly ArtifactProjectionInput[]): ArtifactProjectionReservation;
}
export interface ArtifactRegistryLimits extends OpaqueKeyLimits {
  maxConversations: number;
  maxReferencesPerConversation: number;
  maxTotalReferences: number;
}
export interface DurableArtifactRegistryOptions {
  dir: string;
  limits?: Partial<ArtifactRegistryLimits>;
}
export interface ArtifactRegistryPreparation {
  commit(): void;
  rollback(): void;
}
export interface RebuildableArtifactRegistry extends ArtifactRegistry {
  rebuild(records: readonly InternalTraceStoreRecord[]): void;
  rebuildConversation?(id: string, records: readonly InternalTraceStoreRecord[]): void;
  index?(records: readonly InternalTraceStoreRecord[]): void;
  prepare?(records: readonly InternalTraceStoreRecord[]): ArtifactRegistryPreparation;
}

const defaults: ArtifactRegistryLimits = {
  maxConversations: 1_024,
  maxReferencesPerConversation: 16_384,
  maxTotalReferences: 32_768,
  maxRetiredKeys: 8,
  maxAssignments: 65_536,
};
const registryError = (message: string): never => {
  throw new Error(`artifact registry: ${message}`);
};
const boundedInteger = (value: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= maximum;
const validateLimits = (
  requested: Partial<ArtifactRegistryLimits> = {},
): ArtifactRegistryLimits => {
  const limits = { ...defaults, ...requested };
  if (
    !boundedInteger(limits.maxConversations, 65_536) ||
    !boundedInteger(limits.maxReferencesPerConversation, 65_536) ||
    !boundedInteger(limits.maxTotalReferences, 131_072) ||
    limits.maxReferencesPerConversation > limits.maxTotalReferences
  )
    registryError("invalid registry limits");
  return Object.freeze(limits);
};
const validateDomain = (conversationId: string, value: string): void => {
  if (
    typeof conversationId !== "string" ||
    !conversationId ||
    utf8Bytes(conversationId) > TRACE_LIMITS.maxReferenceBytes
  )
    registryError("invalid conversation domain");
  if (typeof value !== "string" || utf8Bytes(value) > TRACE_LIMITS.maxReferenceBytes)
    registryError("invalid registry reference");
};
const identityKey = ({ kind, conversationId, value }: OpaqueIdentityInput): string =>
  JSON.stringify([kind, conversationId, value]);

export function prepareArtifactProjection(
  registry: ArtifactRegistry,
  conversationId: string,
  inputs: readonly ArtifactProjectionInput[],
): ArtifactProjectionAuthority {
  const unique = new Map<string, ArtifactProjectionInput>();
  for (const input of inputs) {
    if (input.conversationId !== conversationId)
      throw new Error("public trace: conversation context mismatch");
    unique.set(identityKey(input), input);
  }
  const identities = [...unique.values()];
  if (!identities.length) throw new Error("public trace: invalid registry reservation");
  if (typeof registry.prepareProjection !== "function") {
    if (identities.length !== 1)
      throw new Error("public trace: atomic projection registry required");
    const input = identities[0] as ArtifactProjectionInput;
    const key = identityKey(input);
    let id: OpaqueArtifactId | OpaqueSessionRef;
    if (input.kind === "artifact") id = registry.register(input.conversationId, input.value);
    else {
      if (!registry.sessionRef) throw new Error("public trace: artifact registry required");
      id = registry.sessionRef(input.conversationId, input.value);
    }
    return {
      ids: [id],
      id(kind, value) {
        if (identityKey({ kind, conversationId, value }) !== key)
          throw new Error("public trace: missing registry reservation");
        return id;
      },
      commit() {},
      rollback() {},
    };
  }
  let prepared: ArtifactProjectionReservation | undefined;
  try {
    prepared = registry.prepareProjection(identities);
    if (!prepared || prepared.ids.length !== identities.length)
      throw new Error("public trace: invalid registry reservation");
    const ids = new Map<string, OpaqueArtifactId | OpaqueSessionRef>();
    const identityById = new Map<string, string>();
    identities.forEach((input, index) => {
      const id = prepared?.ids[index];
      if (typeof id !== "string" || !id) throw new Error("public trace: invalid opaque id");
      const key = identityKey(input);
      const oldId = ids.get(key);
      if (oldId !== undefined && oldId !== id)
        throw new Error("public trace: inconsistent opaque id");
      const oldIdentity = identityById.get(id);
      if (oldIdentity !== undefined && oldIdentity !== key)
        throw new Error("public trace: opaque id collision");
      ids.set(key, id);
      identityById.set(id, key);
    });
    return {
      ids: [...ids.values()],
      id(kind, value) {
        const id = ids.get(identityKey({ kind, conversationId, value }));
        if (!id) throw new Error("public trace: missing registry reservation");
        return id;
      },
      commit: prepared.commit,
      rollback: prepared.rollback,
    };
  } catch (error) {
    prepared?.rollback();
    throw error;
  }
}

function collectRecords(records: readonly InternalTraceStoreRecord[]): OpaqueIdentityInput[] {
  const found = new Map<string, OpaqueIdentityInput>();
  const visit = (value: unknown, conversationId: string, key?: string): void => {
    if (typeof value === "string") {
      if (artifactReferenceKeys.has(key ?? "")) {
        const input = { kind: "artifact", conversationId, value } as const;
        found.set(identityKey(input), input);
      } else if (key === "public_session_ref") {
        const input = { kind: "session", conversationId, value } as const;
        found.set(identityKey(input), input);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (artifactReferenceArrayKeys.has(key ?? "")) {
        for (const item of value)
          if (typeof item === "string") {
            const input = { kind: "artifact", conversationId, value: item } as const;
            found.set(identityKey(input), input);
          }
      } else for (const item of value) visit(item, conversationId);
      return;
    }
    for (const [name, item] of Object.entries(value as Record<string, unknown>))
      if (!unsafeKeys.has(name)) visit(item, conversationId, name);
  };
  for (const record of records) {
    const conversationId = record.stored_event.conversation_id;
    visit(record.stored_event, conversationId);
    if (record.native_session_id !== null) {
      const input = { kind: "session", conversationId, value: record.native_session_id } as const;
      found.set(identityKey(input), input);
    }
  }
  return [...found.values()];
}

export class DurableArtifactRegistry implements RebuildableArtifactRegistry {
  private keyring: OpaqueKeyring;
  private readonly reverse = new Map<string, Map<string, string>>();
  private readonly references = new Map<string, Set<string>>();
  private totalReferences = 0;
  private readonly limits: ArtifactRegistryLimits;

  constructor(options: DurableArtifactRegistryOptions) {
    this.limits = validateLimits(options.limits);
    this.keyring = openOpaqueKeyring(options.dir, this.limits);
  }
  private refresh(): void {
    this.keyring = refreshOpaqueKeyring(this.keyring);
  }
  private preflight(inputs: readonly OpaqueIdentityInput[]): void {
    const additions = new Map<string, Set<string>>();
    for (const input of inputs) {
      if (input.kind !== "artifact" && input.kind !== "session")
        registryError("invalid registry reference");
      validateDomain(input.conversationId, input.value);
      if (input.kind !== "artifact" || this.references.get(input.conversationId)?.has(input.value))
        continue;
      let values = additions.get(input.conversationId);
      if (!values) {
        values = new Set();
        additions.set(input.conversationId, values);
      }
      values.add(input.value);
    }
    const newConversations = [...additions].filter(([id]) => !this.references.has(id)).length;
    if (this.references.size + newConversations > this.limits.maxConversations)
      registryError("conversation limit reached");
    let added = 0;
    for (const [id, values] of additions) {
      const current = this.references.get(id)?.size ?? 0;
      if (current + values.size > this.limits.maxReferencesPerConversation)
        registryError("reference limit reached");
      added += values.size;
    }
    if (this.totalReferences + added > this.limits.maxTotalReferences)
      registryError("total reference limit reached");
  }
  private remember(input: OpaqueIdentityInput, id: string): void {
    if (input.kind !== "artifact") return;
    let references = this.references.get(input.conversationId);
    if (!references) {
      references = new Set();
      this.references.set(input.conversationId, references);
    }
    if (!references.has(input.value)) {
      references.add(input.value);
      this.totalReferences++;
    }
    let reverse = this.reverse.get(input.conversationId);
    if (!reverse) {
      reverse = new Map();
      this.reverse.set(input.conversationId, reverse);
    }
    const old = reverse.get(id);
    if (old !== undefined && old !== input.value) registryError("opaque id collision");
    reverse.set(id, input.value);
  }
  private reserve(inputs: readonly OpaqueIdentityInput[]): {
    ids: string[];
    commit(): void;
    rollback(): void;
  } {
    this.refresh();
    this.preflight(inputs);
    const reservation = reserveOpaqueIds(this.keyring, inputs);
    return {
      ids: reservation.ids,
      commit: () => {
        this.keyring = reservation.commit();
        inputs.forEach((input, index) => this.remember(input, reservation.ids[index] as string));
      },
      rollback: reservation.rollback,
    };
  }
  register(conversationId: string, internalRef: string): OpaqueArtifactId {
    const input = { kind: "artifact", conversationId, value: internalRef } as const;
    const prepared = this.reserve([input]);
    prepared.commit();
    return prepared.ids[0] as OpaqueArtifactId;
  }
  sessionRef(conversationId: string, nativeSessionId: string): OpaqueSessionRef {
    const prepared = this.reserve([{ kind: "session", conversationId, value: nativeSessionId }]);
    prepared.commit();
    return prepared.ids[0] as OpaqueSessionRef;
  }
  prepareProjection(inputs: readonly ArtifactProjectionInput[]): ArtifactProjectionReservation {
    const prepared = this.reserve(inputs);
    return {
      ids: prepared.ids as (OpaqueArtifactId | OpaqueSessionRef)[],
      commit: prepared.commit,
      rollback: prepared.rollback,
    };
  }
  resolve(conversationId: string, opaqueId: string): ArtifactResolution | null {
    if (!/^artifact_[A-Za-z0-9_-]{43}$/.test(opaqueId) || !conversationId) return null;
    this.refresh();
    const direct = this.reverse.get(conversationId)?.get(opaqueId);
    if (direct !== undefined) return { internalRef: direct };
    for (const internalRef of this.references.get(conversationId) ?? []) {
      const input = { kind: "artifact", conversationId, value: internalRef } as const;
      if (!opaqueAliases(this.keyring, input).includes(opaqueId)) continue;
      let reverse = this.reverse.get(conversationId);
      if (!reverse) {
        reverse = new Map();
        this.reverse.set(conversationId, reverse);
      }
      reverse.set(opaqueId, internalRef);
      return { internalRef };
    }
    return null;
  }
  rotate(): void {
    this.keyring = rotateOpaqueKeyring(this.keyring);
  }
  prepare(records: readonly InternalTraceStoreRecord[]): ArtifactRegistryPreparation {
    const inputs = collectRecords(records);
    if (!inputs.length) return { commit() {}, rollback() {} };
    const prepared = this.reserve(inputs);
    return { commit: prepared.commit, rollback: prepared.rollback };
  }
  index(records: readonly InternalTraceStoreRecord[]): void {
    const prepared = this.prepare(records);
    prepared.commit();
  }
  rebuild(records: readonly InternalTraceStoreRecord[]): void {
    const grouped = new Map<string, InternalTraceStoreRecord[]>();
    for (const record of records) {
      const id = record.stored_event.conversation_id;
      let group = grouped.get(id);
      if (!group) {
        group = [];
        grouped.set(id, group);
      }
      group.push(record);
    }
    for (const [id, group] of grouped) this.rebuildConversation(id, group);
  }
  rebuildConversation(id: string, records: readonly InternalTraceStoreRecord[]): void {
    if (records.some((record) => record.stored_event.conversation_id !== id))
      registryError("conversation rebuild mismatch");
    const old = this.references.get(id);
    if (old) this.totalReferences -= old.size;
    this.references.delete(id);
    this.reverse.delete(id);
    try {
      this.index(records);
    } catch (error) {
      if (old) {
        this.references.set(id, old);
        this.totalReferences += old.size;
      }
      throw error;
    }
  }
}

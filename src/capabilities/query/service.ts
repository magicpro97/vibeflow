import { existsSync, readFileSync } from "node:fs";
import { PUBLIC_RECOVERY_ACTION } from "../../actions/public-error-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  CAPABILITY_STATUS,
  type CapabilityScope,
  type CapabilityStatusV1,
} from "../../core/capability-contract.js";
import { canonicalJson, digestV1, privateFileBytes } from "../../durability/index.js";
import type { CapabilityEffectBrokerV1 } from "../adapters/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityRuntimeAuthorityReaderV1 } from "../operations/types.js";
import {
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityObjectPath,
} from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityHealthCurrentV1, CapabilityHealthInventoryV1 } from "../storage/types.js";
import { CAPABILITY_LOCK_TARGET_STATE, type CapabilityLockedTargetV1 } from "../wire/lock.js";
import type {
  CapabilityBrowserDetailResponseV1,
  CapabilityQueryItemV1,
  CapabilityQueryResponseV1,
} from "../wire/query.js";
import {
  StaleCapabilityCursorErrorV1,
  decodeCapabilityCursor,
  encodeCapabilityCursor,
} from "./cursor.js";
import { projectCapabilityDetail } from "./detail.js";
import type {
  CapabilityDetailRequestV1,
  CapabilityDiscoveryEntryV1,
  CapabilityDiscoveryReaderV1,
  CapabilityPackageReaderV1,
  CapabilityPrivateInputPresenceReaderV1,
  CapabilityQueryRequestV1,
} from "./types.js";

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
}

export class CapabilityQueryServiceV1 {
  constructor(
    readonly options: {
      storage: CapabilityStorageV1;
      authority: CapabilityRuntimeAuthorityReaderV1;
      broker: CapabilityEffectBrokerV1;
      discovery?: CapabilityDiscoveryReaderV1;
      packages?: CapabilityPackageReaderV1;
      privateInputs?: CapabilityPrivateInputPresenceReaderV1;
    },
  ) {}

  query(request: CapabilityQueryRequestV1): CapabilityQueryResponseV1 {
    if (request.scope !== this.options.storage.paths.scope)
      throw new CapabilityRuntimeError(
        "capability query scope is not owned by this service instance",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const status = this.options.storage.readStatus();
    if (status.state === "corrupt")
      throw new CapabilityRuntimeError(
        "capability lock is corrupt",
        CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      );
    const authority = this.options.authority.read(request.scope);
    const discovery =
      request.view === "search" || request.view === "detail"
        ? (this.options.discovery?.read() ?? {
            generation_digest: null,
            offline: true,
            entries: [],
          })
        : null;
    const health = status.lock ? this.healthInventory(status.lock.content_digest) : null;
    const source_watermark = digestV1("VF-CAPABILITY-BROWSER-QUERY-SOURCE\0v1\0", {
      schema_version: "1.0",
      view: request.view,
      scope: request.scope,
      scope_identity_digest: authority.scope_identity_digest,
      discovery_generation_digest: discovery?.generation_digest ?? null,
      capability_lock_digest: status.lock?.content_digest ?? null,
      authority_head_digest: authority.authority_head_digest,
      health_inventory_digest: health?.inventory_digest ?? null,
    });
    const needle = normalize(request.query ?? request.package_id);
    const normalized = canonicalJson({
      view: request.view,
      scope: request.scope,
      query: needle,
      package_id: request.package_id ?? null,
      engines: [...(request.engines ?? [])].sort(),
      statuses: [...(request.statuses ?? [])].sort(),
    });
    let offset = 0;
    if (request.cursor) {
      const cursor = decodeCapabilityCursor(request.cursor);
      if (cursor.source_watermark !== source_watermark || cursor.normalized_query !== normalized)
        throw new StaleCapabilityCursorErrorV1(
          encodeCapabilityCursor({
            schema_version: "1.0",
            source_watermark,
            normalized_query: normalized,
            offset: 0,
          }),
          source_watermark,
        );
      offset = cursor.offset;
    }
    const unfiltered =
      request.view === "search" || request.view === "detail"
        ? this.discoveryItems(discovery?.entries ?? [], request, needle)
        : this.lockItems(status.lock, request, health);
    const items = (
      request.statuses?.length
        ? unfiltered.filter((item) => request.statuses?.includes(item.status))
        : unfiltered
    ).sort((left, right) =>
      canonicalJson([
        left.package_id,
        left.version ?? "",
        left.scope ?? "",
        left.package_pin_digest ?? "",
        left.discovery_entry_digest ?? "",
      ]).localeCompare(
        canonicalJson([
          right.package_id,
          right.version ?? "",
          right.scope ?? "",
          right.package_pin_digest ?? "",
          right.discovery_entry_digest ?? "",
        ]),
        "en-US",
      ),
    );
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const page = items.slice(offset, offset + limit);
    const next =
      offset + page.length < items.length
        ? encodeCapabilityCursor({
            schema_version: "1.0",
            source_watermark,
            normalized_query: normalized,
            offset: offset + page.length,
          })
        : null;
    return { schema_version: "1.0", items: page, next_cursor: next, source_watermark };
  }

  detail(request: CapabilityDetailRequestV1): CapabilityBrowserDetailResponseV1 {
    const response = this.query({
      view: "detail",
      scope: request.scope,
      package_id: request.package_id,
      limit: 200,
    });
    return projectCapabilityDetail({
      request,
      items: response.items,
      source_watermark: response.source_watermark,
      lock: this.options.storage.readStatus().lock,
      packages: this.options.packages,
      privateInputs: this.options.privateInputs,
    });
  }

  status(input: { scope: CapabilityScope; package_id?: string }): CapabilityQueryResponseV1 {
    return this.query({ view: "status", ...input });
  }

  discover(input: {
    scope: CapabilityScope;
    query?: string;
    engines?: import("../../actions/types.js").EngineName[];
    cursor?: string | null;
    limit?: number;
  }): CapabilityQueryResponseV1 {
    return this.query({ view: "search", ...input });
  }

  private lockItems(
    lock: ReturnType<CapabilityStorageV1["readStatus"]>["lock"],
    request: CapabilityQueryRequestV1,
    health: CapabilityHealthInventoryV1 | null,
  ): CapabilityQueryItemV1[] {
    const entries = lock?.packages ?? [];
    const filtered = request.package_id
      ? entries.filter((entry) => entry.package_id === request.package_id)
      : entries;
    if (filtered.length === 0 && request.view === "status" && request.package_id)
      return [this.absentItem(request.package_id)];
    return filtered.map((entry) => {
      const targets = entry.targets.map((target) => {
        const status = this.targetStatus(target);
        return {
          target_id: target.target_id,
          component_id: target.component_id,
          engine: target.engine,
          participant_id: target.participant_id,
          required: target.required,
          status,
          health_digest:
            health?.packages.find((row) => row.package_id === entry.package_id)?.health_digest ??
            null,
        };
      });
      const required = targets.filter((target) => target.required);
      const evaluated = required.length > 0 ? required : targets;
      const bad = evaluated.find((target) => target.status !== CAPABILITY_STATUS.READY);
      const optionalBad = targets.some(
        (target) => !evaluated.includes(target) && target.status !== CAPABILITY_STATUS.READY,
      );
      const status: CapabilityStatusV1 =
        bad?.status ?? (optionalBad ? CAPABILITY_STATUS.DEGRADED : CAPABILITY_STATUS.READY);
      return {
        package_id: entry.package_id,
        discovery_entry_digest: null,
        display_name: entry.package_id,
        summary: "Installed CLI capability",
        version: entry.pin.version,
        package_pin_digest: entry.pin.pin_digest,
        content_sha256: entry.pin.content_sha256,
        scope: lock?.scope ?? null,
        status,
        source_kind: entry.pin.source.kind,
        source_trust: entry.pin.trust,
        scan_status: "not-applicable" as const,
        cache_status: "available" as const,
        generation_id: lock?.generation_id ?? null,
        targets,
        recovery_actions:
          status === CAPABILITY_STATUS.DRIFTED ? [PUBLIC_RECOVERY_ACTION.REPAIR] : [],
      };
    });
  }

  private targetStatus(target: CapabilityLockedTargetV1): CapabilityStatusV1 {
    for (const projection of target.projections) {
      const bytes = privateFileBytes(
        capabilityObjectPath(this.options.storage.paths, projection.projection_digest),
        512 * 1024,
      );
      if (!bytes) return CAPABILITY_STATUS.BLOCKED;
      const binding = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
        ownership_key?: unknown;
        expected_postimage_sha256?: unknown;
      };
      if (
        binding.ownership_key !== projection.ownership_key ||
        typeof binding.expected_postimage_sha256 !== "string"
      )
        return CAPABILITY_STATUS.BLOCKED;
      const observed = this.options.broker.inspect({
        ownership_key: projection.ownership_key,
        kind: "managed-registration",
        public_target: projection.ownership_key,
      });
      if (observed.content_sha256 !== binding.expected_postimage_sha256)
        return CAPABILITY_STATUS.DRIFTED;
    }
    return target.state === CAPABILITY_LOCK_TARGET_STATE.DEGRADED
      ? CAPABILITY_STATUS.DEGRADED
      : CAPABILITY_STATUS.READY;
  }

  private discoveryItems(
    entries: CapabilityDiscoveryEntryV1[],
    request: CapabilityQueryRequestV1,
    normalized: string,
  ): CapabilityQueryItemV1[] {
    return entries
      .filter(
        (entry) =>
          !normalized ||
          normalize(
            `${entry.package_id} ${entry.metadata.display_name} ${entry.metadata.summary}`,
          ).includes(normalized),
      )
      .filter(
        (entry) => request.package_id === undefined || entry.package_id === request.package_id,
      )
      .filter(
        (entry) =>
          !request.engines?.length ||
          request.engines.some((engine) => entry.compatible_engines.includes(engine)),
      )
      .map((entry) => ({
        package_id: entry.package_id,
        discovery_entry_digest: entry.entry_digest,
        display_name: entry.metadata.display_name,
        summary: entry.metadata.summary,
        version: entry.version,
        package_pin_digest: entry.pin.pin_digest,
        content_sha256: entry.pin.content_sha256,
        scope: null,
        status:
          entry.scan_status === "failed"
            ? CAPABILITY_STATUS.BLOCKED
            : entry.stale
              ? CAPABILITY_STATUS.STALE
              : CAPABILITY_STATUS.ABSENT,
        source_kind: entry.pin.source.kind,
        source_trust: entry.pin.trust,
        scan_status: entry.scan_status,
        cache_status: entry.cache_status,
        generation_id: null,
        targets: [],
        recovery_actions:
          entry.scan_status === "failed" ? [PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN] : [],
      }));
  }

  private absentItem(packageId: string): CapabilityQueryItemV1 {
    return {
      package_id: packageId,
      discovery_entry_digest: null,
      display_name: packageId,
      summary: "Capability is not installed",
      version: null,
      package_pin_digest: null,
      content_sha256: null,
      scope: null,
      status: CAPABILITY_STATUS.ABSENT,
      source_kind: null,
      source_trust: null,
      scan_status: "not-applicable",
      cache_status: "not-applicable",
      generation_id: null,
      targets: [],
      recovery_actions: [],
    };
  }

  private healthInventory(lockDigest: string): CapabilityHealthInventoryV1 | null {
    const pointerPath = capabilityHealthCurrentPath(this.options.storage.paths);
    if (!existsSync(pointerPath)) return null;
    const pointer = parseStrictJson(
      readFileSync(pointerPath, "utf8"),
    ) as unknown as CapabilityHealthCurrentV1;
    const inventoryPath = capabilityHealthInventoryPath(
      this.options.storage.paths,
      pointer.inventory_digest,
    );
    if (!existsSync(inventoryPath)) return null;
    const inventory = parseStrictJson(
      readFileSync(inventoryPath, "utf8"),
    ) as unknown as CapabilityHealthInventoryV1;
    return inventory.capability_lock_digest === lockDigest ? inventory : null;
  }
}

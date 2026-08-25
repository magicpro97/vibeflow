import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngineName } from "../actions/types.js";
import { digestV1 } from "../durability/index.js";
import type {
  CapabilityDiscoveryEntryV1,
  CapabilityDiscoveryReaderV1,
  CapabilityDiscoverySnapshotV1,
} from "./query/types.js";
import { packageRecordCachePath } from "./source/package-cache-paths.js";
import type { FilesystemCapabilityPackageCacheV1 } from "./source/package-cache-reader.js";
import { CapabilityValidationError, bytewise } from "./wire/primitives.js";

const ENGINES: EngineName[] = ["antigravity", "claude", "codex", "copilot", "opencode"];

/** Deterministic offline discovery projected only from fully validated retained packages. */
export class FilesystemCapabilityDiscoveryReaderV1 implements CapabilityDiscoveryReaderV1 {
  constructor(readonly packages: FilesystemCapabilityPackageCacheV1) {}

  read(): CapabilityDiscoverySnapshotV1 {
    const root = dirname(
      packageRecordCachePath(this.packages.options.privateRoot, digestV1("VF-CACHE-SCAN\0v1\0", 0)),
    );
    let names: string[];
    try {
      names = readdirSync(root)
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .sort(bytewise);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          generation_digest: digestV1("VF-CAPABILITY-OFFLINE-DISCOVERY\0v1\0", []),
          offline: true,
          entries: [],
        };
      throw error;
    }
    if (names.length > 10_000)
      throw new CapabilityValidationError(
        "package cache record count exceeds bound",
        "package_records",
        "bounds",
      );
    const entries = names.map((name) => {
      const resolved = this.packages.readByPin(`sha256:${name.slice(0, -5)}`);
      if (!resolved)
        throw new CapabilityValidationError("scanned package record disappeared", name);
      const compatible = Object.keys(resolved.manifest.compatibility.engines)
        .filter((engine): engine is EngineName => ENGINES.includes(engine as EngineName))
        .sort(bytewise);
      const draft = {
        package_id: resolved.pin.id,
        version: resolved.pin.version,
        pin: resolved.pin,
        manifest_digest: resolved.manifest_digest,
        metadata: resolved.manifest.metadata,
        compatible_engines: compatible,
        scan_status: "passed" as const,
        cache_status: "available" as const,
        stale: false,
      };
      return {
        ...draft,
        entry_digest: digestV1("VF-CAPABILITY-DISCOVERY-ENTRY\0v1\0", draft),
      } satisfies CapabilityDiscoveryEntryV1;
    });
    entries.sort((left, right) =>
      bytewise(
        `${left.package_id}\0${left.version}\0${left.pin.pin_digest}`,
        `${right.package_id}\0${right.version}\0${right.pin.pin_digest}`,
      ),
    );
    return {
      generation_digest: digestV1(
        "VF-CAPABILITY-OFFLINE-DISCOVERY\0v1\0",
        entries.map((entry) => entry.entry_digest),
      ),
      offline: true,
      entries,
    };
  }
}

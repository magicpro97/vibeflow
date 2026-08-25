export interface CapabilityHealthInventoryV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  capability_generation_id: string | null;
  capability_lock_digest: string | null;
  packages: Array<{ package_id: string; lock_entry_digest: string; health_digest: string }>;
  inventory_digest: string;
}

export interface CapabilityHealthCurrentV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  inventory_epoch: number;
  inventory_digest: string;
  pointer_digest: string;
}

export interface CapabilityReadStatusV1 {
  scope: "project" | "user";
  state: "absent" | "ready" | "unsupported" | "corrupt" | "locked";
  lock: import("../wire/lock.js").CapabilityLockV1 | null;
  error: string | null;
}

export interface CapabilityObjectDigestSpecV1 {
  domain: string;
  omit_keys: string[];
}

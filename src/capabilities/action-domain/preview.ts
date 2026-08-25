import type { ActionRisk, HostRenderedPreviewV1, RecoveryAction } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityFabricPlanV1, CapabilityHostActionV1 } from "../planning/types.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";

const RECOVERY_ORDER: readonly RecoveryAction[] = [
  "retry",
  "edit",
  "refresh-proposal",
  "restart-pagination",
  "complete-challenge",
  "select-lineage-head",
  "rebuild-catalog",
  "resume-by-id",
  "inspect-trace",
  "resolve-again",
  "rollback",
  "repair",
  "repair-authority",
  "verified-abandon",
  "reconcile-revision",
  "adopt",
  "renew-grant",
  "authorize-source",
  "disable",
  "retarget",
  "complete-manual-step",
  "export-redacted-diagnostics",
];

function packagePins(plan: CapabilityFabricPlanV1) {
  return plan.runtime_closure.packages.map(({ pin }) => ({
    id: pin.id,
    version: pin.version,
    source_kind: pin.source.kind,
    content_sha256: pin.content_sha256,
    trust: pin.trust,
    nonportable: pin.nonportable,
    pin_digest: pin.pin_digest,
  }));
}

function dependencies(plan: CapabilityFabricPlanV1, base: CapabilityLockV1 | null) {
  const before = new Map((base?.packages ?? []).map((row) => [row.package_id, row.pin.version]));
  const after = new Map(plan.runtime_closure.packages.map((row) => [row.pin.id, row.pin.version]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .map((package_id) => {
      const from = before.get(package_id) ?? null;
      const to = after.get(package_id) ?? null;
      const change =
        from === null ? "add" : to === null ? "remove" : from === to ? "unchanged" : "update";
      return { package_id, change, from_version: from, to_version: to } as const;
    })
    .sort((left, right) =>
      bytewise(
        `${left.package_id}\0${left.change}\0${left.from_version ?? ""}\0${left.to_version ?? ""}`,
        `${right.package_id}\0${right.change}\0${right.from_version ?? ""}\0${right.to_version ?? ""}`,
      ),
    );
}

function configDiffs(plan: CapabilityFabricPlanV1) {
  const rows = new Map<
    string,
    {
      target: string;
      target_ids: string[];
      mode: "surgical" | "full-file" | "manual";
      resources: Array<{
        ownership_key: string;
        before: string | null;
        after: string | null;
      }>;
    }
  >();
  for (const descriptor of plan.runtime_closure.descriptors) {
    if (descriptor.descriptor_kind !== "intent") continue;
    const mode =
      descriptor.resource.kind === "config-key"
        ? "surgical"
        : descriptor.resource.kind === "external-effect"
          ? "manual"
          : "full-file";
    const key = `${descriptor.resource.public_target}\0${mode}`;
    const row = rows.get(key) ?? {
      target: descriptor.resource.public_target,
      target_ids: [],
      mode,
      resources: [],
    };
    row.target_ids.push(descriptor.target_id);
    row.resources.push({
      ownership_key: descriptor.resource.ownership_key,
      before: descriptor.resource.expected_preimage_sha256,
      after: descriptor.resource.expected_postimage_sha256,
    });
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => {
      const resources = row.resources.sort((a, b) => bytewise(a.ownership_key, b.ownership_key));
      return {
        target: row.target,
        target_ids: [...new Set(row.target_ids)].sort(bytewise),
        mode: row.mode,
        before_digest: digestV1("VF-CAPABILITY-PREVIEW-CONFIG-BEFORE\0v1\0", resources),
        after_digest: digestV1("VF-CAPABILITY-PREVIEW-CONFIG-AFTER\0v1\0", resources),
        bounded_before: null,
        bounded_after: null,
      };
    })
    .sort((left, right) =>
      bytewise(`${left.target}\0${left.mode}`, `${right.target}\0${right.mode}`),
    );
}

function enforcement(plan: CapabilityFabricPlanV1) {
  const rows = new Map<string, HostRenderedPreviewV1["enforcement"][number]>();
  for (const permission of plan.permission_binding.permissions) {
    for (const targetId of permission.target_ids) {
      const engine = plan.targets.find((row) => row.target_id === targetId)?.target.engine;
      if (!engine) continue;
      const key = `${permission.permission_id}\0${engine}\0${permission.enforcement}`;
      rows.set(key, {
        permission_id: permission.permission_id,
        engine,
        enforcement: permission.enforcement,
        explanation: `The ${engine} capability adapter enforces this permission.`,
      });
    }
  }
  return [...rows.entries()].sort(([left], [right]) => bytewise(left, right)).map(([, row]) => row);
}

function health(plan: CapabilityFabricPlanV1): HostRenderedPreviewV1["health_plan"] {
  return plan.adapter_plans
    .flatMap((adapterPlan) => adapterPlan.health_plan.map((row) => structuredClone(row)))
    .sort((left, right) =>
      bytewise(
        `${left.probe_id}\0${left.target_ids.join("\0")}`,
        `${right.probe_id}\0${right.target_ids.join("\0")}`,
      ),
    );
}

function recovery(plan: CapabilityFabricPlanV1): RecoveryAction[] {
  const selected = new Set<RecoveryAction>([
    "retry",
    "rollback",
    "repair",
    "export-redacted-diagnostics",
  ]);
  if (plan.target_dispositions.some((row) => row.execution !== "host"))
    selected.add("complete-manual-step");
  return RECOVERY_ORDER.filter((row) => selected.has(row));
}

function title(action: CapabilityHostActionV1): string {
  return `${action.type
    .slice("capability.".length)
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase())} capability`;
}

export function materializeCapabilityPreview(input: {
  action: CapabilityHostActionV1;
  plan: CapabilityFabricPlanV1;
  base: CapabilityLockV1 | null;
}): HostRenderedPreviewV1 {
  const { action, plan, base } = input;
  const rules = digestV1("VF-CAPABILITY-ACTION-PREVIEW-RULES\0v1\0", {
    schema_version: "1.0",
    action_type: action.type,
    adapter_registry_digest: plan.adapter_registry_digest,
  });
  const preview: HostRenderedPreviewV1 = {
    title: title(action),
    summary: `Review the immutable ${action.type} plan before any capability effect runs.`,
    action_type: action.type,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    review_fields: [],
    targets: structuredClone(plan.targets),
    target_dispositions: structuredClone(plan.target_dispositions),
    package_pins: packagePins(plan),
    permission_delta: structuredClone(plan.permission_delta),
    dependency_delta: dependencies(plan, base),
    config_diffs: configDiffs(plan),
    effect_classes: [...plan.effect_classes],
    enforcement: enforcement(plan),
    reversibility: plan.reversibility,
    health_plan: health(plan),
    recovery_actions: recovery(plan),
    projector_version: "vf-public-projector/1",
    rules_digest: rules,
    redaction_manifest_digest: digestV1("VF-CAPABILITY-ACTION-REDACTION-MANIFEST\0v1\0", {
      schema_version: "1.0",
      rules_digest: rules,
      action_type: action.type,
      private_input_binding_digests: plan.runtime_closure.packages
        .map((row) => row.private_input_binding_digest)
        .sort(bytewise),
    }),
  };
  return preview;
}

export function capabilityPreviewRisk(
  preview: HostRenderedPreviewV1,
  scope: "project" | "user",
  actionType: string,
): ActionRisk {
  const effects = new Map([
    ["pure-local-read", 0],
    ["local-read-with-cache", 0],
    ["network-read", 0],
    ["process-probe", 0],
    ["project-write", 1],
    ["user-write", 2],
    ["external-compensatable", 2],
    ["external-irreversible", 3],
  ]);
  let rank = actionType === "capability.adopt" ? 2 : 1;
  for (const effect of preview.effect_classes) rank = Math.max(rank, effects.get(effect) ?? 4);
  rank = Math.max(
    rank,
    { reversible: 0, compensatable: 1, manual: 2, irreversible: 3 }[preview.reversibility],
  );
  if (
    scope === "user" ||
    preview.package_pins.some((pin) => ["dev-unverified", "legacy-verified"].includes(pin.trust)) ||
    preview.permission_delta.some((row) => ["add", "expand"].includes(row.change)) ||
    preview.enforcement.some((row) => row.enforcement === "disclosed-not-enforced") ||
    preview.config_diffs.some((row) => ["full-file", "manual"].includes(row.mode))
  )
    rank = Math.max(rank, 2);
  if (rank > 3) throw new Error("capability preview contains an unknown effect class");
  return (["low", "medium", "high", "critical"] as const)[rank] as ActionRisk;
}

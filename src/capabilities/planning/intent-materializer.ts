import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import type { PackageSelectorV1 } from "../../actions/request-types.js";
import type {
  CapabilityIntentMaterializerV1 as CapabilityIntentMaterializerContractV1,
  CapabilityIntentPreparationRequestV1,
} from "../controller.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { resolveDependencies } from "../source/resolver.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import {
  type CapabilityPrivateInputAuthorityV1,
  materializeCurrentPackageInputs,
  materializePackageInputs,
  materializePatchedPackageInputs,
} from "./input-materializer.js";
import {
  capabilityRemovalClosure,
  loadInstalledPackages,
  mergeReplacingPackages,
  readCapabilityHistory,
  requiredInstalledPackage,
  sortedUniquePackages,
} from "./installed-state.js";
import { bindCapabilityIntentExecutionClosure } from "./intent-execution-bindings.js";
import type { CapabilityIntentMaterializerOptionsV1 } from "./intent-materializer-types.js";
import { capabilitySelectorMatches } from "./source-materialization.js";
export { capabilitySourceAuthoritySetDigest } from "./source-materialization.js";
import {
  inheritedDependencySelectors,
  lockCapabilityTargets,
  packageCapabilityTargets,
  replaceCapabilityTargets,
} from "./target-materializer.js";
import type { CapabilityHostActionV1, CapabilityPlanningRequestV1 } from "./types.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

export type {
  CapabilityAdoptCandidateAuthorityV1,
  CapabilityIntentMaterializerOptionsV1,
} from "./intent-materializer-types.js";
function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "invalid-plan");
}

export class DefaultCapabilityIntentMaterializerV1
  implements CapabilityIntentMaterializerContractV1
{
  constructor(readonly options: CapabilityIntentMaterializerOptionsV1) {}

  materialize(request: CapabilityIntentPreparationRequestV1): CapabilityPlanningRequestV1 {
    const action = request.action;
    const base = this.options.storage.readStatus();
    if (base.state === "corrupt" || base.state === "unsupported")
      throw new CapabilityRuntimeError("capability scope requires repair", "scope-needs-recovery");
    const lock = base.lock;
    const authority = this.options.authority.read(action.scope);
    if (
      authority.scope !== action.scope ||
      authority.scope_identity_digest !== this.options.storage.scopeIdentityDigest
    )
      throw new CapabilityRuntimeError(
        "capability authority is bound to another scope",
        "authorization-mismatch",
      );
    const current = loadInstalledPackages(this.options, lock);
    const built = this.materializeLifecycle(action, lock, current, request.action_root_locator);
    const bound = bindCapabilityIntentExecutionClosure({
      desired: built.desired,
      effects: built.effects,
      targets: built.targets ?? [],
      action,
      planningOptions: request.planning_options,
      actionRootLocator: request.action_root_locator,
      requestAuthority: request.request_authority,
      runtimeAuthority: authority,
      packages: this.options.packages,
      privateInputs: this.options.privateInputs,
      now: this.options.now(),
      legacyCandidateDigest: built.adopt?.candidate_digest ?? null,
    });
    const scopedAuthority = {
      ...authority,
      source_authority_set_digest: bound.sourceAuthoritySetDigest,
    };
    const engines = [...new Set((built.targets ?? []).map((target) => target.engine))].sort(
      bytewise,
    );
    return {
      schema_version: "1.0",
      intent: built.intent,
      scope: action.scope,
      scope_identity_digest: authority.scope_identity_digest,
      authority: scopedAuthority,
      base_lock: lock,
      desired_packages: sortedUniquePackages(bound.desired),
      effect_packages: sortedUniquePackages(bound.effects),
      ...(built.adopt ? { adopt_candidate: built.adopt } : {}),
      selected_engines: engines,
      selected_targets: built.targets,
      action_root_locator: structuredClone(request.action_root_locator),
      source_request_context: bound.sourceRequestContext,
    };
  }

  private materializeLifecycle(
    action: CapabilityHostActionV1,
    lock: CapabilityLockV1 | null,
    current: ResolvedCapabilityPackageV1[],
    actionRootLocator: CapabilityPlanningRequestV1["action_root_locator"],
  ): {
    intent: CapabilityPlanningRequestV1["intent"];
    desired: ResolvedCapabilityPackageV1[];
    effects: ResolvedCapabilityPackageV1[];
    targets?: NonNullable<CapabilityPlanningRequestV1["selected_targets"]>;
    adopt?: StrictLegacyAdoptCandidateV1;
  } {
    if (action.type === "capability.install" || action.type === "capability.update") {
      const selector = action.type === "capability.install" ? action.package : action.selector;
      if (action.type === "capability.install" && current.some((pkg) => pkg.pin.id === selector.id))
        invalid("install cannot replace an already installed package; use update");
      if (action.type === "capability.update") {
        requiredInstalledPackage(current, action.package_id);
        if (selector.id !== action.package_id)
          invalid("update selector must name the installed package being updated");
      }
      const requestedTargets =
        action.type === "capability.install"
          ? action.requested_targets
          : (action.requested_targets ?? this.lockTargets(lock, action.package_id));
      const resolved = this.resolveSelector(
        selector,
        requestedTargets.map((target) => target.engine),
      );
      const root = resolved.find(
        (pkg) => pkg.pin.id === selector.id,
      ) as ResolvedCapabilityPackageV1;
      const values = action.type === "capability.install" ? action.inputs : action.inputs;
      const currentEntry = lock?.packages.find((entry) => entry.package_id === selector.id);
      const configured =
        values === null
          ? currentEntry
            ? materializeCurrentPackageInputs({
                pkg: root,
                publicInputs: currentEntry.public_inputs,
                secretInputIds: currentEntry.secret_input_ids,
                scope: action.scope,
                scopeIdentityDigest: this.options.storage.scopeIdentityDigest,
                privateInputs: this.options.privateInputs,
              })
            : invalid("update without inputs requires an installed package")
          : materializePackageInputs({
              pkg: root,
              values,
              scope: action.scope,
              scopeIdentityDigest: this.options.storage.scopeIdentityDigest,
              privateInputs: this.options.privateInputs,
            });
      const selected = resolved.map((pkg) => {
        if (pkg.pin.id === root.pin.id) return configured;
        const existing = lock?.packages.find((entry) => entry.package_id === pkg.pin.id);
        return existing
          ? materializeCurrentPackageInputs({
              pkg,
              publicInputs: existing.public_inputs,
              secretInputIds: existing.secret_input_ids,
              scope: action.scope,
              scopeIdentityDigest: this.options.storage.scopeIdentityDigest,
              privateInputs: this.options.privateInputs,
            })
          : materializePackageInputs({
              pkg,
              values: [],
              scope: action.scope,
              scopeIdentityDigest: this.options.storage.scopeIdentityDigest,
              privateInputs: this.options.privateInputs,
            });
      });
      const desired = mergeReplacingPackages(current, selected);
      const inherited = inheritedDependencySelectors(requestedTargets);
      const replacements = selected.flatMap((pkg) => {
        if (pkg.pin.id === root.pin.id) return packageCapabilityTargets(pkg, requestedTargets);
        const existing = this.lockTargets(lock, pkg.pin.id);
        const selectors =
          existing.length > 0
            ? existing.map(({ engine, participant_id }) => ({ engine, participant_id }))
            : inherited;
        return packageCapabilityTargets(pkg, selectors);
      });
      return {
        intent:
          action.type === "capability.install"
            ? { kind: "install" }
            : { kind: "update", package_id: action.package_id },
        desired,
        effects: desired,
        targets: replaceCapabilityTargets(
          this.lockTargets(lock),
          new Set(selected.map((pkg) => pkg.pin.id)),
          replacements,
        ),
      };
    }
    if (action.type === "capability.configure") {
      const pkg = requiredInstalledPackage(current, action.package_id);
      const configured = materializePatchedPackageInputs({
        pkg,
        values: action.inputs,
        scope: action.scope,
        scopeIdentityDigest: this.options.storage.scopeIdentityDigest,
        privateInputs: this.options.privateInputs,
      });
      const desired = mergeReplacingPackages(current, [configured]);
      return {
        intent: { kind: "configure", package_id: action.package_id },
        desired,
        effects: desired,
        targets: this.lockTargets(lock),
      };
    }
    if (action.type === "capability.retarget") {
      const pkg = requiredInstalledPackage(current, action.package_id);
      return {
        intent: { kind: "retarget", package_id: action.package_id },
        desired: current,
        effects: current,
        targets: replaceCapabilityTargets(
          this.lockTargets(lock),
          new Set([pkg.pin.id]),
          packageCapabilityTargets(pkg, action.requested_targets),
        ),
      };
    }
    if (action.type === "capability.remove") {
      const removed = capabilityRemovalClosure(current, action.package_id, action.cascade);
      const removedIds = new Set(removed.map((pkg) => pkg.pin.id));
      const desired = current.filter((pkg) => !removedIds.has(pkg.pin.id));
      return {
        intent: { kind: "remove", package_id: action.package_id, cascade: action.cascade },
        desired,
        effects: sortedUniquePackages([...desired, ...removed]),
        targets: this.lockTargets(lock).filter((target) => !removedIds.has(target.package_id)),
      };
    }
    if (action.type === "capability.rollback_scope") {
      const targetLock = readCapabilityHistory(this.options.storage, action.generation_id);
      const desired = loadInstalledPackages(this.options, targetLock);
      return {
        intent: { kind: "rollback", generation_id: action.generation_id },
        desired,
        effects: mergeReplacingPackages(current, desired),
        targets: this.lockTargets(targetLock),
      };
    }
    if (action.type === "capability.restore_package") {
      const targetLock = readCapabilityHistory(this.options.storage, action.generation_id);
      const restored = requiredInstalledPackage(
        loadInstalledPackages(this.options, targetLock),
        action.package_id,
      );
      const desired = mergeReplacingPackages(current, [restored]);
      return {
        intent: {
          kind: "restore",
          package_id: action.package_id,
          generation_id: action.generation_id,
        },
        desired,
        effects: desired,
        targets: replaceCapabilityTargets(
          this.lockTargets(lock),
          new Set([action.package_id]),
          this.lockTargets(targetLock, action.package_id),
        ),
      };
    }
    if (action.type === "capability.repair") {
      if (action.package_id !== null) requiredInstalledPackage(current, action.package_id);
      return {
        intent: { kind: "repair", package_id: action.package_id },
        desired: current,
        effects: current,
        targets: this.lockTargets(lock),
      };
    }
    const candidate = this.options.adopt?.resolve(action.candidate, {
      scope: action.scope,
      action_root_locator: actionRootLocator,
    });
    if (!candidate || candidate.candidate_digest !== action.candidate.candidate_digest)
      throw new CapabilityRuntimeError(
        "legacy adoption candidate authority is unavailable",
        "authorization-mismatch",
      );
    if (Date.parse(candidate.expires_at) <= Date.parse(this.options.now()))
      throw new CapabilityRuntimeError(
        "legacy adoption candidate expired",
        "authorization-mismatch",
      );
    const pkg = this.options.packages.readByPin(candidate.synthetic_pin.pin_digest);
    if (!pkg)
      throw new CapabilityRuntimeError(
        "legacy adoption package cache is missing",
        "service-unavailable",
      );
    const desired = mergeReplacingPackages(current, [pkg]);
    return {
      intent: { kind: "adopt", candidate_digest: candidate.candidate_digest },
      desired,
      effects: desired,
      targets: replaceCapabilityTargets(
        this.lockTargets(lock),
        new Set([candidate.synthetic_pin.id]),
        candidate.targets.map((target) => {
          if (target.target.engine === null)
            invalid("legacy adoption target has no engine identity");
          return {
            package_id: candidate.synthetic_pin.id,
            engine: target.target.engine as import("../../actions/types.js").EngineName,
            participant_id: target.target.participant_id,
          };
        }),
      ),
      adopt: candidate,
    };
  }

  private resolveSelector(
    selector: PackageSelectorV1,
    engines: import("../../actions/types.js").EngineName[],
  ): ResolvedCapabilityPackageV1[] {
    const rows = this.options.packages
      .candidates([...new Set(engines)].sort(bytewise))
      .filter((row) => capabilitySelectorMatches(selector, row));
    if (rows.length === 0) invalid("no validated cached package matches the exact selector");
    const resolution = resolveDependencies({
      requests: [
        {
          package_id: selector.id,
          version_range: selector.version ?? "*",
          ...(selector.content_sha256 ? { content_sha256: selector.content_sha256 } : {}),
          ...(rows.length === 1 ? { source_identity: rows[0]?.candidate.source_identity } : {}),
        },
      ],
      candidates: rows.map((row) => row.candidate),
      allowed_trust:
        selector.source_kind === "local-dev"
          ? ["verified", "source-pinned", "legacy-verified", "dev-unverified"]
          : undefined,
    });
    if (
      resolution.dependency_bindings.some(
        (binding) => binding.required_scope === "user-prerequisite",
      )
    )
      throw new CapabilityRuntimeError(
        "cross-scope prerequisites require a separately approved user operation",
        "action-required",
      );
    return resolution.packages.map((candidate) => {
      const resolved = rows.find(
        (row) => row.candidate.candidate_digest === candidate.candidate_digest,
      )?.resolved;
      if (!resolved) invalid("resolved package escaped the fixed cache candidate set");
      return {
        ...resolved,
        dependencies: resolution.dependency_bindings
          .filter(
            (binding): binding is typeof binding & { required_scope: "same" } =>
              binding.from_package_id === resolved.pin.id && binding.required_scope === "same",
          )
          .map(({ from_package_id: _, ...binding }) => binding),
      };
    });
  }

  private lockTargets(
    lock: CapabilityLockV1 | null,
    packageId?: string,
  ): NonNullable<CapabilityPlanningRequestV1["selected_targets"]> {
    return lockCapabilityTargets(lock, packageId);
  }
}

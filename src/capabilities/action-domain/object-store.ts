import { join } from "node:path";
import { type ActionProposalV1, assertProposal } from "../../actions/index.js";
import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import {
  acquireProcessLock,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { executionClosureDigest } from "../planning/digests.js";
import { validateCapabilityPlanningGraph } from "../planning/execution-graph-validation.js";
import { CAPABILITY_EXECUTION_LEDGER_MODE } from "../planning/execution-ledger-contract.js";
import {
  actionBlobRef,
  actionJsonRef,
  assertExecutionObjectBinding,
} from "../planning/execution-objects.js";
import {
  type CapabilityExecutionPackageReaderV1,
  rehydrateCapabilityPlanningGraph,
} from "../planning/execution-runtime-rehydration.js";
import type {
  CapabilityExecutionJsonObjectValueV1,
  CapabilityPlanningJsonObjectV1,
  CapabilityPlanningLedgerV1,
  CapabilityPlanningPrivateInputV1,
  CapabilityPlanningRawBlobV1,
} from "../planning/execution-types.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityExecutionObjectClosureV1,
} from "../planning/types.js";
import { validateExecutionPrivateInputRecord } from "../private-input/execution-binding.js";
import type { CapabilityRuntimeActionRootsV1 } from "../runtime-action-authority.js";
import { capabilityActionPlanDigest } from "./action-plan.js";
import type { CapabilityActionGraphV1, CapabilityActionPlanBindingV1 } from "./types.js";

const MAX_OBJECT = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

function parseCanonical<T>(path: string, label: string, maxBytes = MAX_OBJECT): T {
  const bytes = privateFileBytes(path, maxBytes);
  if (!bytes) return fail(`${label} is missing`);
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is corrupt`);
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes })))
    return fail(`${label} is not canonical`);
  return value as T;
}

export class CapabilityActionObjectStoreV1 {
  constructor(
    readonly roots: CapabilityRuntimeActionRootsV1,
    readonly packagesFor: (scope: CapabilityScope) => CapabilityExecutionPackageReaderV1,
  ) {}

  persistGraph(input: CapabilityDurablePlanningGraphV1): void {
    const graph = validateCapabilityPlanningGraph(input);
    if (graph.ledger.mode !== CAPABILITY_EXECUTION_LEDGER_MODE.DURABLE_PROPOSAL)
      throw new CapabilityRuntimeError(
        "transient capability graph cannot be persisted",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const root = this.roots.path(graph.execution_closure.action_root_locator);
    const lock = acquireProcessLock(join(root, "actions", "v1", "writer.lock"), {
      operation: `capability-action-graph:${graph.execution_closure.closure_digest}`,
      coverageRoot: root,
    });
    try {
      for (let stratum = 0; stratum <= 7; stratum += 1) {
        for (const row of graph.ledger.json_objects.filter((item) => item.stratum === stratum))
          this.putJson(root, row, lock);
        if (stratum === 1) {
          for (const row of graph.ledger.raw_blobs) this.putBlob(root, row, lock);
          for (const row of graph.ledger.private_input_bindings)
            this.putPrivateInput(root, row, lock);
        }
      }
      createOrVerifyPrivateFile(
        this.objectPath(root, graph.execution_closure.closure_digest),
        canonicalJsonBytes(graph.execution_closure),
        { lock, maxBytes: MAX_OBJECT },
      );
      const actionPlanDigest = capabilityActionPlanDigest(graph.action_plan);
      createOrVerifyPrivateFile(
        this.objectPath(root, actionPlanDigest),
        canonicalJsonBytes(graph.action_plan),
        { lock, maxBytes: MAX_OBJECT },
      );
    } finally {
      lock.release();
    }
  }

  readGraph(proposalInput: ActionProposalV1): CapabilityActionGraphV1 {
    assertProposal(proposalInput);
    const proposal = structuredClone(proposalInput);
    if (proposal.domain !== "capability" || proposal.base.capability_scope === null)
      fail("proposal is outside the capability domain");
    if (!proposal.execution_object_closure_digest)
      fail("capability proposal lacks its execution closure");
    const root = this.roots.path(
      proposal.action_root_locator as Exclude<
        typeof proposal.action_root_locator,
        { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
      >,
    );
    const executionClosure = parseCanonical<CapabilityExecutionObjectClosureV1>(
      this.objectPath(root, proposal.execution_object_closure_digest),
      "capability execution closure",
    );
    if (
      executionClosure.closure_digest !== proposal.execution_object_closure_digest ||
      executionClosureDigest(executionClosure) !== proposal.execution_object_closure_digest
    )
      fail("capability execution closure digest mismatch");
    const actionPlan = parseCanonical<CapabilityActionPlanBindingV1>(
      this.objectPath(root, proposal.plan_digest),
      "capability action plan",
    );
    if (capabilityActionPlanDigest(actionPlan) !== proposal.plan_digest)
      fail("capability action plan digest mismatch");
    if (
      actionPlan.domain !== "capability" ||
      actionPlan.execution_object_closure_digest !== executionClosure.closure_digest ||
      actionPlan.permission_digest !== proposal.permission_digest ||
      executionClosure.permission_digest !== proposal.permission_digest ||
      executionClosure.scope !== proposal.base.capability_scope ||
      canonicalJson(actionPlan.action_root_locator) !==
        canonicalJson(proposal.action_root_locator) ||
      canonicalJson(executionClosure.action_root_locator) !==
        canonicalJson(proposal.action_root_locator) ||
      canonicalJson(actionPlan.planning_options) !== canonicalJson(proposal.planning_options)
    )
      fail("capability proposal, action plan, and execution closure disagree");
    const ledger = this.readLedger(root, executionClosure);
    const graph = rehydrateCapabilityPlanningGraph({
      proposal,
      action_plan: actionPlan,
      execution_closure: executionClosure,
      ledger,
      packages: this.packagesFor(proposal.base.capability_scope),
    });
    validateCapabilityPlanningGraph(graph);
    return { proposal: structuredClone(proposal), ...graph };
  }

  private readLedger(
    root: string,
    closure: CapabilityExecutionObjectClosureV1,
  ): CapabilityPlanningLedgerV1 {
    const jsonObjects = closure.json_objects.map((binding): CapabilityPlanningJsonObjectV1 => {
      const value = parseCanonical<CapabilityExecutionJsonObjectValueV1>(
        this.objectPath(root, binding.object_digest),
        binding.object_schema_id,
      );
      const row = { stratum: stratumFor(binding.object_schema_id), binding, value };
      assertExecutionObjectBinding(binding, value);
      return row;
    });
    const rawBlobs = closure.raw_blobs.map((binding): CapabilityPlanningRawBlobV1 => {
      const bytes = privateFileBytes(this.blobPath(root, binding.content_digest), MAX_OBJECT);
      if (!bytes || binding.blob_ref !== actionBlobRef(binding.content_digest))
        fail("capability execution blob is missing or misbound");
      return { stratum: 1, binding, bytes_base64: bytes.toString("base64") };
    });
    const privateInputs = closure.private_input_bindings.flatMap(
      (binding): CapabilityPlanningPrivateInputV1[] => {
        if (binding.binding_ref === null) return [];
        const expectedRef = `actions/v1/private-input-bindings/vf-private-input-binding-${digestHex(
          binding.binding_digest,
        )}.json`;
        if (binding.binding_ref !== expectedRef)
          fail("capability private input ref is not canonical");
        const record = validateExecutionPrivateInputRecord(
          parseCanonical(
            join(root, binding.binding_ref),
            "capability private input binding",
            2 * 1024 * 1024,
          ),
        );
        return [
          {
            stratum: 1,
            binding_digest: binding.binding_digest,
            binding_ref: binding.binding_ref,
            record,
          },
        ];
      },
    );
    return {
      schema_version: "1.0",
      mode: CAPABILITY_EXECUTION_LEDGER_MODE.DURABLE_PROPOSAL,
      json_objects: jsonObjects,
      private_input_bindings: privateInputs,
      raw_blobs: rawBlobs,
    };
  }

  private putJson(
    root: string,
    row: CapabilityPlanningJsonObjectV1,
    lock: ReturnType<typeof acquireProcessLock>,
  ): void {
    assertExecutionObjectBinding(row.binding, row.value);
    if (row.binding.object_ref !== actionJsonRef(row.binding.object_digest))
      fail("capability JSON object ref is not canonical");
    createOrVerifyPrivateFile(
      this.objectPath(root, row.binding.object_digest),
      canonicalJsonBytes(row.value),
      { lock, maxBytes: MAX_OBJECT },
    );
  }

  private putBlob(
    root: string,
    row: CapabilityPlanningRawBlobV1,
    lock: ReturnType<typeof acquireProcessLock>,
  ): void {
    if (row.binding.blob_ref !== actionBlobRef(row.binding.content_digest))
      fail("capability raw blob ref is not canonical");
    const bytes = Buffer.from(row.bytes_base64, "base64");
    if (bytes.toString("base64") !== row.bytes_base64)
      fail("capability raw blob bytes are not canonical base64");
    createOrVerifyPrivateFile(this.blobPath(root, row.binding.content_digest), bytes, {
      lock,
      maxBytes: MAX_OBJECT,
    });
  }

  private putPrivateInput(
    root: string,
    row: CapabilityPlanningPrivateInputV1,
    lock: ReturnType<typeof acquireProcessLock>,
  ): void {
    const record = validateExecutionPrivateInputRecord(row.record);
    const expected = `actions/v1/private-input-bindings/${record.private_binding_id}.json`;
    if (row.binding_ref !== expected || row.binding_digest !== record.binding_digest)
      fail("capability private input ref is not canonical");
    createOrVerifyPrivateFile(join(root, expected), canonicalJsonBytes(record), {
      lock,
      maxBytes: 2 * 1024 * 1024,
    });
  }

  private objectPath(root: string, digest: string): string {
    return join(root, "actions", "v1", "objects", `${digestHex(digest)}.json`);
  }

  private blobPath(root: string, digest: string): string {
    return join(root, "actions", "v1", "blobs", `${digestHex(digest)}.bin`);
  }
}

function stratumFor(
  schema: import("../planning/execution-types.js").CapabilityExecutionObjectSchemaIdV1,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const map: Record<typeof schema, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
    "vf.capability-adapter-registry/1": 0,
    "vf.adapter-plan/1": 7,
    "vf.projection-snapshot/1": 6,
    "vf.adapter-bounded-evidence/1": 5,
    "vf.adapter-private-descriptor/1": 1,
    "vf.step-enforcement-binding/1": 5,
    "vf.probe-enforcement-binding/1": 5,
    "vf.permission-binding/1": 1,
    "vf.adapter-set-binding/1": 1,
    "vf.source-access-descriptor/1": 2,
    "vf.source-access-authority-binding/1": 3,
    "vf.package-authenticity-binding/1": 1,
    "vf.resolved-source-authority-binding/1": 4,
    "vf.control-credential-binding/1": 1,
  };
  return map[schema];
}

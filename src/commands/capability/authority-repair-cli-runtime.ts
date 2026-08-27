import type {
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairExecutionV1,
  CapabilityCliAuthorityRepairRuntimeV1,
} from "../../capabilities/cli/ports.js";
import { authorityRepairMutationResult } from "./authority-repair-mutation-results.js";
import {
  AuthorityRepairGuidedMutationRuntimeV1,
  type AuthorityRepairGuidedRuntimeOptionsV1,
} from "./authority-repair-runtime.js";

/** Thin CLI projection over the guided repair coordinator. */
export class AuthorityRepairCliMutationRuntimeV1 implements CapabilityCliAuthorityRepairRuntimeV1 {
  readonly guided: AuthorityRepairGuidedMutationRuntimeV1;

  constructor(options: AuthorityRepairGuidedRuntimeOptionsV1) {
    this.guided = new AuthorityRepairGuidedMutationRuntimeV1(options);
  }

  execute(
    input: CapabilityCliAuthorityRepairExecutionV1,
    interaction: AuthorityRepairCliInteractionV1,
  ) {
    return authorityRepairMutationResult(this.guided.executeGuided(input, interaction));
  }
}

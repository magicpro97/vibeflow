<template>
  <div class="home-anchored-actions" aria-label="Durable action updates">
    <div v-for="operation in operations" :key="operation.proposal_id">
      <i :data-state="operation.state" aria-hidden="true" />
      <span>
        <strong>{{ operation.domain === "capability" ? "CLI capability" : "Conversation action" }}</strong>
        <small>{{ latest(operation) }}</small>
      </span>
      <em>{{ operation.state.replaceAll("_", " ") }}</em>
      <details v-if="operation.result_ref"><summary>Evidence</summary><code>{{ operation.result_ref }}</code></details>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HomeActionOperation } from "../conversation-home-types.js";

defineProps<{ operations: HomeActionOperation[] }>();
const latest = (operation: HomeActionOperation) =>
  operation.progress.at(-1)?.message_code.replaceAll(".", " ").replaceAll("-", " ") ??
  `${operation.targets.length} target${operation.targets.length === 1 ? "" : "s"}`;
</script>

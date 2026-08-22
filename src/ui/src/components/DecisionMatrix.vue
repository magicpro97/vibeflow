<template>
  <section class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="text-[10px] uppercase tracking-[0.24em] text-neutral-500">Decision Matrix</p>
        <h2 class="mt-1 text-sm font-medium text-neutral-100">Ranked options</h2>
      </div>
      <p v-if="matrix" class="text-[11px] text-neutral-500">{{ matrix.method }} · {{ matrix.generated_at }}</p>
    </div>

    <div v-if="matrix?.rows.length" class="mt-4 overflow-x-auto">
      <table class="min-w-full text-left text-xs">
        <thead class="text-neutral-500">
          <tr>
            <th class="pb-2 pr-4">Rank</th>
            <th class="pb-2 pr-4">Option</th>
            <th class="pb-2 pr-4">Aggregate</th>
            <th class="pb-2 pr-4">Responses</th>
            <th class="pb-2 pr-4">Evidence</th>
            <th class="pb-2 pr-4">Agreement</th>
            <th class="pb-2 pr-4">Conflict</th>
            <th class="pb-2 pr-4">Quality</th>
            <th class="pb-2">Convergence</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in matrix.rows" :key="row.rank" class="border-t border-neutral-800/70 text-neutral-200">
            <td class="py-2 pr-4">{{ row.rank }}</td>
            <td class="py-2 pr-4">{{ row.option }}</td>
            <td class="py-2 pr-4">{{ row.aggregate.toFixed(6) }}</td>
            <td class="py-2 pr-4">{{ row.scores.responses.toFixed(6) }}</td>
            <td class="py-2 pr-4">{{ row.scores.evidence.toFixed(6) }}</td>
            <td class="py-2 pr-4">{{ row.scores.agreement.toFixed(6) }}</td>
            <td class="py-2 pr-4">{{ row.scores.conflict_resolution.toFixed(6) }}</td>
            <td class="py-2 pr-4">{{ row.scores.evidence_quality.toFixed(6) }}</td>
            <td class="py-2">{{ row.scores.convergence.toFixed(6) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="mt-4 rounded border border-dashed border-neutral-800 px-3 py-4 text-xs text-neutral-600">
      No completed claims yet, so the decision matrix is empty.
    </p>

    <div class="mt-4 rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3">
      <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Baseline</p>
      <template v-if="baseline">
        <p class="mt-2 text-sm text-neutral-100">{{ baseline.status }}</p>
        <p class="mt-1 text-xs text-neutral-400">Debate: {{ baseline.debate_answer ?? "not available" }}</p>
        <p class="mt-1 text-xs text-neutral-400">Baseline: {{ baseline.baseline_answer ?? "not available" }}</p>
        <p class="mt-1 text-xs text-neutral-400">
          Divergence:
          {{ baseline.divergence === null ? "not available" : baseline.divergence.toFixed(6) }}
        </p>
        <p v-if="baseline.skip_reason" class="mt-1 text-xs text-neutral-500">{{ baseline.skip_reason }}</p>
      </template>
      <p v-else class="mt-2 text-xs text-neutral-600">No baseline event has been published yet.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { BaselineComparisonView, DecisionMatrix } from "../conversation-store.js";

defineProps<{ matrix: DecisionMatrix | null; baseline: BaselineComparisonView | null }>();
</script>

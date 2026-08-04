<template>
  <div>
    <div v-if="store.domainsError" class="py-4 text-center text-red-400 text-xs">
      {{ store.domainsError }}
    </div>

    <div v-else-if="store.domainsLoading" class="py-4 space-y-3">
      <div v-for="i in 3" :key="i" class="h-4 rounded bg-neutral-800/60 animate-pulse" :style="{width: ['70%','85%','60%'][i-1]}" />
    </div>

    <div v-else-if="store.domains.length === 0" class="py-8 text-center text-neutral-600 text-sm">
      No domains declared. Add facts via <code class="text-neutral-400">.vibeflow/DOMAIN_FACTS.json</code>.
    </div>

    <div v-else class="space-y-6">
      <div
        v-for="root in store.domains"
        :key="root.id"
        class="rounded border border-neutral-800 p-3"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-medium text-neutral-100 truncate">{{ root.id }}</h3>
            <p class="text-xs text-neutral-400 mt-0.5">Canonical: <span class="text-neutral-200">{{ root.canonical }}</span></p>
          </div>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 shrink-0">
            {{ root.facts.length }} fact{{ root.facts.length === 1 ? "" : "s" }}
          </span>
        </div>

        <div class="mt-3">
          <p class="text-[10px] uppercase tracking-wide text-neutral-500 mb-1">Owned facts</p>
          <div v-if="root.facts.length === 0" class="text-xs text-neutral-600">None.</div>
          <ul v-else class="space-y-1.5">
            <li v-for="fact in root.facts" :key="fact.key">
              <button
                type="button"
                class="w-full text-left rounded border border-neutral-800 px-2 py-1.5 hover:border-neutral-600 transition-colors"
                :class="selected === fact.key ? 'border-neutral-500 bg-neutral-900' : ''"
                :aria-pressed="selected === fact.key"
                @click="select(fact.key)"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="text-xs font-medium text-neutral-200">{{ fact.key }}</span>
                  <span v-if="fact.version" class="text-[10px] text-neutral-500">v{{ fact.version }}</span>
                </span>
                <span v-if="fact.statement" class="block text-[11px] text-neutral-400 mt-0.5">{{ fact.statement }}</span>
                <span v-if="fact.paths.length" class="block text-[10px] font-mono text-neutral-600 mt-0.5 truncate">
                  {{ fact.paths.join(", ") }}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div class="mt-3">
          <p class="text-[10px] uppercase tracking-wide text-neutral-500 mb-1">Child skills</p>
          <div v-if="root.children.length === 0" class="text-xs text-neutral-600">None.</div>
          <ul v-else class="flex flex-wrap gap-1.5">
            <li
              v-for="child in root.children"
              :key="child"
              class="text-[11px] rounded px-1.5 py-0.5"
              :class="highlighted.has(child) ? 'bg-green-900 text-green-200' : 'bg-neutral-800 text-neutral-400'"
            >{{ child }}</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="mt-4 border-t border-neutral-800 pt-3">
      <label for="domain-query" class="block text-[10px] uppercase tracking-wide text-neutral-500 mb-1">
        Highlight affected child skills
      </label>
      <div class="flex gap-2">
        <input
          id="domain-query"
          v-model="query"
          type="text"
          class="input-base flex-1"
          placeholder="Fact key or repo-relative path (e.g. src/auth/)"
          maxlength="500"
          @keydown.enter="runImpact"
        />
        <button
          type="button"
          class="btn-secondary"
          :disabled="impacting"
          @click="runImpact"
        >Highlight</button>
      </div>
      <p v-if="impactError" class="text-xs text-red-400 mt-1">{{ impactError }}</p>
      <p v-else-if="impactMessage" class="text-xs text-neutral-500 mt-1">{{ impactMessage }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useVfStore } from "../store.js";

const store = useVfStore();
const query = ref("");
const selected = ref<string | null>(null);
const highlighted = ref<Set<string>>(new Set());
const impacting = ref(false);
const impactError = ref<string | null>(null);
const impactMessage = ref<string | null>(null);

async function select(key: string) {
  selected.value = key;
  query.value = key;
  await runImpact();
}

async function runImpact() {
  const q = query.value.trim();
  if (!q) return;
  impacting.value = true;
  impactError.value = null;
  impactMessage.value = null;
  try {
    const skills = await store.resolveDomainImpact(q);
    highlighted.value = new Set(skills);
    if (selected.value !== q) selected.value = null;
    impactMessage.value =
      skills.length > 0
        ? `Impacted skills: ${skills.join(", ")}`
        : "No domain facts matched that query.";
  } catch (e) {
    impactError.value = e instanceof Error ? e.message : "Failed to resolve impact";
  } finally {
    impacting.value = false;
  }
}

onMounted(() => {
  if (store.domains.length === 0) store.loadDomains();
});
</script>

<template>
  <fieldset class="space-y-2">
    <legend class="text-xs text-neutral-500 mb-1.5 flex items-center gap-1.5">
      Env scrub
      <InfoTip tip="Host env handed to spawned agent CLIs is filtered so secrets (AWS_*, *_TOKEN, DB URLs) don't leak. Engine auth vars are always kept." />
      <button
        type="button"
        class="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors underline underline-offset-2"
        @click="editing = !editing"
      >{{ editing ? 'Done' : 'Edit' }}</button>
    </legend>

    <div class="text-xs text-neutral-400">
      mode:
      <span class="font-mono text-neutral-300">{{ modeLabel }}</span>
    </div>

    <template v-if="!editing">
      <div v-if="localDeny.length" class="flex flex-wrap gap-1.5">
        <span class="text-[11px] text-neutral-500 uppercase tracking-wider w-full">Configured deny</span>
        <span v-for="g in localDeny" :key="'d-' + g" class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 font-mono">{{ g }}</span>
      </div>
      <div v-if="localAllow.length" class="flex flex-wrap gap-1.5">
        <span class="text-[11px] text-neutral-500 uppercase tracking-wider w-full">Configured allow</span>
        <span v-for="g in localAllow" :key="'a-' + g" class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 font-mono">{{ g }}</span>
      </div>
      <div v-if="!localDeny.length && !localAllow.length" class="text-[11px] text-neutral-600 italic">
        Conservative default &mdash; known secret-shaped vars dropped, essentials + engine auth kept.
      </div>
    </template>

    <template v-else>
      <div class="flex flex-wrap gap-1.5">
        <span class="text-[11px] text-neutral-500 uppercase tracking-wider w-full">Configured deny</span>
        <span
          v-for="g in localDeny"
          :key="'d-' + g"
          class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 font-mono flex items-center gap-1"
        >
          {{ g }}
          <button
            type="button"
            class="text-neutral-600 hover:text-red-400 leading-none"
            :aria-label="'Remove deny pattern ' + g"
            @click="removePattern('deny', g)"
          >&times;</button>
        </span>
        <span v-if="!localDeny.length" class="text-[11px] text-neutral-600 italic">None</span>
      </div>
      <div class="flex gap-1.5 items-start">
        <input
          v-model="denyInput"
          type="text"
          placeholder="e.g. AWS_*"
          aria-label="Add deny pattern"
          class="bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 text-xs text-neutral-200 font-mono w-36 focus:outline-none focus:border-neutral-600 transition-colors"
          @keydown.enter.prevent="addPattern('deny')"
        />
        <button
          type="button"
          class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
          @click="addPattern('deny')"
        >Add</button>
      </div>

      <div class="flex flex-wrap gap-1.5 mt-2">
        <span class="text-[11px] text-neutral-500 uppercase tracking-wider w-full">Configured allow</span>
        <span
          v-for="g in localAllow"
          :key="'a-' + g"
          class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 font-mono flex items-center gap-1"
        >
          {{ g }}
          <button
            type="button"
            class="text-neutral-600 hover:text-red-400 leading-none"
            :aria-label="'Remove allow pattern ' + g"
            @click="removePattern('allow', g)"
          >&times;</button>
        </span>
        <span v-if="!localAllow.length" class="text-[11px] text-neutral-600 italic">None</span>
      </div>
      <div class="flex gap-1.5 items-start">
        <input
          v-model="allowInput"
          type="text"
          placeholder="e.g. MY_APP_*"
          aria-label="Add allow pattern"
          class="bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 text-xs text-neutral-200 font-mono w-36 focus:outline-none focus:border-neutral-600 transition-colors"
          @keydown.enter.prevent="addPattern('allow')"
        />
        <button
          type="button"
          class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
          @click="addPattern('allow')"
        >Add</button>
      </div>

      <div v-if="error" class="text-[11px] text-red-400">{{ error }}</div>
    </template>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { validateEnvGlob } from "../lib/env-glob.js";
import InfoTip from "./InfoTip.vue";

const props = defineProps<{
  modelValue: { allow?: string[]; deny?: string[] } | undefined;
}>();

const emit = defineEmits<{
  "update:modelValue": [{ allow?: string[]; deny?: string[] }];
}>();

const editing = ref(false);
const denyInput = ref("");
const allowInput = ref("");
const error = ref("");

const localDeny = computed(() => props.modelValue?.deny ?? []);
const localAllow = computed(() => props.modelValue?.allow ?? []);

const modeLabel = computed(() =>
  localAllow.value.length ? "strict (allowlist)" : "default (denylist)",
);

function emitChange(allow: string[], deny: string[]) {
  error.value = "";
  // Normalize the empty policy back to {} so the dirty-check baseline (also {})
  // matches — {allow:[],deny:[]} would falsely read as "unsaved changes".
  const next = allow.length || deny.length ? { allow: [...allow], deny: [...deny] } : {};
  emit("update:modelValue", next);
}

function removePattern(list: "deny" | "allow", glob: string) {
  if (list === "deny") {
    emitChange(
      localAllow.value,
      localDeny.value.filter((g) => g !== glob),
    );
  } else {
    emitChange(
      localAllow.value.filter((g) => g !== glob),
      localDeny.value,
    );
  }
}

function addPattern(list: "deny" | "allow") {
  const raw = list === "deny" ? denyInput.value : allowInput.value;
  const err = validateEnvGlob(raw);
  if (err) {
    error.value = err;
    return;
  }
  const current = list === "deny" ? localDeny.value : localAllow.value;
  const trimmed = raw.trim();
  if (current.includes(trimmed)) {
    error.value = "already added";
    return;
  }
  if (list === "deny") {
    emitChange(localAllow.value, [...current, trimmed]);
    denyInput.value = "";
  } else {
    emitChange([...current, trimmed], localDeny.value);
    allowInput.value = "";
  }
}
</script>

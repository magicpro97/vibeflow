<template>
  <div>
    <div v-if="store.registryError" class="py-4 text-center text-red-400 text-xs">
      {{ store.registryError }}
    </div>

    <div v-else-if="store.registryLoading" class="py-4 space-y-3">
      <div v-for="i in 3" :key="i" class="h-4 rounded bg-neutral-800/60 animate-pulse" :style="{width: ['70%','85%','60%'][i-1]}" />
    </div>

    <div v-else-if="store.registries.length === 0" class="py-8 text-center text-neutral-600 text-sm">
      No registries configured. Add one via `vf skills registry add`.
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="reg in store.registries"
        :key="reg.id"
        class="rounded border border-neutral-800 p-3"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-medium text-neutral-100 truncate">{{ reg.id }}</h3>
            <p class="text-xs text-neutral-400 mt-0.5 break-all">{{ reg.url || "—" }}</p>
          </div>
          <span
            class="text-[10px] px-1.5 py-0.5 rounded shrink-0"
            :class="reg.valid ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'"
          >{{ reg.valid ? "ok" : "invalid" }}</span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-neutral-500">
          <span>ref: {{ reg.ref || "—" }}</span>
          <span class="font-mono">pin: {{ reg.commitOID ? reg.commitOID.slice(0, 12) : "—" }}</span>
          <span>{{ reg.entryCount }} entries · {{ reg.installedCount }} valid installed</span>
        </div>
        <div class="mt-3">
          <button
            class="px-3 py-1.5 rounded text-xs border border-neutral-700 text-neutral-200 hover:bg-neutral-800 transition-colors"
            :disabled="!reg.valid"
            @click="openPreview(reg.id, $event)"
          >Preview update</button>
        </div>
      </div>
    </div>

    <div
      v-if="store.registryPreview"
      class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="registry-preview-title"
      @click.self="closePreview()"
      @keydown.tab="trapModalTab"
      @keydown.esc.stop="closePreview()"
    >
      <div ref="modalEl" class="bg-neutral-950 border border-neutral-800 rounded w-full max-w-md p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 id="registry-preview-title" class="font-semibold text-neutral-100">Update preview</h3>
          <button
            ref="modalClose"
            class="text-neutral-500 hover:text-neutral-200 text-xl leading-none"
            aria-label="Close preview"
            @click="closePreview()"
          >×</button>
        </div>
        <p class="text-xs text-neutral-300 break-all">Registry: {{ store.registryPreview.registry }}</p>
        <pre class="mt-3 p-3 rounded bg-neutral-900 text-[11px] text-neutral-300 whitespace-pre-wrap">{{ store.registryPreview.plan }}</pre>
        <p class="mt-3 text-[11px] text-neutral-500">
          Dry-run preview only — no changes made. Approve execution in the CLI.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useVfStore } from "../store.js";

const store = useVfStore();
const modalEl = ref<HTMLElement | null>(null);
const modalClose = ref<HTMLElement | null>(null);
const lastTrigger = ref<HTMLElement | null>(null);

async function openPreview(id: string, e: Event) {
  lastTrigger.value = (e.currentTarget as HTMLElement) ?? null;
  const ok = await store.previewRegistryUpdate(id);
  if (!ok) return;
  await nextTick();
  modalClose.value?.focus();
}

function closePreview() {
  store.closeRegistryPreview();
  nextTick(() => {
    const t = lastTrigger.value;
    if (t?.isConnected) t.focus();
    lastTrigger.value = null;
  });
}

function trapModalTab(e: KeyboardEvent) {
  const el = modalEl.value;
  if (!el) return;
  const focusable = Array.from(
    el.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((n) => !n.closest("[hidden]"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (e.shiftKey) {
    if (document.activeElement === first || !el.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last || !el.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}

onMounted(() => {
  if (store.registries.length === 0) store.loadRegistries();
  document.addEventListener("focusin", onFocusIn, true);
});
onUnmounted(() => {
  if (store.registryPreview) store.closeRegistryPreview();
  document.removeEventListener("focusin", onFocusIn, true);
});

function onFocusIn(e: FocusEvent) {
  if (!modalEl.value) return;
  if (!modalEl.value.contains(e.target as Node)) {
    e.stopPropagation();
    const first = modalEl.value.querySelector<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }
}
</script>
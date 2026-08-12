<!-- Read-only review surface; approval happens in the CLI. -->
<template>
  <section class="mt-6 pt-5 border-t border-neutral-800">
    <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
      Release proposals
    </h2>

    <div v-if="store.releaseError" class="py-4 text-center text-red-400 text-xs">
      {{ store.releaseError }}
    </div>

    <div v-else-if="store.releaseLoading" class="py-4 space-y-3">
      <div v-for="i in 3" :key="i" class="h-4 rounded bg-neutral-800/60 animate-pulse" :style="{width: ['70%','85%','60%'][i-1]}" />
    </div>

    <div v-else-if="store.releaseProposals.length === 0" class="py-8 text-center text-neutral-600 text-sm">
      No release proposals. Create one via `vf skills registry release-propose`.
    </div>

    <div v-else class="space-y-3">
      <button
        v-for="p in store.releaseProposals"
        :key="p.id"
        class="w-full rounded border border-neutral-800 p-3 text-left hover:bg-neutral-900 transition-colors"
        @click="openDetail(p.id, $event)"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-medium text-neutral-100 truncate">{{ p.registry }}</h3>
            <p class="mt-0.5 text-xs text-neutral-400">Version {{ p.version }}</p>
          </div>
          <span class="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
            {{ p.state }}
          </span>
        </div>
        <p class="mt-2 text-[11px] text-neutral-500">{{ p.targetCount }} targets</p>
      </button>
    </div>

    <div
      v-if="store.releaseProposalDetail"
      class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="release-proposal-title"
      @click.self="closeDetail()"
      @keydown.tab="trapModalTab"
      @keydown.esc.stop="closeDetail()"
    >
      <div v-if="detail" ref="modalEl" class="bg-neutral-950 border border-neutral-800 rounded w-full max-w-xl p-5 max-h-[calc(100vh-6rem)] overflow-y-auto">
        <div class="flex items-center justify-between mb-3">
          <h3 id="release-proposal-title" class="font-semibold text-neutral-100">
            Release proposal
          </h3>
          <button
            ref="modalClose"
            class="text-neutral-500 hover:text-neutral-200 text-xl leading-none"
            aria-label="Close release proposal"
            @click="closeDetail()"
          >×</button>
        </div>

        <div class="space-y-1 text-xs text-neutral-300">
          <p>Registry: {{ detail.registry }}</p>
          <p>Version: {{ detail.version }}</p>
          <p>State: {{ detail.state }}</p>
          <p class="font-mono">
            {{ detail.fromOid.slice(0, 12) }} → {{ detail.toOid.slice(0, 12) }}
          </p>
        </div>

        <h4 class="mt-4 text-xs font-medium text-neutral-200">Changelog</h4>
        <pre class="mt-2 p-3 rounded bg-neutral-900 text-[11px] text-neutral-300 whitespace-pre-wrap">{{ detail.changelog }}</pre>

        <h4 class="mt-4 text-xs font-medium text-neutral-200">
          Targets ({{ detail.targets.length }})
        </h4>
        <div class="mt-2 space-y-2">
          <div
            v-for="t in detail.targets"
            :key="`${t.repository}:${t.baseBranch}`"
            class="rounded border border-neutral-800 p-3 text-xs text-neutral-300"
          >
            <div class="flex items-start justify-between gap-3">
              <span class="break-all">{{ t.repository }}</span>
              <span class="shrink-0 text-[10px] text-neutral-400">{{ t.status }}</span>
            </div>
            <p class="mt-1 text-[11px] text-neutral-500">Base: {{ t.baseBranch }}</p>
            <pre v-if="t.evidence" class="mt-2 p-2 rounded bg-neutral-900 text-[11px] text-neutral-300 whitespace-pre-wrap">{{ t.evidence }}</pre>
            <a
              v-if="(t.status === 'pr-opened' || t.status === 'existing-pr') && t.prUrl"
              :href="t.prUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-2 inline-block text-xs text-blue-400 hover:text-blue-300"
            >View PR</a>
          </div>
        </div>

        <div class="mt-4 flex items-center gap-2">
          <button
            class="px-3 py-1.5 rounded text-xs border border-neutral-700 text-neutral-200 hover:bg-neutral-800 transition-colors"
            @click="copyApprovalCommand(detail)"
          >Copy approval command</button>
          <span v-if="copied" class="text-[11px] text-green-400">Copied</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useVfStore } from "../store.js";

const store = useVfStore();
const detail = computed(() => store.releaseProposalDetail);
const modalEl = ref<HTMLElement | null>(null);
const modalClose = ref<HTMLElement | null>(null);
const lastTrigger = ref<HTMLElement | null>(null);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function openDetail(id: string, e: Event) {
  lastTrigger.value = (e.currentTarget as HTMLElement) ?? null;
  const ok = await store.openReleaseProposal(id);
  if (!ok) return;
  await nextTick();
  modalClose.value?.focus();
}

function closeDetail() {
  store.closeReleaseProposal();
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
  if (store.releaseProposals.length === 0) store.loadReleaseProposals();
  document.addEventListener("focusin", onFocusIn, true);
});
onUnmounted(() => {
  if (store.releaseProposalDetail) store.closeReleaseProposal();
  document.removeEventListener("focusin", onFocusIn, true);
  clearTimeout(copiedTimer);
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

async function copyApprovalCommand(detail: { id: string }) {
  await navigator.clipboard.writeText(`vf skills registry release approve ${detail.id} --yes`);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

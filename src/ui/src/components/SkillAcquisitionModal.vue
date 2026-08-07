// #682 — Skill acquisition approval cards.
// Renders bounded proposal metadata for pending acquisitions and lets the user
// approve/reject each one BEFORE the waiting /api/orchestrate request installs
// anything. This modal owns only polling + decision state; the run lifecycle and
// installation stay with the orchestration request. No store mutation, no direct
// registry install, no new dependency.
// Source is rendered as registryId@<12-char OID> only — never a URL, skillPath,
// or absolute path, and scan shows bounded state (with finding COUNT for blocked
// cards), never raw finding bodies.

<template>
  <div
    v-if="cards.length"
    ref="dialogEl"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="skill-acquisition-title"
    @keydown.esc="rejectFocused"
    @keydown.tab.capture="trapFocus"
  >
    <div class="w-full max-w-3xl rounded border border-neutral-800 bg-neutral-950 p-5">
      <div class="flex items-center justify-between">
        <h2 id="skill-acquisition-title" class="font-semibold text-neutral-100">
          Skill acquisitions need approval
        </h2>
        <span class="text-[11px] text-neutral-500">{{ cards.length }} pending</span>
      </div>
      <p class="mt-1 text-xs text-neutral-400">
        Approve a candidate to let it install from its pinned registry before agents run. Rejecting skips acquisition and continues the run with a skill gap.
      </p>

      <div
        v-if="errorMsg"
        class="mt-3 rounded border border-red-900/60 px-3 py-2 text-xs text-red-300"
        role="alert"
        aria-live="assertive"
      >
        ⚠ {{ errorMsg }}
      </div>

      <ul class="mt-4 space-y-3 max-h-[55vh] overflow-y-auto">
        <li
          v-for="p in cards"
          :key="p.id"
          :data-id="p.id"
          class="rounded border border-neutral-800 p-3"
          :class="p.approvable ? '' : 'border-red-900/60'"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-neutral-100">{{ p.need }}</h3>
              <p v-if="p.reason" class="mt-0.5 text-xs text-neutral-500">{{ p.reason }}</p>
            </div>
            <span class="shrink-0 text-[10px] font-mono" :class="scanLabel(p).color">
              {{ scanLabel(p).text }}
            </span>
          </div>

          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
            <span>Candidate: <span class="text-neutral-300">{{ p.name }}</span></span>
            <span>v{{ p.version }}</span>
            <span class="text-neutral-400">
              {{ p.source.registryId }}@{{ p.source.commitOID.slice(0, 12) }}
            </span>
            <span v-if="p.scan.state === 'blocked'" class="text-red-400">
              {{ p.scan.highestSeverity }} · {{ p.scan.findings }} finding{{ p.scan.findings === 1 ? "" : "s" }}
            </span>
            <span v-else-if="p.scan.state === 'not-scanned'" class="text-neutral-500">
              scanner unavailable · {{ p.scan.reason }}
            </span>
          </div>

          <div v-if="!p.approvable && p.scan.state === 'blocked'" class="mt-2 text-xs text-red-400">
            Blocked: security scan found {{ p.scan.highestSeverity }} severities. Approve is disabled — reject to continue without this skill.
          </div>

          <div class="mt-3 flex justify-end gap-2">
            <button
              type="button"
              class="flex-1 sm:flex-none px-4 py-1.5 rounded text-xs font-medium text-neutral-300 border border-red-900/70 hover:bg-red-950/40 transition-colors"
              :disabled="busy"
              data-action="reject"
              @click="decide(p.id, 'reject')"
            >Reject run</button>
            <button
              type="button"
              class="flex-1 sm:flex-none px-4 py-1.5 rounded text-xs font-medium text-neutral-900 bg-green-400 hover:bg-green-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="busy || !p.approvable"
              data-action="approve"
              @click="decide(p.id, 'approve')"
            >Approve install</button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "../api.js";
import type { AcquisitionDecision, SkillAcquisitionProposal } from "../types.js";

const cards = ref<SkillAcquisitionProposal[]>([]);
const errorMsg = ref<string | null>(null);
const busy = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function scanLabel(p: SkillAcquisitionProposal): { text: string; color: string } {
  if (p.scan.state === "blocked") {
    return { text: `blocked · ${p.scan.highestSeverity}`, color: "text-red-400" };
  }
  if (p.scan.state === "not-scanned") {
    return { text: "not scanned", color: "text-neutral-500" };
  }
  const sev = p.scan.highestSeverity === "none" ? "pass" : p.scan.highestSeverity;
  return { text: sev, color: sev === "pass" ? "text-green-400" : "text-amber-400" };
}

async function fetchPending() {
  try {
    cards.value = await api.acquisitions.pending();
    if (cards.value.length && document.activeElement === document.body) {
      focusFirstAction();
    }
  } catch {
    /* server may have no pending acquisitions */
  }
}

async function decide(id: string, decision: AcquisitionDecision) {
  busy.value = true;
  errorMsg.value = null;
  try {
    await api.acquisitions.decision(id, decision);
    // Only drop the card on success — retain it (and surface an error) on failure.
    cards.value = cards.value.filter((c) => c.id !== id);
    if (cards.value.length === 0) {
      restoreFocus();
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function rejectFocused() {
  // Escape means REJECT, never approve. Reject the focused card (or first card).
  const focused = document.activeElement?.closest("li") as HTMLElement | null;
  const card = focused ? cards.value.find((c) => c.id === focused.dataset.id) : undefined;
  const target = card ?? cards.value[0];
  if (target) decide(target.id, "reject");
}

function focusFirstAction() {
  const btn = dialogEl.value?.querySelector<HTMLElement>(
    'button:not([disabled])[data-action="approve"], button:not([disabled])[data-action="reject"]',
  );
  btn?.focus();
}

function trapFocus(e: KeyboardEvent) {
  const el = dialogEl.value;
  if (!el) return;
  const focusable = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled])")).filter(
    (n) => !n.closest("[hidden]"),
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (e.shiftKey) {
    if (document.activeElement === first || !el.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else if (document.activeElement === last || !el.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  }
}

function restoreFocus() {
  const run = document.getElementById("run-agents-button");
  if (run?.isConnected) run.focus();
}

onMounted(() => {
  fetchPending();
  pollTimer = setInterval(fetchPending, 2000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

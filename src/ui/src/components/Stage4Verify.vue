<template>
  <div class="max-w-3xl space-y-6">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-sm font-semibold text-neutral-100">Verify</h1>
        <p class="text-[11px] text-neutral-600 mt-0.5">Runs typecheck, lint, and tests. All must pass before the task is considered done.</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          v-if="result"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-neutral-800 hover:border-neutral-600 hover:text-neutral-200 text-neutral-400 text-xs transition-colors"
          :title="copiedSummary ? 'Copied!' : 'Copy human-readable summary for Slack / PR'"
          @click="copySummary"
        >
          <span>{{ copiedSummary ? "✓ Copied" : "⎘ Copy summary" }}</span>
        </button>
        <button
          v-if="result"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-neutral-800 hover:border-neutral-600 hover:text-neutral-200 text-neutral-400 text-xs transition-colors"
          :title="copied ? 'Copied to clipboard' : 'Copy raw check results as JSON'"
          @click="copyResults"
        >
          <span>{{ copied ? "✓ Copied" : "⎘ JSON" }}</span>
        </button>
        <button
          v-if="verifying"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-neutral-800 hover:border-neutral-600 text-neutral-500 hover:text-neutral-300 text-xs transition-colors"
          title="Cancel verification"
          @click="cancelVerify"
        >
          ✕ Cancel
        </button>
        <button
          class="btn-primary flex items-center gap-1.5"
          :disabled="verifying || !hasUnits"
          :title="!hasUnits ? 'No tasks to verify — run agents first' : undefined"
          @click="runVerify"
        >
          <span v-if="verifying" class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          <span>{{ verifying ? `Running checks… ${elapsedLabel}` : "Run checks" }}</span>
        </button>
      </div>
    </div>

    <!-- Summary bar -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="p-3 rounded border border-neutral-800/40 bg-transparent">
        <div class="text-xs text-neutral-500 mb-1">Tasks done</div>
        <div class="text-lg font-medium text-neutral-100 tabular-nums">
          {{ store.state?.totals.done ?? 0 }}<span class="text-neutral-500 text-sm font-normal">/{{ store.state?.totals.units ?? 0 }}</span>
        </div>
      </div>
      <div class="p-3 rounded border border-neutral-800/40 bg-transparent">
        <div class="text-xs text-neutral-500 mb-1">Tokens</div>
        <div class="text-lg font-medium text-neutral-100 tabular-nums">{{ fmtTokens(store.state?.totals.tokens ?? 0) }}</div>
      </div>
      <div class="p-3 rounded border border-neutral-800/40 bg-transparent">
        <div class="text-xs text-neutral-500 mb-1">Cost</div>
        <div class="text-lg font-medium text-neutral-100 tabular-nums">${{ fmtCost(store.state?.totals.cost_usd ?? 0) }}</div>
      </div>
      <div class="p-3 rounded border border-neutral-800/40 bg-transparent">
        <div class="text-xs text-neutral-500 mb-1 flex items-center">
          Avg confidence
          <InfoTip tip="Agent's confidence in its own work (0–100%). Informational — doesn't affect pass/fail." />
        </div>
        <div
          class="text-lg font-medium tabular-nums"
          :class="avgConfidence === null ? 'text-neutral-400' : avgConfidence >= 0.85 ? 'text-neutral-300' : avgConfidence >= 0.5 ? 'text-neutral-500' : 'text-red-400'"
        >
          {{ avgConfidence !== null ? `${(avgConfidence * 100).toFixed(0)}%` : "—" }}
        </div>
      </div>
    </div>

    <!-- Work unit table -->
    <div>
      <div class="text-[11px] text-neutral-600 mb-2 font-medium">Tasks</div>
      <div class="rounded border border-neutral-800/40 overflow-hidden">
        <WorkUnitTable :units="store.state?.work_units ?? []" />
      </div>
    </div>

    <!-- Error -->
    <div v-if="err" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-sm" role="alert" aria-live="assertive">
      <span class="mt-0.5 shrink-0">⚠</span>
      <span>{{ err }}</span>
    </div>

    <!-- Gate results — CI report -->
    <div v-if="result" class="space-y-3">
      <!-- Overall banner -->
      <div
        class="flex items-center gap-3 px-4 py-3 rounded border"
        :class="result.ok ? 'border-neutral-800/60 text-neutral-300' : 'border-neutral-800/60 text-neutral-400'"
      >
        <span class="text-base leading-none" :aria-label="result.ok ? 'all checks passed' : 'verification failed'">{{ result.ok ? "✓" : "✗" }}</span>
        <div>
          <div class="font-medium text-sm">
            {{ result.ok ? "All checks passed" : "Verification failed" }}
          </div>
          <div class="text-[11px] mt-0.5 text-neutral-500">
            {{ passCount }}/{{ result.gates.length }} checks passing
          </div>
          <div v-if="!result.ok" class="text-[11px] mt-1 text-neutral-600">
            Go to <button class="text-neutral-400 hover:text-white underline underline-offset-2 transition-colors" @click="store.setStage(3)">Run agents</button> to re-run agents and fix the failing checks.
          </div>
        </div>
        <div class="ml-auto text-xs text-neutral-600 tabular-nums">{{ runTimestamp }}</div>
      </div>

      <!-- Gate rows -->
      <div class="rounded border border-neutral-800/40 overflow-hidden divide-y divide-neutral-800/50">
        <div
          v-for="(gate, i) in result.gates"
          :key="i"
          class="flex items-center gap-3 px-4 py-2.5 text-sm"
          :class="gate.pass ? 'hover:bg-white/[0.02]' : 'bg-neutral-900/40 hover:bg-neutral-900/60'"
        >
          <span class="text-xs leading-none w-4 shrink-0 text-center" :aria-label="gate.pass ? 'passed' : 'failed'">{{ gate.pass ? "✓" : "✗" }}</span>
          <span class="font-mono text-neutral-300 flex-1 text-xs">{{ gate.label }}</span>
          <span
            class="text-[10px] font-medium tabular-nums"
            :class="gate.pass ? 'text-emerald-500' : 'text-red-400'"
          >
            {{ gate.pass ? "PASS" : "FAIL" }}
          </span>
        </div>
        <div v-if="!result.gates.length" class="px-4 py-4 text-center text-neutral-500 italic text-sm">
          No check results returned
        </div>
      </div>

      <!-- Policy block -->
      <div v-if="hasPolicy" class="rounded border border-neutral-800/40 overflow-hidden">
        <div class="flex items-center justify-between px-4 py-2 border-b border-neutral-800/40">
          <span class="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Policy</span>
          <button
            class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            :aria-expanded="policyExpanded"
            @click="policyExpanded = !policyExpanded"
          >{{ policyExpanded ? "Collapse ▲" : "Details ▼" }}</button>
        </div>
        <!-- Failures surfaced inline — don't make user expand to see why it failed -->
        <div v-if="result.policy?.failures?.length" class="px-4 py-2 space-y-1 border-b border-neutral-800/40">
          <div
            v-for="f in result.policy.failures"
            :key="f"
            class="flex items-start gap-1.5 text-[11px] text-red-400 font-mono"
          >
            <span class="shrink-0 mt-px">✗</span><span class="break-all">{{ f }}</span>
          </div>
        </div>
        <div v-if="policyExpanded" class="p-4 bg-neutral-900/30">
          <pre class="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-all leading-relaxed">{{ (() => { try { return JSON.stringify(result.policy, null, 2) } catch { return String(result.policy) } })() }}</pre>
        </div>
      </div>
    </div>

    <!-- New task CTA — shown after verify completes -->
    <div v-if="result" class="pt-3 border-t border-neutral-800/40 space-y-2">
      <!-- Success celebration — only when all passed -->
      <div v-if="result.ok" class="text-[11px] text-neutral-500 leading-relaxed">
        All checks passed. The task is complete — changes are in your repo.
        <span class="text-neutral-700">Commit, push, and open a PR when ready.</span>
      </div>
      <div class="flex items-center justify-between">
        <p class="text-[11px] text-neutral-700">{{ result.ok ? 'Task complete.' : 'Fix failing checks, then re-run.' }}</p>
        <div class="flex items-center gap-2">
          <button
            class="text-xs text-neutral-600 hover:text-neutral-300 transition-colors"
            title="Go to Describe to edit the goal and replan"
            @click="store.setStage(1)"
          >← Edit task</button>
          <button
            class="text-xs text-neutral-500 hover:text-neutral-200 border border-neutral-800 hover:border-neutral-600 px-3 py-1.5 rounded transition-colors"
            title="Clear current task and start fresh"
            @click="newTask"
          >+ New task</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { api } from "../api.js";
import { useVfStore } from "../store.js";
import InfoTip from "./InfoTip.vue";
import WorkUnitTable from "./WorkUnitTable.vue";

interface VerifyResult {
  ok: boolean;
  gates: { label: string; pass: boolean }[];
  policy: { ok?: boolean; failures?: string[]; warnings?: string[]; passed?: string[] } | null;
}

const store = useVfStore();
const verifying = ref(false);
const err = ref<string | null>(null);
const result = ref<VerifyResult | null>(null);
const copied = ref(false);
const copiedSummary = ref(false);
const policyExpanded = ref(false);
const runTimestamp = ref<string>("");

// Elapsed timer while verifying
const elapsedSecs = ref(0);
const elapsedLabel = computed(() => {
  if (!elapsedSecs.value) return ""; // no "0s" flash at start
  const m = Math.floor(elapsedSecs.value / 60);
  const s = elapsedSecs.value % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
});
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

// Abort controller for in-flight verify request
let verifyAbort: AbortController | null = null;
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — vf verify can be slow

function cancelVerify() {
  verifyAbort?.abort();
  verifyAbort = null;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  verifying.value = false;
}

onUnmounted(() => {
  verifyAbort?.abort();
  if (elapsedTimer) clearInterval(elapsedTimer);
});

const avgConfidence = computed<number | null>(() => {
  const units = store.state?.work_units;
  if (!units?.length) return null; // Only average units that actually have a confidence score — blocked/pending
  // units with null confidence would pull the average down incorrectly.
  const withConf = units.filter(
    (u) => u.confidence !== null && u.confidence !== undefined && u.confidence > 0,
  );
  if (!withConf.length) return null;
  return withConf.reduce((sum, u) => sum + (u.confidence ?? 0), 0) / withConf.length;
});

const passCount = computed(() => result.value?.gates.filter((g) => g.pass).length ?? 0);
const hasUnits = computed(() => (store.state?.work_units?.length ?? 0) > 0);

const hasPolicy = computed(() => {
  const p = result.value?.policy;
  return (
    p !== null &&
    p !== undefined &&
    !(typeof p === "object" && Object.keys(p as object).length === 0)
  );
});

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

async function runVerify() {
  verifying.value = true;
  err.value = null;
  result.value = null;
  policyExpanded.value = false;
  elapsedSecs.value = 0;

  // Start elapsed timer
  elapsedTimer = setInterval(() => {
    elapsedSecs.value++;
  }, 1000);

  // Abort controller with hard timeout (verify can run lint + test — slow)
  verifyAbort = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    verifyAbort?.abort();
  }, VERIFY_TIMEOUT_MS);

  try {
    result.value = (await api.verify(verifyAbort.signal)) as VerifyResult;
    runTimestamp.value = new Date().toLocaleTimeString();
    await store.loadState();
  } catch (e) {
    const msg = String(e);
    err.value = msg.includes("abort")
      ? timedOut
        ? "Verification timed out (3 min). Try running a lighter check or fix slow tests."
        : "Verification cancelled."
      : msg;
  } finally {
    clearTimeout(timeoutId);
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    verifyAbort = null;
    verifying.value = false;
  }
}

async function copySummary() {
  if (!result.value) return;
  const goal = store.state?.goal ?? "task";
  const status = result.value.ok ? "✅ All checks passed" : "❌ Verification failed";
  const gateLines = result.value.gates.map((g) => `  ${g.pass ? "✓" : "✗"} ${g.label}`).join("\n");
  const passCount = result.value.gates.filter((g) => g.pass).length;
  const text = `${status} (${passCount}/${result.value.gates.length})\nGoal: ${goal}\nChecks:\n${gateLines}`;
  try {
    await navigator.clipboard.writeText(text);
    copiedSummary.value = true;
    setTimeout(() => {
      copiedSummary.value = false;
    }, 2000);
  } catch {
    // fallback for non-HTTPS / older browsers
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copiedSummary.value = true;
      setTimeout(() => {
        copiedSummary.value = false;
      }, 2000);
    } catch {
      /* both methods failed — silent */
    }
  }
}

async function copyResults() {
  if (!result.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(result.value, null, 2));
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (_e) {
    // navigator.clipboard unavailable (non-HTTPS or browser restriction)
    // execCommand is deprecated but still works in localhost contexts
    try {
      const ta = document.createElement("textarea");
      ta.value = JSON.stringify(result.value, null, 2);
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) {
        copied.value = true;
        setTimeout(() => {
          copied.value = false;
        }, 2000);
      }
    } catch (_fallbackErr) {
      // both clipboard methods failed — silently ignore
    }
  }
}

async function newTask() {
  await api.clearState().catch(() => {});
  store.state = null;
  store.setStage(1);
}
</script>

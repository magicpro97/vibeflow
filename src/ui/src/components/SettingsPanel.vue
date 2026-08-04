<template>
  <div
    class="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    tabindex="-1"
    @click.self="confirmClose"
    @keydown.esc="confirmClose"
    @keydown.tab.capture="trapFocus"
  >
    <div
      ref="dialogEl"
      class="bg-neutral-950 border border-neutral-800 rounded w-full max-w-md p-5 max-h-[calc(100vh-4rem)] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      @keydown.esc="confirmClose"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 id="settings-title" class="font-semibold text-neutral-100">Settings</h2>
        <button class="text-neutral-500 hover:text-neutral-200 text-xl leading-none" aria-label="Close settings" @click="confirmClose">×</button>
      </div>

      <div v-if="loading" class="py-4 space-y-3">
        <div v-for="i in 4" :key="i" class="h-4 rounded bg-neutral-800/60 animate-pulse" :style="{width: ['60%','80%','70%','50%'][i-1]}" />
      </div>
      <div v-else-if="err && !form" class="py-4 space-y-3">
        <div class="flex items-start gap-2 p-3 rounded border border-neutral-800 text-red-400 text-xs">
          <span class="shrink-0">⚠</span><span>Failed to load settings: {{ err }}</span>
        </div>
        <div class="flex justify-end">
          <button type="button" class="px-3 py-1.5 rounded border border-neutral-800 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors" @click="$emit('close')">Close</button>
        </div>
      </div>
      <form v-else-if="form" class="space-y-4 text-sm" @submit.prevent="save">

        <!-- Tools -->
        <fieldset class="space-y-2">
          <legend class="text-xs text-neutral-500 mb-1.5 flex items-center gap-0.5">
            Tools
            <InfoTip tip="Optional tools that improve agent navigation. Disable if you hit install issues — agents still work without them." />
          </legend>
          <label class="flex items-start gap-2 cursor-pointer group">
            <input v-model="form.tools.codegraph" type="checkbox" class="rounded mt-0.5 accent-neutral-400" />
            <span>
              <span class="text-neutral-200 group-hover:text-white transition-colors">CodeGraph</span>
              <span class="block text-[11px] text-neutral-500 mt-0.5">Local code graph (tree-sitter + SQLite) for navigation and impact analysis</span>
            </span>
          </label>
          <label class="flex items-start gap-2 cursor-pointer group">
            <input v-model="form.tools.lsp" type="checkbox" class="rounded mt-0.5 accent-neutral-400" />
            <span>
              <span class="text-neutral-200 group-hover:text-white transition-colors">LSP Bridge</span>
              <span class="block text-[11px] text-neutral-500 mt-0.5">Language server protocol for go-to-definition, references, diagnostics</span>
            </span>
          </label>
        </fieldset>

        <!-- Failure Protection -->
        <fieldset class="space-y-2">
          <legend class="text-xs text-neutral-500 mb-1.5 flex items-center gap-0.5">
            Failure Protection
            <InfoTip tip="Safety options for agent runs. Enable Auto WIP commit to undo agent changes if needed." />
          </legend>
          <label class="flex items-start gap-2 cursor-pointer group">
            <input v-model="form.failureProtection.autoWip" type="checkbox" class="mt-0.5 accent-neutral-400" />
            <span>
              <span class="text-neutral-200 group-hover:text-white transition-colors">Auto WIP commit</span>
              <span class="block text-[11px] text-neutral-500 mt-0.5">Save your current code changes as a git commit before the agent runs — so you can recover if something goes wrong</span>
            </span>
          </label>
          <label class="flex items-start gap-2 cursor-pointer group" :class="!form.failureProtection.autoWip ? 'opacity-40 pointer-events-none' : ''">
            <input
              v-model="form.failureProtection.rollbackOnFail"
              type="checkbox"
              class="mt-0.5 accent-neutral-400"
              :disabled="!form.failureProtection.autoWip"
            />
            <span>
              <span class="text-neutral-200 group-hover:text-white transition-colors">Rollback on fail</span>
              <span class="block text-[11px] text-neutral-500 mt-0.5">Auto-restore your code to before the agent ran if a check fails — requires Auto WIP commit</span>
            </span>
          </label>
          <label class="flex items-start gap-2 cursor-pointer group">
            <input v-model="form.failureProtection.requireGit" type="checkbox" class="mt-0.5 accent-neutral-400" />
            <span>
              <span class="text-neutral-200 group-hover:text-white transition-colors">Require git</span>
              <span class="block text-[11px] text-neutral-500 mt-0.5">Refuse to run agents if the repository is not git-tracked (recommended)</span>
            </span>
          </label>
          <label class="flex items-center gap-2 mt-1">
            <span class="w-28 text-neutral-300 text-xs flex items-center gap-0.5">
              Timeout
              <InfoTip tip="Max run time in seconds. 0 = no limit. Default 3600s (1h). Lower = catch stuck agents sooner." />
            </span>
            <input
              v-model.number="form.failureProtection.timeoutSeconds"
              type="number"
              min="0"
              max="3600"
              step="30"
              class="w-20 bg-transparent border border-neutral-800 rounded px-2 py-0.5 text-sm text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
            />
            <span class="text-[11px] text-neutral-500">seconds (0 = no limit)</span>
          </label>
        </fieldset>

        <!-- Memory -->
        <label class="flex items-start gap-2 cursor-pointer group">
          <input v-model="form.memory" type="checkbox" class="mt-0.5 accent-neutral-400" />
          <span>
            <span class="text-neutral-200 group-hover:text-white transition-colors">Memory</span>
            <span class="block text-[11px] text-neutral-500 mt-0.5">Remember project context between sessions. Helps agents skip re-discovery work.</span>
          </span>
        </label>

        <!-- #559: Desktop notifications -->
        <label class="flex items-start gap-2 cursor-pointer group">
          <input v-model="form.notifications" type="checkbox" class="mt-0.5 accent-neutral-400" />
          <span>
            <span class="text-neutral-200 group-hover:text-white transition-colors">Desktop notifications</span>
            <span class="block text-[11px] text-neutral-500 mt-0.5">Get an OS notification when vf pr merge-when-green CI settles (green/red/timeout). Suppress per-run with --no-notify or VF_NO_NOTIFY=1.</span>
          </span>
        </label>

        <!-- Hooks (read-only) -->
        <fieldset v-if="form.hooks" class="space-y-2">
          <legend class="text-xs text-neutral-500 mb-1.5 flex items-center gap-1.5">
            Hooks
            <InfoTip tip="Rules that block risky agent actions — e.g. prevent rm -rf or .env writes." />
            <span class="text-[10px] text-neutral-600 font-normal normal-case tracking-normal">read-only · edit .vibeflow/hooks.yaml</span>
          </legend>
          <div v-if="form.hooks.templates.length" class="flex flex-wrap gap-1.5">
            <span
              v-for="t in form.hooks.templates"
              :key="t"
              class="px-2 py-0.5 rounded border border-neutral-800 text-xs text-neutral-400 font-mono"
            >{{ t }}</span>
          </div>
          <div v-else class="text-[11px] text-neutral-600 italic">No templates active</div>
          <div v-if="form.hooks.custom.length" class="mt-1 space-y-1">
            <div class="text-[11px] text-neutral-500 uppercase tracking-wider">Custom rules</div>
            <div
              v-for="(rule, i) in form.hooks.custom"
              :key="i"
              class="flex items-center gap-2 text-xs text-neutral-400 font-mono"
            >
              <span class="text-neutral-600">{{ rule.risk }}</span>
              <span class="text-neutral-300">{{ rule.match }}</span>
              <span v-if="rule.reason" class="text-neutral-600 truncate">— {{ rule.reason }}</span>
            </div>
          </div>
        </fieldset>
        <div v-else-if="!loading" class="text-[11px] text-neutral-600 italic">No hooks configured · edit .vibeflow/hooks.yaml to add</div>

        <!-- #556 #576: env-scrub policy for spawned engines -->
        <EnvScrubEditor v-model="form.envPolicy" />

        <!-- #689: curator scheduling + findings -->
        <CuratorSettings v-if="form.curator" v-model="form.curator" @validity="curatorValid = $event" />

        <div v-if="err" class="flex items-start gap-2 p-2 rounded border border-neutral-800 text-red-400 text-xs">
          <span class="shrink-0">⚠</span><span>{{ err }}</span>
        </div>
        <div v-if="saved" class="flex items-center gap-1.5 text-xs text-neutral-400">
          <span>✓</span><span>Saved</span>
        </div>

        <!-- Unsaved changes indicator -->
        <div v-if="isDirty && !saved" class="text-[11px] text-neutral-600 text-right">
          Unsaved changes
        </div>

        <PolicyDiffModal
          v-if="policyPreview"
          :preview="policyPreview"
          @cancel="policyPreview = null"
          @apply="applyPolicy"
        />

        <!-- Discard confirm inline -->
        <div v-if="showDiscardConfirm" class="flex items-center justify-between gap-3 px-3 py-2 rounded border border-neutral-800 text-xs">
          <span class="text-neutral-400">Discard unsaved changes?</span>
          <div class="flex gap-2">
            <button type="button" class="text-neutral-500 hover:text-neutral-200 transition-colors" @click="showDiscardConfirm = false">Keep editing</button>
            <button type="button" class="text-red-400 hover:text-red-300 transition-colors" @click="emit('close')">Discard</button>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="px-3 py-1.5 rounded border border-neutral-800 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors" @click="confirmClose">Cancel</button>
          <button type="submit" class="btn-primary" :disabled="saving || !curatorValid">
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../api.js";
import type { PolicyPreview, VibeSettings } from "../types.js";
import CuratorSettings from "./CuratorSettings.vue";
import EnvScrubEditor from "./EnvScrubEditor.vue";
import InfoTip from "./InfoTip.vue";
import PolicyDiffModal from "./PolicyDiffModal.vue";

/** Deep clone — avoids aliasing the shared API-cached object. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const err = ref<string | null>(null);
const form = ref<VibeSettings | null>(null);
const policyPreview = ref<PolicyPreview | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const showDiscardConfirm = ref(false);
/** #689: curator schedule validity — blocks Save when invalid. */
const curatorValid = ref(true);
/** Deep clone of original for dirty-checking — avoids mutating shared API cache */
const original = ref<VibeSettings | null>(null);

const isDirty = computed(() => {
  if (!form.value || !original.value) return false;
  return JSON.stringify(form.value) !== JSON.stringify(original.value);
});

onMounted(async () => {
  // ESC on document so it works regardless of focus position
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") confirmClose();
  };
  // focusin guard: if focus leaves the dialog, pull it back to first focusable
  const onFocusIn = (e: FocusEvent) => {
    if (!dialogEl.value) return;
    if (!dialogEl.value.contains(e.target as Node)) {
      e.stopPropagation();
      const first = dialogEl.value.querySelector<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }
  };
  document.addEventListener("keydown", onEsc);
  document.addEventListener("focusin", onFocusIn, true);
  onUnmounted(() => {
    document.removeEventListener("keydown", onEsc);
    document.removeEventListener("focusin", onFocusIn, true);
  });
  // Focus the dialog container so keyboard users are oriented
  dialogEl.value?.focus();
  try {
    const settings = await api.settings.get();
    // Deep clone so edits don't mutate the API-cached object
    form.value = JSON.parse(JSON.stringify(settings)) as VibeSettings;
    original.value = JSON.parse(JSON.stringify(settings)) as VibeSettings;
    // Coerce envPolicy → {} on BOTH so EnvScrubEditor's v-model binds an object
    // AND the dirty-check baseline matches (else isDirty is true on open).
    if (form.value && !form.value.envPolicy) form.value.envPolicy = {};
    if (original.value && !original.value.envPolicy) original.value.envPolicy = {};
    // #689: coerce missing curator → defaults on BOTH (same rationale as envPolicy)
    // so the CuratorSettings editor binds and the dirty baseline matches.
    if (form.value && !form.value.curator) {
      form.value.curator = {
        enabled: false,
        observeMode: true,
        schedule: "0 9 * * 1",
        severityThreshold: "medium",
      };
    }
    if (original.value && !original.value.curator) {
      original.value.curator = {
        enabled: false,
        observeMode: true,
        schedule: "0 9 * * 1",
        severityThreshold: "medium",
      };
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

function confirmClose() {
  // If discard confirm is showing, second ESC dismisses it (back to editing)
  if (showDiscardConfirm.value) {
    showDiscardConfirm.value = false;
    return;
  }
  // Skip confirm if no unsaved changes or already saved
  if (!isDirty.value || saved.value) {
    emit("close");
    return;
  }
  // Show inline confirm instead of window.confirm (which blocks in headless/some browsers)
  showDiscardConfirm.value = true;
}

/** Keep Tab/Shift-Tab inside the dialog */
function trapFocus(e: KeyboardEvent) {
  const el = dialogEl.value;
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

async function save() {
  if (!form.value) return;
  // Clamp timeout to valid range before saving
  form.value.failureProtection.timeoutSeconds = Math.min(
    3600,
    Math.max(0, form.value.failureProtection.timeoutSeconds),
  );
  saving.value = true;
  try {
    err.value = null;
    const originalPolicy = pickPolicy(original.value);
    const nextPolicy = pickPolicy(form.value);
    // #692: sensitive policy changes (envPolicy / hooks) go through a
    // server-generated preview + exact confirmation. Non-sensitive settings
    // keep the direct save path.
    if (JSON.stringify(originalPolicy) !== JSON.stringify(nextPolicy)) {
      policyPreview.value = await api.settings.previewPolicy(nextPolicy);
    } else {
      const savedSettings = await api.settings.set(form.value);
      original.value = JSON.parse(JSON.stringify(savedSettings)) as VibeSettings;
      saved.value = true;
      setTimeout(() => emit("close"), 1500);
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/** Extract just the policy fields for #692 preview routing / dirty baseline. */
function pickPolicy(s: VibeSettings | null): Pick<VibeSettings, "envPolicy" | "hooks"> {
  if (!s) return {};
  return {
    ...(s.envPolicy ? { envPolicy: s.envPolicy } : {}),
    ...(s.hooks ? { hooks: s.hooks } : {}),
  };
}

/** #692: apply a confirmed preview; close on success. */
async function applyPolicy(confirmation: string) {
  if (!policyPreview.value) return;
  saving.value = true;
  try {
    err.value = null;
    // #692: apply sends non-policy settings as the payload so policy + regular
    // edits land in ONE server write — no separate /api/settings POST.
    const { envPolicy: _ep, hooks: _hk, ...nonPolicy } = form.value as VibeSettings;
    const savedSettings = await api.settings.applyPolicy(
      policyPreview.value.id,
      policyPreview.value.relaxation ? confirmation : "",
      { ...nonPolicy },
    );
    original.value = clone(savedSettings);
    saved.value = true;
    policyPreview.value = null;
    setTimeout(() => emit("close"), 500);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>


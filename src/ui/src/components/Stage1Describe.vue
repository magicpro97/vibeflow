<template>
  <div class="space-y-5" style="width:min(100%,36rem)">

    <div class="flex items-baseline justify-between">
      <h1 class="text-sm font-semibold text-neutral-100">Describe your task</h1>
      <button
        v-if="store.state?.goal && store.state.goal !== '__CLEAR__'"
        type="button"
        class="text-[10px] text-neutral-700 hover:text-neutral-400 transition-colors"
        title="Clear current task and start fresh"
        @click="clearTask"
      >clear current task</button>
    </div>
    <p class="text-[11px] text-neutral-600 mt-0.5">Tell VibeFlow what to fix or build, point it at your repo, and AI agents will do the work.</p>

    <!-- Version mismatch banner -->
    <div
      v-if="versionMismatch"
      class="flex items-start gap-2 p-2.5 rounded border border-amber-800/50 bg-amber-950/30 text-amber-400 text-[11px]"
      role="alert"
    >
      <span class="shrink-0 mt-0.5">⚠</span>
      <span>
        Project was initialized with vf <strong>{{ store.state?.vibeflow_version }}</strong>,
        current server is <strong>{{ store.version }}</strong>.
        Click <strong>Save</strong> or <strong>Plan</strong> to re-initialize with the new version.
      </span>
    </div>

    <!-- Repo path + detect -->
    <div class="space-y-1.5">
      <label for="repo-path" class="text-xs text-neutral-500 flex items-center justify-between">
        <span>Repository</span>
        <button
          type="button"
          class="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors underline underline-offset-2 decoration-neutral-700"
          title="Use the directory where VibeFlow server was started"
          :disabled="detectingCwd"
          @click="useCwd"
        >{{ detectingCwd ? 'detecting…' : '⌖ use current directory' }}</button>
      </label>
      <div class="flex gap-2">
        <input
          id="repo-path"
          v-model="form.repoPath"
          type="text"
          placeholder="/path/to/repo (not ~/...)"
          class="flex-1 box-border bg-transparent border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
          @blur="form.repoPath.trim() && !detectInfo && !detecting && runDetect()"
          @input="detectInfo = null; detectWarn = false; detectErr = null; engineWarning = null; detected = false"
        />
        <button
          class="px-2 py-1.5 rounded border border-neutral-800 text-xs text-neutral-500 hover:border-neutral-600 hover:text-neutral-200 transition-colors disabled:opacity-40 flex-shrink-0"
          :disabled="detecting || !form.repoPath.trim()"
          :title="detecting ? 'Detecting…' : 'Detect repo & engines'"
          @click="runDetect"
        >
          <span v-if="detecting" class="inline-block w-3 h-3 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>
          </svg>
        </button>
      </div>
      <!-- Recent repos pill list -->
      <div v-if="repoHistory.length" class="flex flex-wrap gap-1.5">
        <button
          v-for="r in repoHistory"
          :key="r"
          class="text-[10px] text-neutral-600 hover:text-neutral-300 px-1.5 py-0.5 rounded border border-neutral-800/60 hover:border-neutral-700 transition-colors font-mono truncate max-w-48"
          :title="r"
          @click="form.repoPath = r; detectInfo = null; detectErr = null"
        >{{ r.split('/').at(-1) }}</button>
      </div>
      <p v-if="detectInfo" class="text-[11px] flex items-center gap-1" :class="detectWarn ? 'text-amber-500' : 'text-neutral-500'">
        <span v-if="!detectWarn" class="text-neutral-600">✓</span>{{ detectInfo }}
      </p>
      <p v-if="detectErr" class="text-[11px] text-red-400">{{ detectErr }}</p>
      <!-- Engine readiness warning — only shown when detect succeeds and no engine is ready -->
      <p v-if="engineWarning" class="text-[11px] text-amber-500/80">
        ⚠ {{ engineWarning }}
      </p>
    </div>

    <!-- Goal -->
    <div class="space-y-1.5">
      <label for="goal" class="text-xs text-neutral-500 flex items-baseline justify-between">
        <span>What needs to be done</span>
        <span v-if="form.goal.length > 8000" class="tabular-nums" :class="form.goal.length > 9500 ? 'text-red-400' : 'text-neutral-600'">{{ form.goal.length }}/10,000</span>
      </label>
      <textarea
        id="goal"
        v-model="form.goal"
        rows="3"
        maxlength="10000"
        placeholder="Describe the task, bug, or feature…"
        class="w-full box-border bg-transparent border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors resize-none overflow-hidden"
        style="min-height:74px"
        @input="($event.target as HTMLTextAreaElement).style.height='auto';($event.target as HTMLTextAreaElement).style.height=($event.target as HTMLTextAreaElement).scrollHeight+'px'"
        @keydown.meta.enter="!submitting && form.goal.trim() && form.repoPath.trim() && submit()"
        @keydown.ctrl.enter="!submitting && form.goal.trim() && form.repoPath.trim() && submit()"
      />
    </div>

    <!-- Success criteria -->
    <div class="space-y-1.5">
      <label for="success-criteria" class="text-xs text-neutral-500 flex items-center">
        Success criteria
        <InfoTip tip="One per line. Agents check these before marking a task done. E.g. 'All tests pass'." />
      </label>
      <textarea
        id="success-criteria"
        v-model="criteriaRaw"
        rows="3"
        placeholder="Tests pass&#10;No regressions"
        class="w-full box-border bg-transparent border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors resize-y"
      />
    </div>

    <!-- Engines -->
    <div class="space-y-1.5">
      <label class="text-xs text-neutral-500 flex items-center">
        Engine
        <InfoTip tip="AI engine to use: claude (Anthropic), codex (OpenAI), or copilot (GitHub). Auto-detected on scan." />
      </label>
      <div class="flex flex-col gap-2">
        <label v-for="eng in engines" :key="eng.key" class="flex flex-col cursor-pointer">
          <div class="flex items-center gap-1.5 text-sm">
            <input type="radio" :value="eng.key" v-model="selectedEngine" class="accent-neutral-400" />
            <span class="text-neutral-200">{{ eng.key }}</span>
            <span v-if="recommendedEngine===eng.key" class="text-[10px] text-yellow-400 ml-1">★ Recommended</span>
            <span v-if="readyEngines.size>0 && !readyEngines.has(eng.key)" class="text-[10px] text-neutral-700 ml-1">not authenticated</span>
          </div>
          <span class="text-[10px] text-neutral-600 block ml-5">{{ ENGINE_HINTS[eng.key] }}</span>
        </label>
      </div>
    </div>

    <!-- Advanced options (collapsed by default) -->
    <details class="group">
      <summary class="text-xs text-neutral-500 hover:text-neutral-300 cursor-pointer select-none list-none flex items-center gap-1.5 py-0.5">
        <svg class="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Advanced
        <span v-if="docSources.filter(s=>s.ref.trim()).length + taskSources.filter(s=>s.ref.trim()).length + workflowSteps.filter(Boolean).length + attachments.length > 0"
          class="text-[10px] text-neutral-600">
          ({{ docSources.filter(s=>s.ref.trim()).length + taskSources.filter(s=>s.ref.trim()).length + workflowSteps.filter(Boolean).length + attachments.length }} set)
        </span>
      </summary>

      <div class="space-y-4 mt-3 pl-1">
        <!-- Doc sources -->
        <div class="space-y-1.5">
          <label class="text-xs text-neutral-500 flex items-center">
            Doc sources
            <InfoTip tip="URLs or file paths the agent reads as reference docs — API specs, READMEs, design guides." />
          </label>
          <div v-for="(src, i) in docSources" :key="i" class="flex gap-2 mb-1">
            <select
              v-model="src.type"
              class="bg-transparent border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
            >
              <option value="url">url</option>
              <option value="file">file</option>
            </select>
            <input
              v-model="src.ref"
              type="text"
              :placeholder="src.type === 'file' ? 'Absolute server-side path, e.g. /srv/docs/api.md' : 'https://…'"
              :class="['flex-1 bg-transparent border rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors',
                src.type === 'url' && src.ref.trim() && !isValidUrl(src.ref)
                  ? 'border-red-700'
                  : 'border-neutral-800']"
            />
            <button
              class="text-neutral-600 hover:text-neutral-300 transition-colors"
              :aria-label="`Remove doc source ${i + 1}`"
              @click="docSources.splice(i, 1)"
            >✕</button>
          </div>
          <p v-if="docSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref))" class="text-[11px] text-red-400">Must be a valid http:// or https:// URL</p>
          <button
            class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            @click="docSources.push({ type: 'url', ref: '' })"
          >+ add doc source</button>
        </div>

        <!-- Task sources -->
        <div class="space-y-1.5">
          <label class="text-xs text-neutral-500 flex items-center">
            Task sources
            <InfoTip tip="URLs or files listing what needs doing — GitHub issues, Jira exports, a markdown TODO list." />
          </label>
          <div v-for="(src, i) in taskSources" :key="i" class="flex gap-2 mb-1">
            <select
              v-model="src.type"
              class="bg-transparent border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
            >
              <option value="url">url</option>
              <option value="file">file</option>
            </select>
            <input
              v-model="src.ref"
              type="text"
              :placeholder="src.type === 'file' ? 'Absolute server-side path, e.g. /srv/tasks/sprint.md' : 'https://…'"
              :class="['flex-1 bg-transparent border rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors',
                src.type === 'url' && src.ref.trim() && !isValidUrl(src.ref)
                  ? 'border-red-700'
                  : 'border-neutral-800']"
            />
            <button
              class="text-neutral-600 hover:text-neutral-300 transition-colors"
              :aria-label="`Remove task source ${i + 1}`"
              @click="taskSources.splice(i, 1)"
            >✕</button>
          </div>
          <p v-if="taskSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref))" class="text-[11px] text-red-400">Must be a valid http:// or https:// URL</p>
          <button
            class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            @click="taskSources.push({ type: 'url', ref: '' })"
          >+ add task source</button>
        </div>

        <!-- Workflow steps -->
        <div class="space-y-1.5">
          <label class="text-xs text-neutral-500 flex items-center">
            Workflow steps
            <InfoTip tip="Override with explicit steps when you know the sequence — e.g. 'Step 1: write tests, Step 2: implement'." />
          </label>
          <div v-for="(step, i) in workflowSteps" :key="i" class="flex gap-2 mb-1 items-center">
            <span class="text-xs text-neutral-500 w-5 text-right">{{ i + 1 }}.</span>
            <input
              v-model="workflowSteps[i]"
              type="text"
              placeholder="Step description…"
              class="flex-1 box-border bg-transparent border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
            />
            <button
              class="border border-neutral-800 hover:border-neutral-600 text-neutral-500 hover:text-neutral-200 bg-transparent px-1.5 py-1 rounded text-xs disabled:opacity-30 transition-colors"
              :disabled="i === 0"
              :aria-label="`Move step ${i + 1} up`"
              @click="swapSteps(i - 1, i)"
            >↑</button>
            <button
              class="border border-neutral-800 hover:border-neutral-600 text-neutral-500 hover:text-neutral-200 bg-transparent px-1.5 py-1 rounded text-xs disabled:opacity-30 transition-colors"
              :disabled="i === workflowSteps.length - 1"
              :aria-label="`Move step ${i + 1} down`"
              @click="swapSteps(i, i + 1)"
            >↓</button>
            <button
              class="text-neutral-600 hover:text-neutral-300 transition-colors"
              :aria-label="`Remove step ${i + 1}`"
              @click="workflowSteps.splice(i, 1)"
            >✕</button>
          </div>
          <button
            class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="workflowSteps.some((s) => !s.trim())"
            :title="workflowSteps.some((s) => !s.trim()) ? 'Fill in the current empty step first' : undefined"
            @click="workflowSteps.push('')"
          >+ add step</button>
        </div>

        <!-- Attachments -->
        <div class="space-y-1.5">
          <label class="text-xs text-neutral-500 flex items-center">
            Attachments
            <InfoTip tip="Files the agent can read — screenshots, logs, specs, CSV data." />
          </label>
          <div v-if="attachments.length" class="space-y-1">
            <div v-for="att in attachments" :key="att.name" class="flex items-center gap-2 text-xs">
              <span class="font-mono text-neutral-400 flex-1 truncate" :title="att.name">{{ att.name }}</span>
              <span class="text-neutral-700 text-[10px]">{{ att.size > 1024 ? `${(att.size/1024).toFixed(1)}k` : `${att.size}b` }}</span>
              <span class="text-[10px] text-neutral-800 font-mono" :title="`Agent will use ${att.skill} to read this file`">{{ att.skill?.replace(/-reader$/,'').replace(/-/g,' ') }}</span>
              <button
                class="text-neutral-700 hover:text-red-400 transition-colors"
                :aria-label="`Remove ${att.name}`"
                @click="removeAttachment(att.name)"
              >✕</button>
            </div>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              ref="fileInput"
              type="file"
              class="hidden"
              multiple
              accept=".txt,.md,.csv,.json,.yaml,.yml,.log,.png,.jpg,.jpeg,.gif,.pdf"
              @change="handleFileUpload"
            />
            <button
              type="button"
              class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
              :disabled="uploading"
              @click="fileInput?.click()"
            >{{ uploading ? 'uploading…' : '+ attach file' }}</button>
          </label>
        </div>
      </div>
    </details>

    <div v-if="err" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-xs" role="alert" aria-live="assertive">
      <span class="mt-0.5 shrink-0">⚠</span>
      <span>{{ err }}</span>
    </div>

    <div class="pt-2 space-y-2">
      <div class="flex gap-2">
        <button
          id="plan-btn"
          class="btn-primary flex-1 justify-center"
          :disabled="submitting || detecting || !form.goal.trim() || form.goal.trim() === '__CLEAR__' || !form.repoPath.trim() || !selectedEngine || !!detectErr || docSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref)) || taskSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref))"
          :title="!detected ? 'Detect repo & engines first to continue' : detecting ? 'Detecting repo…' : detectErr ? 'Fix the repository path first' : !form.repoPath.trim() ? 'Enter a repo path first' : !form.goal.trim() ? 'Enter a goal first' : form.goal.trim() === '__CLEAR__' ? 'Reserved value — enter a different goal' : !selectedEngine ? 'Select at least one engine' : docSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref)) || taskSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref)) ? 'Fix invalid URLs first' : 'Plan — ⌘↵ also works'"
          @click="submit"
        >
          <span v-if="submitting" class="inline-block w-3 h-3 border-2 border-neutral-400/30 border-t-neutral-900 rounded-full animate-spin mr-1.5" />
          {{ submitting ? "Planning…" : "Plan" }}
        </button>
        <button
          class="px-3 py-1.5 rounded border border-neutral-800 text-xs text-neutral-500 hover:border-neutral-600 hover:text-neutral-200 transition-colors disabled:opacity-40 flex-shrink-0"
          :disabled="saving || detecting || !form.goal.trim() || form.goal.trim() === '__CLEAR__' || !form.repoPath.trim() || !selectedEngine || !!detectErr || docSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref)) || taskSources.some(s=>s.type==='url'&&s.ref.trim()&&!isValidUrl(s.ref))"
          :title="!detected ? 'Detect repo & engines first to continue' : 'Save config without planning — runs init only'"
          @click="saveInit"
        >
          <span v-if="saving" class="inline-block w-3 h-3 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
          <span v-else>Save</span>
        </button>
      </div>
      <p class="text-[11px] text-neutral-700 text-center">
        <kbd class="font-mono">⌘↵</kbd> to submit · <kbd class="font-mono">Tab</kbd> to navigate
      </p>
      <p v-if="!detected" class="text-xs text-amber-400 mt-2" role="alert">⚠ Click "Detect repo &amp; engines" above to enable Plan and Save.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { api } from "../api.js";
import { useVfStore } from "../store.js";
import type { Attachment } from "../types.js";
import InfoTip from "./InfoTip.vue";

interface Source {
  type: "url" | "file";
  ref: string;
}

const ENGINE_HINTS: Record<string, string> = {
  claude: "Best for complex reasoning, architecture, multi-file changes",
  codex: "Fast, focused on code generation and completions",
  copilot: "GitHub-integrated, good for PR-context tasks",
};

const store = useVfStore();

// Show when project was inited with an older vf version
const versionMismatch = computed(() => {
  const stateVer = store.state?.vibeflow_version;
  return stateVer && store.version && stateVer !== store.version;
});

// Repo history from localStorage — max 5 entries
const HISTORY_KEY = "vf-repo-history";
const repoHistory = ref<string[]>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  })(),
);
function saveRepoHistory(path: string) {
  if (!path.trim()) return;
  const updated = [path, ...repoHistory.value.filter((r) => r !== path)].slice(0, 5);
  repoHistory.value = updated;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}
const detecting = ref(false);
const detectingCwd = ref(false);
const detected = ref(false);

/** Use server's CWD as repo path — works when user ran `vf ui` from their project root */
async function useCwd() {
  detectingCwd.value = true;
  detectErr.value = null;
  try {
    // Detect with empty path → server uses its CWD (where `vf ui` was run)
    const res = (await api.detect("")) as { repo?: string };
    if (res.repo) {
      form.repoPath = res.repo;
      saveRepoHistory(res.repo);
    }
  } catch (e) {
    detectErr.value = "Could not detect current directory";
    console.warn("[vibeflow] useCwd failed:", e);
  } finally {
    detectingCwd.value = false;
  }
  // Run detect after clearing cwd loading state so user sees normal detect flow
  if (form.repoPath) await runDetect();
}
const submitting = ref(false);
const saving = ref(false);
const err = ref<string | null>(null);
const detectInfo = ref<string | null>(null);
const detectWarn = ref(false);
const detectErr = ref<string | null>(null);
const engineWarning = ref<string | null>(null);

async function clearTask() {
  if (!confirm("Clear the current task? This removes all tasks and uploaded files.")) return;
  try {
    // Delete all server-side attachments first (best-effort)
    for (const att of attachments.value) {
      await api.deleteAttachment(att.name).catch(() => {});
    }
    // Delete state on server
    await api.clearState();
    store.state = null;
    form.goal = "";
    form.repoPath = "";
    criteriaRaw.value = "";
    detectInfo.value = null;
    detectErr.value = null;
    engineWarning.value = null;
    attachments.value = [];
    // Clear Advanced section too — old sources/steps would persist otherwise
    docSources.splice(0);
    taskSources.splice(0);
    workflowSteps.splice(0);
    // Reset engine selection to defaults
    selectedEngine.value = "claude";
    readyEngines.value = new Set();
    recommendedEngine.value = "claude";
    store.setStage(1); // land on fresh describe form
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

// Pre-populate from existing state when user comes back via Replan
const existingState = store.state;
const criteriaRaw = ref(existingState?.success_criteria?.join("\n") ?? "");
const form = reactive({
  repoPath: existingState?.repo_path ?? repoHistory.value[0] ?? "",
  goal: existingState?.goal ?? "",
});

/** Quick URL syntax check — catches garbage like "not-a-url" before submit. */
function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const engines = reactive([{ key: "claude" }, { key: "codex" }, { key: "copilot" }]);
const selectedEngine = ref("claude");
const readyEngines = ref<Set<string>>(new Set());
const recommendedEngine = ref("claude");

// ── Attachments ────────────────────────────────────────────────────────────
const attachments = ref<Attachment[]>(existingState?.attachments ?? []);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

// Global ⌘↵ / Ctrl+↵ — submit from any field including success-criteria
function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (
      !submitting.value &&
      form.goal.trim() &&
      form.repoPath.trim() &&
      !!selectedEngine.value &&
      !detectErr.value
    ) {
      e.preventDefault();
      submit();
    }
  }
}
onMounted(async () => {
  document.addEventListener("keydown", onGlobalKey);
  // Prefill from "Reuse" action on ProjectList (one-shot)
  if (store.reuseGoal) {
    form.goal = store.reuseGoal;
    store.reuseGoal = null;
  }
  // Focus repo-path on first visit (no existing state) so user can type immediately
  if (!existingState?.goal) {
    document.getElementById("repo-path")?.focus();
  }
  try {
    attachments.value = (await api.attachments()) as Attachment[];
  } catch {
    /* attachments are optional */
  }
});
onUnmounted(() => document.removeEventListener("keydown", onGlobalKey));

async function handleFileUpload(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  uploading.value = true;
  try {
    for (const file of Array.from(files)) {
      if (file.size > 50 * 1024 * 1024) {
        err.value = `${file.name} is too large (max 50 MB)`;
        continue;
      }
      const r = await api.upload(file);
      if (r?.attachments) attachments.value = r.attachments as Attachment[];
    }
  } catch (uploadErr) {
    err.value = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}

async function removeAttachment(name: string) {
  try {
    await api.deleteAttachment(name);
    attachments.value = attachments.value.filter((a) => a.name !== name);
  } catch {
    attachments.value = attachments.value.filter((a) => a.name !== name);
  }
}
const docSources = reactive<Source[]>([]);
const taskSources = reactive<Source[]>([]);
const workflowSteps = reactive<string[]>([]);

/** Safe in-place swap — avoids splice(i, 2, arr[i+1]!, arr[i]!) which can
 *  silently insert `undefined` when an element is an empty string. */
function swapSteps(a: number, b: number) {
  if (a < 0 || b >= workflowSteps.length) return;
  const tmp = workflowSteps[a] ?? "";
  workflowSteps[a] = workflowSteps[b] ?? "";
  workflowSteps[b] = tmp;
}

async function runDetect() {
  if (!form.repoPath.trim()) return;
  // Expand ~ to home directory hint — browser can't resolve it, show user the full path needed
  if (form.repoPath.startsWith("~/") || form.repoPath === "~") {
    detectErr.value = "Use the full path instead of ~  (run 'pwd' in your terminal to get it)";
    detecting.value = false;
    return;
  }
  detecting.value = true;
  const pathAtDetect = form.repoPath; // snapshot — discard result if user changed path
  detectInfo.value = null;
  detectWarn.value = false;
  err.value = null;
  try {
    const res = (await api.detect(form.repoPath)) as {
      ok: boolean;
      repo?: string;
      isGit?: boolean;
      engines?: Record<string, boolean>;
      clis?: Record<string, boolean>;
    };
    // Discard stale detect result if user changed the path while detect was in-flight
    if (form.repoPath !== pathAtDetect) return;
    if (res.engines) {
      for (const eng of engines) {
        const ready = !!(res.engines[eng.key] || res.clis?.[eng.key]);
        // Auto-select first ready engine found
        if (ready && !readyEngines.value.has(eng.key)) {
          readyEngines.value = new Set([...readyEngines.value, eng.key]);
        }
      }
    }
    const parts: string[] = [];
    if (res.repo) parts.push(res.repo);
    const notGit = res.isGit === false;
    if (res.isGit !== undefined) parts.push(res.isGit ? "git ✓" : "⚠ not a git repo");
    detectInfo.value = parts.join(" · ") || "detected";
    detectWarn.value = notGit;
    detectErr.value = null;
    err.value = null;
    saveRepoHistory(form.repoPath);
    detected.value = true;
    detecting.value = false; // unblock Plan button before slow preflight call
    // Check engine readiness — warn early if no engine is installed (non-blocking)
    try {
      const pf = (await api.preflight()) as {
        anyReady?: boolean;
        readiness?: { engine: string; level: string }[];
      };
      if (pf && !pf.anyReady) {
        const notReady = pf.readiness
          ?.filter((r) => r.level !== "ready")
          .map((r) => r.engine)
          .join(", ");
        engineWarning.value = `No AI engine available (${notReady || "none"} not ready). Install claude, codex, or copilot CLI before dispatching.`;
      } else {
        engineWarning.value = null;
      }
      // Populate readyEngines + recommendedEngine from preflight results
      const readinessArr = pf?.readiness ?? [];
      const ENGINE_PRIORITY = ["claude", "copilot", "codex"] as const;
      const readyKeys = readinessArr
        .filter((r: { level: string }) => r.level === "ready")
        .map((r: { engine: string }) => r.engine);
      readyEngines.value = new Set(readyKeys);
      const first = ENGINE_PRIORITY.find((e) => readyEngines.value.has(e));
      if (first) {
        recommendedEngine.value = first;
        selectedEngine.value = first;
      }
    } catch {
      engineWarning.value = null; // preflight failure is non-blocking
    }
  } catch (e) {
    // Show detect error inline near the input, not in the global error box
    const msg = String(e);
    detectErr.value =
      msg.includes("path not found") || msg.includes("not a directory")
        ? "Path not found — enter a valid directory. Tip: run `pwd` in your terminal to get the current path"
        : "Could not detect repo";
    detectInfo.value = null;
  } finally {
    detecting.value = false;
  }
}

async function callInit(): Promise<boolean> {
  if (detecting.value) return false;
  if (form.repoPath.trim() && !detectInfo.value) {
    await runDetect();
    if (detectErr.value) return false;
  }
  err.value = null;
  const selectedEngines = [selectedEngine.value].filter(Boolean);
  await api.init({
    repoPath: form.repoPath,
    goal: form.goal,
    successCriteria: criteriaRaw.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    engines: selectedEngines,
    docSources: docSources.filter((s) => s.ref.trim()),
    taskSources: taskSources.filter((s) => s.ref.trim()),
    workflowSteps: workflowSteps.filter(Boolean),
  });
  if (selectedEngines[0]) {
    try {
      localStorage.setItem("vf-engine", selectedEngines[0]);
    } catch {}
  }
  await store.loadState();
  return true;
}

async function saveInit() {
  saving.value = true;
  try {
    await callInit();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function submit() {
  submitting.value = true;
  try {
    const ok = await callInit();
    if (ok) store.setStage(2);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    @click.self="$emit('close')"
    @keydown.esc.window="$emit('close')"
  >
    <div
      class="bg-neutral-950 border border-neutral-800 rounded w-full max-w-lg p-5 max-h-[calc(100vh-4rem)] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ask-title"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 id="ask-title" class="font-semibold text-neutral-100">Ask about code</h2>
        <button
          class="text-neutral-500 hover:text-neutral-200 text-xl leading-none"
          aria-label="Close ask"
          @click="$emit('close')"
        >
          ×
        </button>
      </div>

      <p class="text-[11px] text-neutral-500 mb-3">
        Ask a ready engine about a snippet. Path is relative to the active repo.
      </p>

      <div class="space-y-3">
        <div>
          <label class="block text-xs text-neutral-400 mb-1" for="ask-path">File path</label>
          <input
            id="ask-path"
            v-model="form.path"
            type="text"
            placeholder="src/cli.ts"
            class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none"
          />
        </div>
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-xs text-neutral-400 mb-1" for="ask-start">Start line</label>
            <input
              id="ask-start"
              v-model="form.start"
              type="number"
              min="1"
              class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none"
            />
          </div>
          <div class="flex-1">
            <label class="block text-xs text-neutral-400 mb-1" for="ask-end">End line (opt)</label>
            <input
              id="ask-end"
              v-model="form.end"
              type="number"
              min="1"
              class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none"
            />
          </div>
          <div class="flex-1">
            <label class="block text-xs text-neutral-400 mb-1" for="ask-engine">Engine</label>
            <select
              id="ask-engine"
              v-model="form.engine"
              class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none"
            >
              <option value="">auto</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="copilot">copilot</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-xs text-neutral-400 mb-1" for="ask-q">Question</label>
          <textarea
            id="ask-q"
            v-model="form.question"
            rows="2"
            placeholder="What does this do?"
            class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none resize-y"
          />
        </div>

        <div v-if="err" class="flex items-start gap-2 p-2 rounded border border-red-900/50 text-red-400 text-xs">
          <span class="shrink-0">⚠</span><span>{{ err }}</span>
        </div>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded border border-neutral-800 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
            @click="$emit('close')"
          >
            Close
          </button>
          <button
            type="button"
            :disabled="loading"
            class="px-3 py-1.5 rounded bg-neutral-100 text-neutral-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
            @click="submit"
          >
            {{ loading ? "Asking…" : "Ask" }}
          </button>
        </div>

        <div v-if="answer" class="mt-2">
          <div class="text-[11px] text-neutral-500 mb-1">{{ answerEngine }} answered:</div>
          <pre class="bg-neutral-900 border border-neutral-800 rounded p-3 text-[11px] text-neutral-200 whitespace-pre-wrap overflow-x-auto">{{ answer }}</pre>
        </div>

        <!-- #581: Continue (resume) affordance after first answer -->
        <div v-if="answer && answerEngine !== 'copilot'" class="mt-2 space-y-2">
          <textarea
            v-model="followup"
            rows="2"
            placeholder="Follow-up question…"
            class="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 outline-none resize-y"
            :disabled="continuing"
          />
          <button
            type="button"
            :disabled="continuing || !followup.trim()"
            class="px-3 py-1.5 rounded bg-neutral-800 text-neutral-200 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50 transition-colors"
            @click="doContinue"
          >
            {{ continuing ? "Continuing…" : "Continue" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "../api.js";
import { type AskForm, validateAskForm, validateResumeForm } from "../ask-client.js";

defineEmits<{ close: [] }>();

const form = reactive<AskForm>({ path: "", start: "1", end: "", question: "", engine: "" });
const loading = ref(false);
const err = ref("");
const answer = ref("");
const answerEngine = ref("");
const followup = ref("");
const continuing = ref(false);

function consume(es: EventSource) {
  es.addEventListener("token", (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { text: string };
    answer.value += data.text;
  });
  es.addEventListener("done", (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { engine: string; code: number; ok: boolean };
    answerEngine.value = data.engine;
    if (!data.ok) err.value = `Engine exited with code ${data.code}`;
    es.close();
    loading.value = false;
    continuing.value = false;
  });
  es.onerror = () => {
    es.close();
    if (!err.value) err.value = "Stream connection failed";
    loading.value = false;
    continuing.value = false;
  };
}

async function submit() {
  err.value = "";
  const payload = validateAskForm(form);
  if (typeof payload === "string") {
    err.value = payload;
    return;
  }
  loading.value = true;
  answer.value = "";
  answerEngine.value = "";
  followup.value = "";

  const es = new EventSource(api.ask.streamUrl(payload));
  consume(es);
}

async function doContinue() {
  err.value = "";
  const q = followup.value;
  const validated = validateResumeForm(q);
  if (typeof validated === "string") {
    err.value = validated;
    return;
  }
  continuing.value = true;
  // Capture the engine BEFORE clearing — resume must target the same engine
  // that answered, and clearing answerEngine drives the "Continue" v-if off.
  const resumeEngine = answerEngine.value;
  answer.value = "";
  answerEngine.value = "";

  const es = new EventSource(
    api.ask.streamUrl({ resume: true, question: validated.question, engine: resumeEngine }),
  );
  consume(es);
}
</script>

<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-control-center" aria-label="VibeFlow control center">
      <header class="home-control-center__header">
        <span><small>VibeFlow workspace</small><strong>Control center</strong></span>
        <button ref="closeButton" type="button" aria-label="Close control center" @click="emit('close')">×</button>
      </header>
      <p class="home-drawer-copy">Configure harness, agents, CLIs, capabilities, skills, and MCP servers from one place.</p>

      <section class="home-control-section" aria-labelledby="harness-title">
        <div class="home-control-section__heading"><span><small>Project bootstrap</small><strong id="harness-title">Harness initialization</strong></span><button type="button" :disabled="busy" @click="initialize(false)">{{ busy ? "Initializing…" : "Initialize harness" }}</button></div>
        <label class="home-control-path"><span>Repository</span><input v-model="repoPath" type="text" placeholder="/path/to/repo" @blur="detect" /><button type="button" :disabled="detecting" @click="detect">{{ detecting ? "Checking…" : "Detect" }}</button></label>
        <p v-if="detected" class="home-control-note">{{ detection?.isGit ? "Git repository detected" : "Directory detected — git protection unavailable" }}</p>
        <p v-if="message" class="home-control-message" role="status">{{ message }}</p>
        <p v-if="error" class="home-control-error" role="alert">{{ error }}</p>
      </section>

      <section class="home-control-section" aria-labelledby="agents-title">
        <div class="home-control-section__heading"><span><small>Runtime adapters</small><strong id="agents-title">Agents and CLIs</strong></span><button type="button" :disabled="busy || !detected" @click="initialize(true)">{{ busy ? "Working…" : "Initialize agent" }}</button></div>
        <p class="home-control-note">Select CLI(s) for init and dispatch. Unchecked CLIs remain installed but VibeFlow will not use them.</p>
        <div class="home-control-engine-list">
          <label v-for="engine in engines" :key="engine" class="home-control-engine">
            <input v-model="enabledEngines" type="checkbox" :value="engine" @change="saveEnabledEngines" />
            <span><strong>{{ engine }}</strong><small>{{ detection?.engines[engine] ? "initialized" : "not initialized" }} · {{ detection?.clis[engine] ? "CLI ready" : "CLI unavailable" }}</small></span>
            <i :data-ready="detection?.clis[engine] === true" />
          </label>
        </div>
      </section>

      <section class="home-control-section" aria-labelledby="config-title">
        <div class="home-control-section__heading"><span><small>Central configuration</small><strong id="config-title">Settings</strong></span></div>
        <label class="home-control-toggle"><input v-model="settingsForm.memory" type="checkbox" /><span><strong>Memory</strong><small>Keep project context between sessions.</small></span></label>
        <label class="home-control-toggle"><input v-model="settingsForm.tools.codegraph" type="checkbox" /><span><strong>CodeGraph</strong><small>Code navigation and impact analysis.</small></span></label>
        <label class="home-control-toggle"><input v-model="settingsForm.tools.lsp" type="checkbox" /><span><strong>LSP Bridge</strong><small>Definitions, references, and diagnostics.</small></span></label>
        <button class="home-control-save" type="button" :disabled="saving" @click="saveSettings">{{ saving ? "Saving…" : "Save configuration" }}</button>
      </section>

      <section class="home-control-section" aria-labelledby="typesafe-title">
        <div class="home-control-section__heading"><span><small>Optional decision judge</small><strong id="typesafe-title">System One (Jev)</strong></span><button type="button" :disabled="typesafeTesting || typesafeStatus === 'loading' || typesafeSaveBlocked()" @click="testConnection">{{ typesafeTesting ? "Testing…" : "Test connection" }}</button></div>
        <p class="home-control-note">The judge can only reject a change sooner or raise a risk tier. It never opens a gate or skips a review, and it can only suggest an engine from the pool preflight already admitted. Off by default: with it off every path behaves exactly as it does today.</p>

        <p v-if="typesafeStatus === 'loading'" class="home-control-message" role="status" aria-live="polite" aria-busy="true">Loading System One settings…</p>
        <p v-else-if="typesafeStatus === 'error'" class="home-control-error" role="alert">System One connection failed — {{ typesafeError }}</p>
        <p v-else-if="typesafeView && !typesafeView.configured" class="home-control-message" role="status" aria-live="polite">No System One key configured — key missing: set the environment variable or run <code>vf config typesafe key</code>.</p>
        <p v-else-if="typesafeView?.state === 'open' || typesafeView?.state === 'half-open'" class="home-control-warning" role="alert">{{ typesafeView?.state === "half-open" ? `Circuit half-open — calls are refused while a single probe is in flight; the lease re-grants at ${typesafeView?.cooldownUntil ?? "the next window"}.` : `Circuit open — judge calls are paused until ${typesafeView?.cooldownUntil ?? "the cooldown ends"}.` }}</p>
        <p v-if="typesafeError && typesafeStatus !== 'error'" class="home-control-error" role="alert">{{ typesafeError }}</p>
        <p v-if="typesafeNeedsReload(typesafeRepo, repoPath)" class="home-control-warning" role="status">These rows describe {{ typesafeRepo }} — detect again to load the current repository.</p>

        <dl v-if="typesafeView" class="home-control-list">
          <div><dt>enabled</dt><dd>{{ typesafeView.enabled ? "on" : "off" }}</dd></div>
          <div><dt>configured</dt><dd>{{ typesafeView.configured ? "yes" : "no" }}</dd></div>
          <div><dt>state</dt><dd :data-state="typesafeView.state">{{ typesafeView.state }}</dd></div>
          <div><dt>key source</dt><dd>{{ typesafeView.keySource }}</dd></div>
          <div><dt>model</dt><dd>{{ typesafeView.model }}</dd></div>
          <div><dt>timeout</dt><dd>{{ typesafeView.timeoutMs }} ms</dd></div>
          <div v-if="typesafeView.lastCall"><dt>last call</dt><dd>{{ typesafeView.lastCall.caller }} · {{ typesafeView.lastCall.status ?? "—" }} · {{ typesafeView.lastCall.ms }} ms</dd></div>
        </dl>

        <label for="typesafe-enabled" class="home-control-toggle"><input id="typesafe-enabled" v-model="settingsForm.typesafe.enabled" type="checkbox" /><span><strong>Enable System One judge</strong><small>Off by default. The API key stays on the machine.</small></span></label>

        <label for="typesafe-run-threshold" class="home-control-field"><span>Run judge at confidence</span><input id="typesafe-run-threshold" v-model.number="settingsForm.typesafe.runAtConfidence" type="number" min="0" max="1" step="0.05" aria-describedby="typesafe-threshold-error" @blur="validateThresholds" /></label>
        <label for="typesafe-accept-threshold" class="home-control-field"><span>Accept verdict at confidence</span><input id="typesafe-accept-threshold" v-model.number="settingsForm.typesafe.acceptAtConfidence" type="number" min="0" max="1" step="0.05" aria-describedby="typesafe-threshold-error" @blur="validateThresholds" /></label>
        <p v-if="thresholdError" id="typesafe-threshold-error" class="home-control-error" role="alert">{{ thresholdError }}</p>

        <label for="typesafe-callsite-reviewer" class="home-control-toggle"><input id="typesafe-callsite-reviewer" v-model="settingsForm.typesafe.callSites.reviewer" type="checkbox" /><span><strong>reviewer</strong><small>Judge the unit diff before the engine reviewer.</small></span></label>
        <label for="typesafe-callsite-risk" class="home-control-toggle"><input id="typesafe-callsite-risk" v-model="settingsForm.typesafe.callSites.risk" type="checkbox" /><span><strong>risk</strong><small>Raise the risk tier of a proposed shell command.</small></span></label>
        <label for="typesafe-callsite-goalCoverage" class="home-control-toggle"><input id="typesafe-callsite-goalCoverage" v-model="settingsForm.typesafe.callSites.goalCoverage" type="checkbox" /><span><strong>goalCoverage</strong><small>Judge whether the change covers the goal.</small></span></label>
        <label for="typesafe-callsite-planner" class="home-control-toggle"><input id="typesafe-callsite-planner" v-model="settingsForm.typesafe.callSites.planner" type="checkbox" /><span><strong>planner</strong><small>Suggest an engine for a work unit.</small></span></label>

        <p v-if="typesafeProbe" class="home-control-message" role="status" aria-live="polite">{{ typesafeProbe }}</p>
        <button class="home-control-save typesafe-save" type="button" :disabled="typesafeSaveBlocked()" @click="saveTypesafe">{{ saving ? "Saving…" : "Save System One settings" }}</button>
      </section>

      <section class="home-control-section" aria-labelledby="capabilities-title">
        <div class="home-control-section__heading"><span><small>Fabric inventory</small><strong id="capabilities-title">Capabilities</strong></span><button type="button" @click="loadCapabilities">Refresh</button></div>
        <p class="home-control-note">{{ capabilities.length ? `${capabilities.length} capability package(s) visible` : "Open Capabilities drawer for scoped install and repair actions." }}</p>
      </section>

      <section class="home-control-section" aria-labelledby="skills-title">
        <div class="home-control-section__heading"><span><small>Knowledge layer</small><strong id="skills-title">Skills</strong></span><button type="button" @click="loadSkills">Refresh</button></div>
        <div v-if="skills.length" class="home-control-tags"><span v-for="skill in skills.slice(0, 8)" :key="skill.name">{{ skill.name }}</span></div>
        <p v-else class="home-control-note">No skills loaded yet. Refresh to inspect project and shared skills.</p>
      </section>

      <section class="home-control-section" aria-labelledby="mcp-title">
        <div class="home-control-section__heading"><span><small>Tool transport</small><strong id="mcp-title">MCP servers</strong></span></div>
        <div v-if="mcpServers.length" class="home-control-mcp-list"><span v-for="server in mcpServers" :key="server">{{ server }}</span></div>
        <p v-else class="home-control-note">No user MCP servers configured. Add them to .vibeflow/SETTINGS.json or CLI config.</p>
      </section>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref, watch } from "vue";
import { ENGINES, type Engine } from "../../../core/agent-contract.js";
import { CAPABILITY_SCOPE } from "../../../core/capability-contract.js";
import { api } from "../api.js";
import { conversationHomeApi } from "../conversation-home-api.js";
import type { ControlCenterCapability } from "../conversation-home-types.js";
import {
  type TypesafeSettingsView,
  type VibeSettings,
  emptyTypesafeForm,
  typesafeNeedsReload,
  typesafeSaveDisabled,
  typesafeThresholdError,
} from "../types-settings.js";
import type { RepoDetection, SafeSkill } from "../types.js";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const closeButton = ref<HTMLButtonElement | null>(null);
const repoPath = ref("");
const detection = ref<RepoDetection | null>(null);
const detected = ref(false);
const detecting = ref(false);
const busy = ref(false);
const saving = ref(false);
const message = ref("");
const error = ref("");
const engines = [...ENGINES];
const enabledEngines = ref<Engine[]>([...ENGINES]);
const skills = ref<SafeSkill[]>([]);
const capabilities = ref<ControlCenterCapability[]>([]);
const mcpServers = ref<string[]>([]);
const typesafeView = ref<TypesafeSettingsView | null>(null);
const typesafeStatus = ref<"loading" | "ready" | "error">("loading");
const typesafeError = ref("");
const typesafeProbe = ref("");
const typesafeTesting = ref(false);
const thresholdError = ref("");
/** Repo whose System One view the rows currently describe. */
const typesafeRepo = ref("");
/** Monotonic load generation; only the latest response is applied (see `loadTypesafe`). */
let typesafeLoadSeq = 0;
let typesafeProbeRepo = ""; // repo the current verdict describes; survives a re-open, not a repo change

/**
 * The form is seeded from the load, so it must never post before that load succeeded — and never
 * while the rows describe a repo the server is no longer going to write to. The Repository field's
 * `@blur` calls `POST /api/detect` (moving the server's active repo) the moment focus leaves, and
 * `POST /api/settings` writes to whichever repo is active when it lands; blocking the button while
 * the two disagree is what closes that cross-repo window.
 */
function typesafeSaveBlocked(): boolean {
  return typesafeSaveDisabled({
    saving: saving.value,
    status: typesafeStatus.value,
    thresholdError: thresholdError.value,
    rowsAreStale: typesafeNeedsReload(typesafeRepo.value, repoPath.value),
  });
}
const settingsForm = reactive({
  memory: false,
  tools: { codegraph: true, lsp: true },
  typesafe: emptyTypesafeForm(),
});

function validateThresholds(): void {
  thresholdError.value = typesafeThresholdError(settingsForm.typesafe);
}

async function loadTypesafe(): Promise<void> {
  const seq = ++typesafeLoadSeq; // without it a slower response wins and the rows go stale
  typesafeStatus.value = "loading";
  typesafeError.value = "";
  try {
    const view = await api.typesafe.view();
    if (seq !== typesafeLoadSeq) return;
    typesafeView.value = view;
    settingsForm.typesafe = {
      enabled: view.enabled,
      runAtConfidence: view.thresholds.run,
      acceptAtConfidence: view.thresholds.accept,
      callSites: { ...view.callSites },
    };
    validateThresholds();
    // Dropped when the rows land on a DIFFERENT repo, vs the INCOMING `view.repo`: the previous one
    // is equal by construction (so A's verdict survived B's rows). A plain re-open keeps it.
    if (typesafeProbeRepo !== "" && typesafeProbeRepo !== view.repo) typesafeProbe.value = "";
    typesafeRepo.value = view.repo; // from the RESPONSE: `repoPath` is live text and would lie
    typesafeStatus.value = "ready";
  } catch (cause) {
    if (seq !== typesafeLoadSeq) return;
    typesafeView.value = null;
    typesafeStatus.value = "error";
    typesafeProbe.value = ""; // renders regardless of status: would sit above "connection failed"
    typesafeProbeRepo = "";
    typesafeError.value = cause instanceof Error ? cause.message : "unreachable";
  }
}

async function testConnection(): Promise<void> {
  if (typesafeTesting.value) return;
  const probed = typesafeView.value?.repo ?? ""; // also null in the error state: "responded for :"
  if (probed === "") return;
  typesafeTesting.value = true;
  typesafeProbeRepo = probed; // BEFORE the await: a concurrent load for another repo must see it
  try {
    const result = await api.typesafe.test(probed);
    if (typesafeRepo.value !== probed) return; // superseded: not this repo's verdict
    typesafeProbe.value = result.ok
      ? `System One responded for ${probed}: covers_goal ${result.score} at confidence ${result.confidence ?? "unknown"} in ${result.ms} ms.`
      : `System One connection failed for ${probed} — ${result.error ?? "no verdict"}`;
  } catch (cause) {
    if (typesafeRepo.value !== probed) return; // superseded
    typesafeProbe.value = `System One connection failed for ${probed} — ${cause instanceof Error ? cause.message : "unreachable"}`;
  } finally {
    typesafeTesting.value = false;
  }
}

// Owns ONLY the fields it edits: the write re-coerces a partial block onto the STORED block
// (216a04f), so echoing the loaded snapshot merely reverted changes made elsewhere.
/** A refusal lands in `typesafeError`, bound to its own content. */
async function saveTypesafe(): Promise<void> {
  validateThresholds();
  if (thresholdError.value) return;
  const view = typesafeView.value; // unreachable from the UI; a zeros-only block would refill defaults
  if (!view) return;
  saving.value = true;
  try {
    await api.settings.set({
      // DISCARD the response (`applySettings` would overwrite memory/tools); the write lands in the
      // server's PROCESS-GLOBAL active repo, which another client can move unseen.
      expectRepo: view.repo,
      typesafe: {
        ...settingsForm.typesafe,
        callSites: { ...settingsForm.typesafe.callSites },
      },
    });
    typesafeProbe.value = "";
    typesafeProbeRepo = "";
    typesafeError.value = "";
    await loadTypesafe(); // this section's OWN surface, not the shared `message` up top
    typesafeProbe.value = "System One settings saved.";
  } catch (cause) {
    typesafeError.value = cause instanceof Error ? cause.message : "System One save failed";
    typesafeProbe.value = "";
    typesafeProbeRepo = "";
  } finally {
    saving.value = false;
  }
}

function applySettings(value: VibeSettings): void {
  settingsForm.memory = Boolean(value.memory);
  settingsForm.tools.codegraph = value.tools.codegraph;
  settingsForm.tools.lsp = value.tools.lsp;
  enabledEngines.value = value.enabledEngines?.length ? [...value.enabledEngines] : [...ENGINES];
  mcpServers.value = Object.keys(value.mcpServers ?? {});
}

async function load(): Promise<void> {
  error.value = "";
  try {
    const value = await api.settings.get();
    applySettings(value);
    await detect();
    await Promise.all([loadSkills(), loadCapabilities(), loadTypesafe()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load control center";
  }
}

async function detect(): Promise<void> {
  if (detecting.value) return;
  detecting.value = true;
  let reloadNeeded = false;
  try {
    detection.value = await api.detect(repoPath.value);
    repoPath.value = detection.value.repo;
    detected.value = true;
    reloadNeeded = typesafeNeedsReload(typesafeRepo.value, repoPath.value);
  } catch (cause) {
    detected.value = false;
    error.value = cause instanceof Error ? cause.message : "Repository detection failed";
  } finally {
    detecting.value = false;
  }
  if (reloadNeeded) await loadTypesafe(); // AFTER the flag: a blur here hits the re-entrancy guard
}

async function initialize(withAi: boolean): Promise<void> {
  if (busy.value || !detected.value) return;
  busy.value = true;
  message.value = "";
  error.value = "";
  try {
    await api.init({
      repoPath: repoPath.value,
      goal: "Initialize VibeFlow harness",
      engines: enabledEngines.value,
      useAi: withAi,
    });
    message.value = withAi ? "Harness initialized with AI." : "Harness initialized without AI.";
    await detect();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Harness initialization failed";
  } finally {
    busy.value = false;
  }
}

async function saveEnabledEngines(): Promise<void> {
  await saveSettings();
}

async function saveSettings(): Promise<void> {
  saving.value = true;
  try {
    const value = await api.settings.set({
      enabledEngines: [...enabledEngines.value],
      memory: settingsForm.memory,
      tools: { ...settingsForm.tools },
    });
    applySettings(value);
    message.value = "Configuration saved.";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Configuration save failed";
  } finally {
    saving.value = false;
  }
}

async function loadSkills(): Promise<void> {
  skills.value = await api.skills();
}

async function loadCapabilities(): Promise<void> {
  try {
    const response = await conversationHomeApi.capabilities({
      scope: CAPABILITY_SCOPE.PROJECT,
      view: "list",
    });
    capabilities.value = response.items;
  } catch {
    capabilities.value = [];
  }
}

const nextControl = (open: boolean) => {
  if (!open) return;
  void load();
  nextTick(() => closeButton.value?.focus());
};

watch(() => props.open, nextControl);
onMounted(() => nextControl(props.open));
</script>

<style scoped>
/* WCAG 2.1 §2.4.7: every control in the System One section keeps a visible focus
   ring. The status colours are never the only signal — each state also carries
   text and an ARIA role. */
.home-control-section :focus-visible {
  outline: 2px solid #f5f5f5;
  outline-offset: 2px;
}
.home-control-list {
  display: grid;
  gap: 0.25rem;
  margin: 0.5rem 0;
  font-size: 0.75rem;
  color: #a3a3a3;
}
.home-control-list div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.home-control-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0.35rem 0;
  font-size: 0.8125rem;
  color: #d4d4d4;
}
.home-control-field input {
  width: 6rem;
  background: transparent;
  border: 1px solid #262626;
  border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
  color: #e5e5e5;
}
.home-control-warning {
  color: #fbbf24;
  font-size: 0.8125rem;
}
dd[data-state="open"],
dd[data-state="half-open"] {
  color: #fbbf24;
}
</style>

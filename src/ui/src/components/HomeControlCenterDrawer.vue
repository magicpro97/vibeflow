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
import type { RepoDetection, SafeSkill, VibeSettings } from "../types.js";

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
const settingsForm = reactive({ memory: false, tools: { codegraph: true, lsp: true } });

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
    await Promise.all([loadSkills(), loadCapabilities()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load control center";
  }
}

async function detect(): Promise<void> {
  if (detecting.value) return;
  detecting.value = true;
  try {
    detection.value = await api.detect(repoPath.value);
    repoPath.value = detection.value.repo;
    detected.value = true;
  } catch (cause) {
    detected.value = false;
    error.value = cause instanceof Error ? cause.message : "Repository detection failed";
  } finally {
    detecting.value = false;
  }
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

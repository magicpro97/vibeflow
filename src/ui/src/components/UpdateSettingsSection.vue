<template>
  <section class="home-control-section" aria-labelledby="update-settings-title">
    <div class="home-control-section__heading">
      <span><small>Release channel</small><strong id="update-settings-title">Updates</strong></span>
      <button
        type="button"
        :disabled="saving || !ready"
        @click="save"
      >{{ saving ? "Saving…" : "Save update settings" }}</button>
    </div>
    <label>Mode
      <select v-model="mode" :disabled="!ready">
        <option value="notify">notify — show the nudge only</option>
        <option value="auto">auto — apply updates automatically</option>
      </select>
    </label>
    <label>Package manager
      <select v-model="manager" :disabled="!ready">
        <option value="npm">npm</option>
        <option value="bun">bun</option>
        <option value="pnpm">pnpm</option>
      </select>
    </label>
    <p v-if="saved" role="status">Update settings saved.</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { req } from "../api.js";

const mode = ref<"notify" | "auto">("notify");
const manager = ref<"npm" | "bun" | "pnpm">("npm");
const saving = ref(false);
const saved = ref(false);
const error = ref("");
// The form is inert until the stored values arrive: saving before the seed GET
// resolves would persist the hard-coded defaults over the real settings.
const ready = ref(false);

// Seed from the server view so the form opens on the stored values. A failed
// read is surfaced (never silent: saving over invisible defaults would persist
// values the user did not choose).
req<{ settings: { update?: { mode?: "notify" | "auto"; manager?: "npm" | "bun" | "pnpm" } } }>(
  "GET",
  "/api/settings",
)
  .then((view) => {
    if (view.settings.update?.mode) mode.value = view.settings.update.mode;
    if (view.settings.update?.manager) manager.value = view.settings.update.manager;
    ready.value = true;
  })
  .catch(() => {
    error.value = "Could not load the current update settings — reload before saving.";
  });

async function save(): Promise<void> {
  saving.value = true;
  saved.value = false;
  error.value = "";
  try {
    // POST /api/settings (NOT /apply — that route applies a POLICY preview and
    // requires a previewId; a plain settings write goes to /api/settings, the
    // same route api.settings.set uses from HomeControlCenterDrawer). The
    // server merges the block via coerceUpdateSettings(next.update ?? current).
    await req("POST", "/api/settings", { update: { mode: mode.value, manager: manager.value } });
    saved.value = true;
  } catch {
    error.value = "Save failed — check the vf ui terminal for details.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <aside v-show="rightSidebarOpen" class="home-right-sidebar" aria-label="Workspace panels">
    <header class="home-right-sidebar__header">
      <strong>Workspace</strong>
      <button
        class="home-right-sidebar__collapse"
        type="button"
        aria-label="Close panels"
        title="Close panels"
        @click="toggleRightSidebar()"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
      </button>
    </header>
    <div class="home-right-sidebar__tabs" role="tablist" aria-label="Workspace panels">
      <button
        v-for="tab in RIGHT_SIDEBAR_TABS"
        :id="`home-rs-tab-${tab}`"
        :key="tab"
        class="home-right-sidebar__tab"
        type="button"
        role="tab"
        :aria-selected="rightSidebarTab === tab"
        @click="selectTab(tab)"
      >
        {{ TAB_LABELS[tab] }}
      </button>
    </div>
    <div
      class="home-right-sidebar__panels"
      role="tabpanel"
      :aria-labelledby="`home-rs-tab-${rightSidebarTab}`"
    >
      <div v-show="rightSidebarTab === 'files'">
        <slot name="files"><HomeFilesPanel /></slot>
      </div>
      <div v-show="rightSidebarTab === 'changes'">
        <slot name="changes"><HomeChangesPanel /></slot>
      </div>
      <div v-show="rightSidebarTab === 'resources'">
        <slot name="resources"><p class="home-rs-placeholder">Resources will land here.</p></slot>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import {
  RIGHT_SIDEBAR_TABS,
  type RightSidebarTab,
  rightSidebarOpen,
  rightSidebarTab,
  toggleRightSidebar,
} from "../right-sidebar-prefs.js";
import HomeChangesPanel from "./HomeChangesPanel.vue";
import HomeFilesPanel from "./HomeFilesPanel.vue";

const TAB_LABELS: Readonly<Record<RightSidebarTab, string>> = Object.freeze({
  files: "Files",
  changes: "Changes",
  resources: "Resources",
});

function selectTab(tab: RightSidebarTab): void {
  toggleRightSidebar(tab);
}
</script>

<template>
  <aside
    v-show="rightSidebarOpen"
    class="home-right-sidebar"
    aria-label="Workspace panels"
    :style="{ '--home-sidebar-width': `${rightSidebarWidth}px` }"
  >
    <div
      class="home-right-sidebar__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      tabindex="0"
      @pointerdown="startResize"
      @pointermove="moveResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @keydown.left.prevent="nudge(16)"
      @keydown.right.prevent="nudge(-16)"
    ></div>
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
        <slot name="resources"><HomeResourcesPanel /></slot>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import {
  RIGHT_SIDEBAR_TABS,
  RIGHT_SIDEBAR_WIDTH,
  type RightSidebarTab,
  rightSidebarOpen,
  rightSidebarTab,
  rightSidebarWidth,
  setRightSidebarWidth,
  toggleRightSidebar,
} from "../right-sidebar-prefs.js";
import { resizeFromDrag } from "../right-sidebar-resize.js";
import HomeChangesPanel from "./HomeChangesPanel.vue";
import HomeFilesPanel from "./HomeFilesPanel.vue";
import HomeResourcesPanel from "./HomeResourcesPanel.vue";

const TAB_LABELS: Readonly<Record<RightSidebarTab, string>> = Object.freeze({
  files: "Files",
  changes: "Changes",
  resources: "Resources",
});

function selectTab(tab: RightSidebarTab): void {
  toggleRightSidebar(tab);
}

// Start width is captured at pointerdown and never read live mid-drag — a live
// read would double-count the already-applied delta on every pointermove.
let dragStartX: number | null = null;
let dragStartWidth = 0;

function startResize(event: PointerEvent): void {
  if (event.button !== 0) return; // primary button only
  dragStartX = event.clientX;
  dragStartWidth = rightSidebarWidth.value;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function moveResize(event: PointerEvent): void {
  if (dragStartX === null) return;
  // All width writes go through setRightSidebarWidth (it clamps + rounds); never
  // assign rightSidebarWidth.value directly.
  setRightSidebarWidth(
    resizeFromDrag({
      clientX: event.clientX,
      startX: dragStartX,
      startWidth: dragStartWidth,
      deltaSign: -1, // right sidebar: dragging left grows the panel
      minWidth: RIGHT_SIDEBAR_WIDTH.MIN,
      maxWidth: RIGHT_SIDEBAR_WIDTH.MAX,
    }),
  );
}

function endResize(event: PointerEvent): void {
  if (dragStartX === null) return;
  dragStartX = null;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function nudge(delta: number): void {
  setRightSidebarWidth(rightSidebarWidth.value + delta);
}
</script>

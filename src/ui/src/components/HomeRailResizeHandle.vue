<template>
  <div
    class="home-rail__resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize conversation list"
    :aria-valuenow="railWidth"
    :aria-valuemin="RAIL_WIDTH.MIN"
    :aria-valuemax="RAIL_WIDTH.MAX"
    tabindex="0"
    @pointerdown="startResize"
    @pointermove="moveResize"
    @pointerup="endResize"
    @pointercancel="endResize"
    @keydown.right.prevent="nudge(16)"
    @keydown.left.prevent="nudge(-16)"
  ></div>
</template>

<script setup lang="ts">
import { RAIL_WIDTH, railWidth, setRailWidth } from "../rail-prefs.js";
import { resizeFromDrag } from "../right-sidebar-resize.js";

// Start width is captured at pointerdown and never read live mid-drag — a live
// read would double-count the already-applied delta on every pointermove.
let dragStartX: number | null = null;
let dragStartWidth = 0;

function startResize(event: PointerEvent): void {
  if (event.button !== 0) return; // primary button only
  dragStartX = event.clientX;
  dragStartWidth = railWidth.value;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function moveResize(event: PointerEvent): void {
  if (dragStartX === null) return;
  // All width writes go through setRailWidth (it clamps + rounds); never assign
  // railWidth.value directly.
  setRailWidth(
    resizeFromDrag({
      clientX: event.clientX,
      startX: dragStartX,
      startWidth: dragStartWidth,
      deltaSign: 1, // left rail: dragging right grows the panel
      minWidth: RAIL_WIDTH.MIN,
      maxWidth: RAIL_WIDTH.MAX,
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
  setRailWidth(railWidth.value + delta);
}
</script>

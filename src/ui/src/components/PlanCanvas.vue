<template>
  <div class="flex-1 min-w-0 overflow-y-auto p-6 space-y-4" role="region" aria-label="Plan canvas">
    <div v-for="block in blocks" :key="block.id" class="group relative" @mouseup="onMouseUp(block, $event)">
      <div v-if="block.type === 'heading'" :class="headingClass(block.level)" :id="block.id">
        {{ block.text }}
      </div>
      <p v-else-if="block.type === 'paragraph'" :id="block.id" class="text-sm text-neutral-300 leading-relaxed">
        {{ block.text }}
      </p>
      <ul v-else-if="block.type === 'list-run'" class="list-disc pl-5 text-sm text-neutral-300 space-y-1">
        <li :id="block.id">{{ block.text }}</li>
      </ul>
      <pre v-else-if="block.type === 'fenced-code'" :id="block.id"
        class="bg-neutral-900/60 border border-neutral-800 rounded p-3 text-[11px] font-mono text-neutral-300 overflow-x-auto whitespace-pre-wrap"
      ><code>{{ block.text }}</code></pre>
      <div v-else-if="block.type === 'fenced-mermaid'" :id="block.id"
        class="bg-neutral-900/60 border border-neutral-800 rounded p-3"
      >
        <div class="text-[10px] text-neutral-600 font-mono mb-1">
          {{ block.fallback.reason === 'too-large' ? 'Diagram too large to render inline' : 'Mermaid source' }}
        </div>
        <pre class="text-[11px] font-mono text-neutral-400 overflow-x-auto whitespace-pre-wrap"><code>{{ block.fallback.source }}</code></pre>
      </div>
      <button
        type="button"
        class="btn-ghost absolute top-0 right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity text-[10px]"
        :aria-label="`Comment on block ${block.id}`"
        @click="anchor(block)"
        @mouseup.stop
      >Comment</button>
    </div>
    <p v-if="!blocks.length" class="text-sm text-neutral-600 italic py-8 text-center">Select a revision to view the plan</p>
  </div>
</template>

<script setup lang="ts">
import { buildBlockAnchor } from "../lib/plan-anchor.js";
import type { BlockAnchor } from "../lib/plan-anchor.js";
import type { RenderDescriptor } from "../lib/plan-render.js";

const props = defineProps<{ blocks: RenderDescriptor[] }>();
const emit = defineEmits<{ anchor: [a: BlockAnchor] }>();

function headingClass(level: number) {
  return (
    {
      1: "text-lg font-semibold text-neutral-100",
      2: "text-base font-semibold text-neutral-200",
      3: "text-sm font-medium text-neutral-200",
    }[Math.min(level, 3)] ?? "text-sm font-medium text-neutral-200"
  );
}

function blockText(block: RenderDescriptor): string {
  if (block.type === "fenced-mermaid") return block.fallback.source;
  return block.text;
}

function anchor(block: RenderDescriptor) {
  emit("anchor", buildBlockAnchor(block.id, blockText(block)));
}

function onMouseUp(block: RenderDescriptor, e: MouseEvent) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;
  const range = sel.getRangeAt(0);
  const anchor = buildBlockAnchor(block.id, blockText(block), {
    start: range.startOffset,
    end: range.endOffset,
  });
  sel.removeAllRanges();
  emit("anchor", anchor);
}
</script>

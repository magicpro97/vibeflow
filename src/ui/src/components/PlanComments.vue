<template>
  <aside class="w-72 flex-shrink-0 border-l border-neutral-800/40 bg-neutral-950/50 flex flex-col overflow-y-auto" role="complementary" aria-label="Plan comments">
    <div class="px-3 py-2 border-b border-neutral-800/40 flex items-center justify-between">
      <h2 class="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Comments</h2>
      <span v-if="comments.length" class="text-[10px] text-neutral-600">{{ comments.length }}</span>
    </div>

    <div v-if="anchor && !composerParentId" class="px-3 py-2 border-b border-neutral-800/40">
      <p class="text-[10px] text-neutral-500 mb-1">New comment on:</p>
      <p class="text-[10px] font-mono text-neutral-400 truncate">"{{ anchor.quote.slice(0, 60) }}"</p>
      <textarea
        v-model="composerBody"
        rows="3"
        placeholder="Write a comment…"
        class="input-base w-full resize-y text-[11px] font-mono mt-2"
        :maxlength="10000"
      />
      <div class="flex gap-1 mt-1">
        <button
          type="button"
          class="btn-secondary text-[10px]"
          :disabled="!composerBody.trim() || posting"
          @click="postRootComment"
        >{{ posting ? 'Posting…' : 'Post comment' }}</button>
        <button type="button" class="btn-ghost text-[10px]" @click="dismissComposer">Cancel</button>
      </div>
    </div>

    <div v-if="!threads.length && !anchor" class="flex-1 flex items-center justify-center p-4">
      <p class="text-[11px] text-neutral-600 italic text-center">No comments yet. Select text or click Comment on a block.</p>
    </div>

    <div v-else class="flex-1 p-2 space-y-3 overflow-y-auto">
      <div v-for="thread in threads" :key="thread.root.id" class="rounded border border-neutral-800/30 bg-neutral-900/30 p-2">
        <div v-for="comment in thread.comments" :key="comment.id" class="mb-2 last:mb-0" :style="{ paddingLeft: comment.depth * 12 + 'px' }">
          <div class="flex items-baseline gap-1">
            <span class="text-[10px] font-medium text-neutral-300">{{ comment.createdBy.name }}</span>
            <span class="text-[9px] text-neutral-700">{{ fmtTime(comment.createdAt) }}</span>
            <span v-if="comment.status === 'draft'" class="text-[9px] text-amber-600 ml-auto">draft</span>
          </div>

          <div v-if="comment.depth === 0 && comment.anchor" class="text-[9px] text-neutral-600 font-mono truncate mt-0.5">
            "{{ comment.anchor.quote.slice(0, 40) }}"
          </div>

          <div v-if="editingId === comment.id" class="mt-1">
            <textarea
              v-model="editBody"
              rows="2"
              class="input-base w-full resize-y text-[11px] font-mono"
              :maxlength="10000"
            />
            <div class="flex gap-1 mt-1">
              <button type="button" class="btn-secondary text-[10px]" :disabled="!editBody.trim() || posting" @click="saveEdit(comment.id)">Save</button>
              <button type="button" class="btn-ghost text-[10px]" @click="cancelEdit">Cancel</button>
            </div>
          </div>
          <p v-else class="text-[11px] text-neutral-300 mt-0.5 whitespace-pre-wrap break-words">{{ comment.body }}</p>

          <div v-if="comment.status === 'draft' && editingId !== comment.id" class="flex gap-1 mt-1">
            <button type="button" class="btn-ghost text-[9px]" @click="startEdit(comment)">Edit</button>
            <button type="button" class="btn-ghost text-[9px]" @click="handleDelete(comment.id)">Delete</button>
            <button type="button" class="btn-secondary text-[9px]" :disabled="posting" @click="handleSubmit(comment.id)">Submit</button>
          </div>
        </div>

        <div v-if="composerParentId === thread.root.id" class="mt-2 pl-3 border-l border-neutral-800/30">
          <textarea
            v-model="composerBody"
            rows="2"
            placeholder="Reply…"
            class="input-base w-full resize-y text-[11px] font-mono"
            :maxlength="10000"
          />
          <div class="flex gap-1 mt-1">
            <button type="button" class="btn-secondary text-[10px]" :disabled="!composerBody.trim() || posting" @click="postReply">Reply</button>
            <button type="button" class="btn-ghost text-[10px]" @click="dismissComposer">Cancel</button>
          </div>
        </div>
        <button
          v-else-if="thread.root.status === 'open' || thread.comments.some(c => c.status === 'draft')"
          type="button"
          class="btn-ghost text-[9px] mt-1"
          @click="startReply(thread.root.id)"
        >Reply</button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PlanComment, PlanCommentAnchor } from "../types.js";

const props = defineProps<{
  comments: PlanComment[];
  anchor: { blockId: string; quote: string; range?: { start: number; end: number } } | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  create: [body: string, anchor?: PlanCommentAnchor, parentId?: string];
  update: [id: string, body: string];
  delete: [id: string];
  submit: [id: string];
  dismissAnchor: [];
}>();

interface Thread {
  root: PlanComment;
  comments: PlanComment[];
}

const threads = computed<Thread[]>(() => {
  const roots = props.comments.filter((c) => !c.parentId);
  return roots.map((root) => {
    const all: PlanComment[] = [root];
    const queue = [root.id];
    while (queue.length) {
      const pid = queue.shift();
      if (!pid) break;
      for (const c of props.comments) {
        if (c.parentId === pid && !all.some((x) => x.id === c.id)) {
          all.push(c);
          queue.push(c.id);
        }
      }
    }
    all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return { root, comments: all };
  });
});

const composerBody = ref("");
const composerParentId = ref<string | null>(null);
const editingId = ref<string | null>(null);
const editBody = ref("");
const posting = ref(false);

function startReply(rootId: string) {
  composerParentId.value = rootId;
  composerBody.value = "";
}

function dismissComposer() {
  composerBody.value = "";
  composerParentId.value = null;
  emit("dismissAnchor");
}

function startEdit(comment: PlanComment) {
  editingId.value = comment.id;
  editBody.value = comment.body;
}

function cancelEdit() {
  editingId.value = null;
  editBody.value = "";
}

async function postRootComment() {
  if (!props.anchor || !composerBody.value.trim()) return;
  posting.value = true;
  try {
    const a: PlanCommentAnchor = {
      blockId: props.anchor.blockId,
      quote: props.anchor.quote,
      range: props.anchor.range
        ? { startOffset: props.anchor.range.start, endOffset: props.anchor.range.end }
        : undefined,
    };
    emit("create", composerBody.value, a);
    composerBody.value = "";
    emit("dismissAnchor");
  } finally {
    posting.value = false;
  }
}

async function postReply() {
  if (!composerParentId.value || !composerBody.value.trim()) return;
  posting.value = true;
  try {
    emit("create", composerBody.value, undefined, composerParentId.value);
    composerBody.value = "";
    composerParentId.value = null;
  } finally {
    posting.value = false;
  }
}

async function saveEdit(id: string) {
  if (!editBody.value.trim()) return;
  posting.value = true;
  try {
    emit("update", id, editBody.value);
    editingId.value = null;
    editBody.value = "";
  } finally {
    posting.value = false;
  }
}

function handleDelete(id: string) {
  emit("delete", id);
}

function handleSubmit(id: string) {
  posting.value = true;
  try {
    emit("submit", id);
  } finally {
    posting.value = false;
  }
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

watch(
  () => props.anchor,
  () => {
    if (props.anchor) composerParentId.value = null;
  },
);
</script>

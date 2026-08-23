<template>
  <section class="rounded-2xl border border-neutral-800 bg-neutral-900/60">
    <header class="border-b border-neutral-800 px-4 py-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-[10px] uppercase tracking-[0.24em] text-neutral-500">Conversation</p>
          <h2 class="mt-1 text-lg font-medium text-neutral-100">{{ snapshot?.topic ?? "No conversation selected" }}</h2>
          <p v-if="snapshot" class="mt-1 text-xs text-neutral-500">
            {{ snapshot.conversation_id }} · {{ snapshot.policy }} · {{ snapshot.lifecycle }} · {{ snapshot.health }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-secondary text-xs" :disabled="pending || !controls.canPause" aria-label="Pause conversation" @click="$emit('pause')">Pause</button>
          <button type="button" class="btn-secondary text-xs" :disabled="pending || !controls.canResume" aria-label="Resume conversation" @click="$emit('resume')">Resume</button>
          <button type="button" class="btn-secondary text-xs" :disabled="pending || !controls.canStop" aria-label="Stop conversation" @click="$emit('stop')">Stop</button>
          <button type="button" class="btn-secondary text-xs" aria-label="Open trace drawer" @click="$emit('show-trace', messages.at(-1)?.seq ?? 0)">Trace</button>
        </div>
      </div>

      <div v-if="snapshot?.participants.length" class="mt-4 flex flex-wrap gap-2">
        <span
          v-for="participant in snapshot.participants"
          :key="participant.participant_id"
          class="rounded-full border border-neutral-800 bg-neutral-950/80 px-3 py-1 text-[11px] text-neutral-300"
        >
          {{ participant.role_ref }} · {{ participant.engine }}<template v-if="participant.model">:{{ participant.model }}</template>
        </span>
      </div>
    </header>

    <div v-if="notice" class="border-b border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-xs text-emerald-300">
      {{ notice }}
    </div>
    <div v-if="error" class="border-b border-red-900/60 bg-red-950/20 px-4 py-3 text-xs text-red-300">
      {{ error }}
    </div>

    <div v-if="approvals.length" class="border-b border-neutral-800 px-4 py-4">
      <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Approvals</p>
      <div class="mt-3 grid gap-3">
        <div v-for="approval in approvals" :key="approval.approval_id" class="rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">
          <p class="text-sm text-neutral-100">{{ approval.description }}</p>
          <p class="mt-1 text-[11px] text-neutral-500">approval {{ approval.approval_id }} · operation {{ approval.operation_id }}</p>
          <p v-if="approval.resolved && approval.decision" class="mt-2 text-xs text-neutral-400">
            {{ approval.decision.outcome }} by {{ approval.decision.actor }}
          </p>
          <template v-else>
            <textarea
              v-model="approvalReasons[approval.approval_id]"
              rows="2"
              class="input-base mt-3 w-full resize-y text-xs"
              placeholder="Optional approval reason"
            />
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                class="btn-primary text-xs"
                :disabled="pending || !controls.canResolveApproval(approval.approval_id, approval.operation_id)"
                aria-label="Approve conversation operation"
                @click="$emit('resolve-approval', approval.approval_id, approval.operation_id, approval.actor, 'approve', approvalReasons[approval.approval_id] || null)"
              >
                Approve
              </button>
              <button
                type="button"
                class="btn-secondary text-xs"
                :disabled="pending || !controls.canResolveApproval(approval.approval_id, approval.operation_id)"
                aria-label="Reject conversation operation"
                @click="$emit('resolve-approval', approval.approval_id, approval.operation_id, approval.actor, 'reject', approvalReasons[approval.approval_id] || null)"
              >
                Reject
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div v-if="operations.length" class="border-b border-neutral-800 px-4 py-4">
      <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Operations</p>
      <div class="mt-3 grid gap-3">
        <div v-for="operation in operations" :key="operation.operation_id" class="rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">
          <p class="text-sm text-neutral-100">{{ operation.operation_id }}</p>
          <p class="mt-1 text-[11px] text-neutral-500">
            {{ operation.state }} · attempt {{ operation.attempt_id }}
            <template v-if="operation.cancelled"> · cancelled by {{ operation.cancelled_by }}</template>
          </p>
          <template v-if="!operation.cancelled && operation.state !== 'completed'">
            <textarea
              v-model="cancelReasons[operation.operation_id]"
              rows="2"
              class="input-base mt-3 w-full resize-y text-xs"
              placeholder="Optional cancellation reason"
            />
            <button
              type="button"
              class="btn-secondary mt-2 text-xs"
              :disabled="pending || !controls.canCancel"
              aria-label="Cancel conversation operation"
              @click="$emit('cancel-operation', operation.operation_id, cancelReasons[operation.operation_id] || null)"
            >
              Cancel operation
            </button>
          </template>
        </div>
      </div>
    </div>

    <div class="max-h-[34rem] overflow-auto px-4 py-4">
      <div v-if="messages.length" class="space-y-3">
        <article
          v-for="message in messages"
          :key="message.key"
          class="rounded-xl border border-neutral-800 bg-neutral-950/70 p-3"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm text-neutral-100">
                {{ message.title }}
                <span v-if="message.role_ref" class="text-neutral-500">· {{ message.role_ref }}</span>
                <span v-if="message.engine" class="text-neutral-600">· {{ message.engine }}</span>
                <span v-if="message.model" class="text-neutral-600">:{{ message.model }}</span>
              </p>
              <p class="mt-1 text-[11px] text-neutral-500">
                seq {{ message.seq }}<template v-if="message.round_id"> · {{ message.round_id }}</template>
                <template v-if="message.session_status"> · session {{ message.session_status }}</template>
              </p>
            </div>
            <button type="button" class="btn-ghost shrink-0" aria-label="Open message trace" @click="$emit('show-trace', message.seq)">Trace</button>
          </div>
          <p class="mt-3 whitespace-pre-wrap text-sm text-neutral-200">{{ message.body }}</p>
          <p v-if="message.claim" class="mt-3 text-xs text-neutral-400">Claim: {{ message.claim }}</p>
          <div v-if="message.evidence.length" class="mt-3 flex flex-wrap gap-2">
            <span v-for="item in message.evidence" :key="item" class="rounded-full border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400">
              {{ item }}
            </span>
          </div>
        </article>
      </div>
      <p v-else class="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-600">
        No public trace events yet. Start or resume a conversation to stream the workspace.
      </p>
    </div>

    <form
      v-if="snapshot && (controls.canInject || controls.canRevise)"
      class="border-t border-neutral-800 px-4 py-4"
      @submit.prevent="submitMessage"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Message</p>
          <p class="mt-1 text-xs text-neutral-400">{{ controls.canRevise ? "Revise / reject the completed conversation" : "Inject a live user message" }}</p>
        </div>
        <p class="text-[11px] text-neutral-500">
          Targets: {{ selectedTargets.length ? selectedTargets.join(", ") : "all participants" }}
        </p>
      </div>

      <div class="mt-3 flex flex-wrap gap-2" v-if="snapshot.participants.length">
        <label
          v-for="participant in snapshot.participants"
          :key="participant.participant_id"
          class="rounded-full border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400"
        >
          <input
            :checked="selectedTargets.includes(participant.participant_id)"
            class="mr-1"
            type="checkbox"
            @change="toggleTarget(participant.participant_id)"
          />
          {{ participant.role_ref }}
        </label>
      </div>

      <textarea
        v-model="draft"
        rows="4"
        class="input-base mt-3 w-full resize-y"
        :placeholder="controls.canRevise ? 'Explain how to revise or reject the previous result' : 'Ask a follow-up question or steer the active conversation'"
      />
      <div class="mt-3 flex items-center justify-end gap-2">
        <button type="button" class="btn-secondary text-xs" :disabled="pending" @click="clearComposer">Clear</button>
        <button type="submit" class="btn-primary text-xs" :disabled="pending || !draft.trim()">
          {{ controls.canRevise ? "Create child revision" : "Send message" }}
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import type {
  ConversationApprovalView,
  ConversationControls,
  ConversationMessageView,
  ConversationOperationView,
} from "../conversation-store.js";
import type { ApprovalOutcome, ConversationSnapshot } from "../conversation-types.js";

defineProps<{
  snapshot: ConversationSnapshot | null;
  messages: ConversationMessageView[];
  approvals: ConversationApprovalView[];
  operations: ConversationOperationView[];
  controls: ConversationControls;
  pending: boolean;
  notice: string | null;
  error: string | null;
}>();

const emit = defineEmits<{
  pause: [];
  resume: [];
  stop: [];
  "show-trace": [seq: number];
  "submit-message": [content: string, targets: string[] | "all", onSuccess: () => void];
  "resolve-approval": [
    approvalId: string,
    operationId: string,
    actor: string,
    outcome: ApprovalOutcome,
    reason: string | null,
  ];
  "cancel-operation": [operationId: string, reason: string | null];
}>();

const draft = ref("");
const selectedTargets = ref<string[]>([]);
const approvalReasons = reactive<Record<string, string>>({});
const cancelReasons = reactive<Record<string, string>>({});

function clearComposer() {
  draft.value = "";
  selectedTargets.value = [];
}

function toggleTarget(participantId: string) {
  selectedTargets.value = selectedTargets.value.includes(participantId)
    ? selectedTargets.value.filter((value) => value !== participantId)
    : [...selectedTargets.value, participantId];
}

function submitMessage() {
  const content = draft.value.trim();
  if (!content) return;
  const targets = selectedTargets.value.length ? [...selectedTargets.value] : "all";
  emit("submit-message", content, targets, clearComposer);
}
</script>

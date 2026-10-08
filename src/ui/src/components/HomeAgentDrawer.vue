<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-agent-drawer" aria-label="Agent activity">
      <header>
        <span><small>Public activity</small><strong>{{ label }}</strong></span>
        <button ref="closeButton" type="button" aria-label="Close agent activity" @click="$emit('close')">×</button>
      </header>
      <p v-if="!entries.length" class="home-drawer-copy">No public activity for this agent yet.</p>
      <ol v-else class="home-agent-list">
        <li v-for="(entry, index) in entries" :key="entry.item.id">
          <header>
            <span class="home-agent-list__icon" aria-hidden="true">{{ icon(entry.item) }}</span>
            <time :datetime="entry.at ?? undefined">{{ clock(entry.at) }}</time>
            <span v-if="pill(entry.item)" class="home-agent-list__pill">{{ pill(entry.item) }}</span>
            <span v-if="index === entries.length - 1 && marker" class="home-agent-list__state">{{ marker }}</span>
          </header>
          <p>{{ excerpt(entry.item.body) }}</p>
        </li>
      </ol>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { homeParticipantDisplayLabel } from "../conversation-home-participant-label.js";
import { projectHomeTimeline } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { buildAgentActivity, type AgentActivityEntry } from "../lib/agent-activity.js";
import { AGENT_PRESENCE_STATUS, buildAgentPresence } from "../lib/agent-presence.js";
import { toolGroupSummary } from "../lib/tool-groups.js";

const props = defineProps<{ open: boolean; participantId: string | null }>();
defineEmits<{ close: [] }>();
const store = useConversationHomeStore();
const closeButton = ref<HTMLButtonElement | null>(null);
type ActivityItem = AgentActivityEntry["item"];

const rendered = computed(() =>
  projectHomeTimeline(store.timeline?.items ?? [], store.activeRevision?.participants ?? []),
);
const entries = computed(() =>
  props.participantId ? buildAgentActivity(rendered.value, props.participantId) : [],
);
const presence = computed(() =>
  buildAgentPresence(rendered.value, store.activeRevision?.participants ?? []).find(
    (row) => row.participantId === props.participantId,
  ),
);
const label = computed(() => {
  const participant = store.activeRevision?.participants.find(
    (row) => row.participant_id === props.participantId,
  );
  return participant
    ? homeParticipantDisplayLabel({
        participantId: participant.participant_id,
        roleRef: participant.role_ref,
        engine: participant.engine,
      })
    : "Agent";
});
const marker = computed(() => {
  if (presence.value?.status === AGENT_PRESENCE_STATUS.COMPLETE) return "Complete";
  if (presence.value?.status === AGENT_PRESENCE_STATUS.WORKING) return "Working";
  if (presence.value?.status === AGENT_PRESENCE_STATUS.FAILED) return "Failed";
  return "";
});
const icon = (item: ActivityItem): string =>
  item.kind === "tool" || item.kind === "tool-group" ? "⚙" : "✎";
const pill = (item: ActivityItem): string => {
  if (item.kind === "tool") return item.tool?.status ?? "";
  if (item.kind === "tool-group") return toolGroupSummary(item.tools ?? []);
  return "";
};
const excerpt = (body: string): string => (body.length <= 200 ? body : `${body.slice(0, 199)}…`);
const clock = (value: string | null): string =>
  value
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
        new Date(value),
      )
    : "";

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await nextTick();
      closeButton.value?.focus();
    }
  },
);
</script>

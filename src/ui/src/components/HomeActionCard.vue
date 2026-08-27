<template>
  <article
    class="home-action-card"
    :data-state="cardState"
    :aria-label="`Proposed action: ${view.proposal.preview.title} (${view.proposal.proposal_id})`"
  >
    <header>
      <span class="home-action-card__icon" aria-hidden="true">
        <svg viewBox="0 0 20 20"><path d="M10 2v3m0 10v3M2 10h3m10 0h3M4.3 4.3l2.1 2.1m7.2 7.2 2.1 2.1m0-11.4-2.1 2.1m-7.2 7.2-2.1 2.1" /></svg>
      </span>
      <span class="home-action-card__heading">
        <small>{{ domainLabel }} · {{ view.proposal.risk }} risk</small>
        <strong>{{ view.proposal.preview.title }}</strong>
      </span>
      <span class="home-action-state">{{ stateLabel }}</span>
    </header>
    <p>{{ view.proposal.preview.summary }}</p>

    <details v-if="view.proposal.preview.permission_delta.length || view.proposal.preview.target_dispositions.length">
      <summary>Review impact</summary>
      <ul>
        <li v-for="permission in view.proposal.preview.permission_delta" :key="permission.permission_id">
          <span>{{ permission.change }}</span>
          {{ permission.public_scope }}
          <small>{{ permission.enforcement }}</small>
        </li>
        <li v-for="target in view.proposal.preview.target_dispositions" :key="target.target_id">
          <span>{{ target.execution }}</span>
          {{ target.target_id }}
          <small v-if="target.reason_code">{{ target.reason_code }}</small>
        </li>
      </ul>
    </details>

    <div v-if="latestProgress" class="home-action-progress" role="status">
      <span><i :style="{ width: `${progressPercent}%` }" /></span>
      <small>{{ progressLabel }}</small>
    </div>

    <div v-if="challenge" class="home-challenge">
      <label :for="`challenge-${view.proposal.proposal_id}`">
        Type <strong>{{ challenge.phrase }}</strong> to confirm this authority change.
      </label>
      <input
        :id="`challenge-${view.proposal.proposal_id}`"
        ref="challengeInput"
        v-model="challenge.response"
        type="text"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div v-if="view.operation.error" class="home-action-error" role="alert">
      {{ view.operation.error.message }}
      <span v-if="view.operation.error.correlation_id">Ref {{ view.operation.error.correlation_id }}</span>
    </div>

    <footer v-if="!terminal">
      <template v-if="!view.approval">
        <button
          v-if="needsChallenge && !challenge"
          type="button"
          class="home-button home-button--primary"
          :disabled="busy || !store.online"
          @click="requestChallenge"
        >Review confirmation</button>
        <button
          v-else
          type="button"
          class="home-button home-button--primary"
          :disabled="busy || !store.online || Boolean(challenge && challenge.response !== challenge.phrase)"
          @click="store.mutateAction(view, 'approve')"
        >Approve</button>
        <button type="button" class="home-button" :disabled="busy || !store.online" @click="store.mutateAction(view, 'deny')">Decline</button>
      </template>
      <button
        v-else-if="view.approval.decision === ACTION_DECISION.APPROVED && view.operation.state === ACTION_OPERATION_STATE.APPROVED"
        type="button"
        class="home-button home-button--primary"
        :disabled="busy || !store.online"
        @click="store.mutateAction(view, 'commit')"
      >Run approved action</button>
      <button
        v-if="view.operation.state !== ACTION_OPERATION_STATE.APPROVED"
        type="button"
        class="home-button"
        :disabled="busy || !store.online"
        @click="store.mutateAction(view, 'cancel')"
      >Cancel</button>
    </footer>

    <footer v-else-if="recoveryPlans.length" class="home-recovery-actions">
      <span>Recovery:</span>
      <button
        v-for="plan in recoveryPlans"
        :key="plan.action"
        type="button"
        class="home-button"
        :disabled="busy || !store.online || !plan.candidate"
        :title="plan.blockedReason ?? ''"
        @click="plan.candidate && store.proposeCandidate(plan.candidate)"
      >{{ plan.label }}</button>
    </footer>
    <p v-if="blockedRecovery || terminalNote" class="home-action-error" role="note">
      {{ blockedRecovery || terminalNote }}
    </p>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { HOST_ACTION_KIND } from "../../../actions/host-action-contract.js";
import { ACTION_OPERATION_STATE } from "../../../actions/protocol-contract.js";
import {
  ACTION_DECISION,
  ACTION_DOMAIN,
  ACTION_SCOPE,
} from "../../../actions/public-action-contract.js";
import { planHomeRecovery } from "../conversation-home-recovery.js";
import { terminalHomeOperation } from "../conversation-home-runtime.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { HomeActionView } from "../conversation-home-types.js";

const props = defineProps<{ view: HomeActionView }>();
const store = useConversationHomeStore();
const challengeInput = ref<HTMLInputElement | null>(null);
const busy = computed(() => Boolean(store.actionBusy[props.view.proposal.proposal_id]));
const challenge = computed(() => store.challenges[props.view.proposal.proposal_id]);
const needsChallenge = computed(
  () =>
    props.view.proposal.scope === ACTION_SCOPE.USER ||
    props.view.proposal.action_type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
);
const expiryClock = ref(Date.now());
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const proposalExpired = computed(
  () =>
    props.view.operation.state === ACTION_OPERATION_STATE.PENDING_REVIEW &&
    Date.parse(props.view.proposal.expires_at) <= expiryClock.value,
);
const approvalExpired = computed(
  () =>
    props.view.approval?.decision === ACTION_DECISION.APPROVED &&
    props.view.operation.state === ACTION_OPERATION_STATE.APPROVED &&
    Date.parse(props.view.approval.expires_at) <= expiryClock.value,
);
const staleTerminal = computed(() => props.view.operation.state === ACTION_OPERATION_STATE.STALE);
const terminal = computed(
  () =>
    terminalHomeOperation(props.view.operation.state) ||
    props.view.operation.state === ACTION_OPERATION_STATE.DENIED ||
    staleTerminal.value ||
    approvalExpired.value ||
    proposalExpired.value,
);
const latestProgress = computed(() => props.view.operation.progress.at(-1) ?? null);
const progressPercent = computed(() => {
  if (terminal.value) return 100;
  const sequence = latestProgress.value?.sequence ?? 0;
  return Math.min(92, Math.max(8, (sequence + 1) * 16));
});
const progressLabel = computed(() =>
  latestProgress.value
    ? latestProgress.value.message_code.replaceAll(".", " ").replaceAll("-", " ")
    : "Waiting for approval",
);
const domainLabel = computed(() =>
  props.view.proposal.domain === ACTION_DOMAIN.CAPABILITY ? "CLI capability" : "Conversation",
);
const cardState = computed(() =>
  staleTerminal.value
    ? ACTION_OPERATION_STATE.STALE
    : approvalExpired.value || proposalExpired.value
      ? ACTION_OPERATION_STATE.EXPIRED
      : props.view.operation.state,
);
const terminalNote = computed(() => {
  if (approvalExpired.value)
    return "The approval expired before the action ran. Review it again to continue.";
  if (proposalExpired.value)
    return "This proposal expired before it was settled. Refresh the current review queue.";
  if (staleTerminal.value)
    return (
      props.view.operation.error?.message ||
      "This action result went stale. Refresh the current review queue."
    );
  if (props.view.operation.state === ACTION_OPERATION_STATE.CANCELED)
    return "This action was canceled before a durable receipt completed.";
  if (props.view.operation.state === ACTION_OPERATION_STATE.DENIED)
    return "This action was declined and will not run.";
  if (props.view.operation.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY)
    return "This action stopped at a guarded failure. Choose a recovery path to continue.";
  return "";
});
const stateLabel = computed(() => {
  if (approvalExpired.value) return "approval expired";
  if (proposalExpired.value) return "proposal expired";
  if (staleTerminal.value) return "stale result";
  if (props.view.operation.state === ACTION_OPERATION_STATE.DENIED) return "declined";
  return props.view.operation.state.replaceAll("_", " ");
});
const recoveryPlans = computed(() =>
  props.view.operation.recovery_actions.map((action) => planHomeRecovery(props.view, action)),
);
const blockedRecovery = computed(
  () => recoveryPlans.value.find((plan) => plan.blockedReason)?.blockedReason ?? "",
);

async function requestChallenge() {
  await store.requestChallenge(props.view);
  await nextTick();
  challengeInput.value?.focus();
}

function scheduleExactExpiry() {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  expiryClock.value = Date.now();
  const deadlines = [
    props.view.operation.state === ACTION_OPERATION_STATE.PENDING_REVIEW
      ? Date.parse(props.view.proposal.expires_at)
      : Number.NaN,
    props.view.operation.state === ACTION_OPERATION_STATE.APPROVED &&
    props.view.approval?.decision === ACTION_DECISION.APPROVED
      ? Date.parse(props.view.approval.expires_at)
      : Number.NaN,
  ].filter((deadline) => Number.isFinite(deadline) && deadline > expiryClock.value);
  const nextDeadline = deadlines.length ? Math.min(...deadlines) : null;
  if (nextDeadline === null) return;
  expiryTimer = setTimeout(
    () => {
      expiryClock.value = Date.now();
      scheduleExactExpiry();
    },
    Math.max(0, nextDeadline - Date.now() + 1),
  );
}

watch(
  [
    () => props.view.operation.state,
    () => props.view.proposal.expires_at,
    () => props.view.approval?.decision,
    () => props.view.approval?.expires_at,
  ],
  scheduleExactExpiry,
  { immediate: true },
);
onBeforeUnmount(() => {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
});
</script>

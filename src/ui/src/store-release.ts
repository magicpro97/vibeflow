// #760: Registry release-proposal review state, split from store.ts for the
// 400-line cap. Read-only: list + open detail + close. No mutation.
import { ref } from "vue";
import { api } from "./api.js";
import type { ReleaseProposalDetail, ReleaseProposalSummary } from "./types-release.js";

export function createReleaseProposalState() {
  const releaseProposals = ref<ReleaseProposalSummary[]>([]);
  const releaseProposalDetail = ref<ReleaseProposalDetail | null>(null);
  const releaseLoading = ref(false);
  const releaseError = ref<string | null>(null);

  async function loadReleaseProposals() {
    releaseLoading.value = true;
    releaseError.value = null;
    try {
      releaseProposals.value = await api.releases.list();
    } catch (e) {
      releaseProposals.value = [];
      releaseError.value =
        e instanceof Error ? e.message.slice(0, 120) : "Failed to load release proposals";
    } finally {
      releaseLoading.value = false;
    }
  }

  async function openReleaseProposal(id: string) {
    releaseError.value = null;
    try {
      releaseProposalDetail.value = await api.releases.get(id);
      return true;
    } catch (e) {
      releaseProposalDetail.value = null;
      releaseError.value =
        e instanceof Error ? e.message.slice(0, 120) : "Failed to load release proposal";
      return false;
    }
  }

  function closeReleaseProposal() {
    releaseProposalDetail.value = null;
  }

  return {
    releaseProposals,
    releaseProposalDetail,
    releaseLoading,
    releaseError,
    loadReleaseProposals,
    openReleaseProposal,
    closeReleaseProposal,
  };
}

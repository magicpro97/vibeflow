import type { HomeConversationStreamStatus } from "./conversation-home-types.js";

interface HomeLoadingCopy {
  eyebrow: string;
  title: string;
  detail: string;
  checkpoints: readonly string[];
}

export interface HomeCatalogLoadingCopy extends HomeLoadingCopy {
  searchLabel: string;
}

export interface HomeComposerBusyCopy {
  active: boolean;
  label: string;
  detail: string;
}

export interface HomeCapabilityTargetBusyCopy {
  footerLabel: string;
  detail: string;
  ctaLabel: string;
}

export function describeHomeCatalogLoading(input: {
  query: string;
  health: "ready" | "rebuilding" | "degraded";
}): HomeCatalogLoadingCopy {
  const query = input.query.trim();
  if (query) {
    return {
      eyebrow: "Conversation index",
      title: `Searching for "${query}"`,
      detail:
        "Matching topics, participants, and recent durable activity without dropping the conversation you are already reading.",
      checkpoints: ["Topic match", "Participant match", "Pinned current session"],
      searchLabel: "Searching",
    };
  }
  if (input.health === "rebuilding") {
    return {
      eyebrow: "Conversation index",
      title: "Rebuilding recent conversations",
      detail:
        "Home is restoring the durable index and aligning each rail entry with its latest committed head.",
      checkpoints: ["Restore heads", "Sort recent activity", "Prepare more results"],
      searchLabel: "Refreshing rail",
    };
  }
  if (input.health === "degraded") {
    return {
      eyebrow: "Conversation index",
      title: "Refreshing from partial index",
      detail:
        "The rail is reading what is available now and will sharpen ordering as the durable index recovers.",
      checkpoints: ["Read available sessions", "Keep current focus", "Backfill the rail"],
      searchLabel: "Refreshing rail",
    };
  }
  return {
    eyebrow: "Conversation index",
    title: "Loading recent conversations",
    detail:
      "Home is restoring the rail, recent heads, and any active search context for this workspace.",
    checkpoints: ["Recent sessions", "Active heads", "Search context"],
    searchLabel: "Refreshing rail",
  };
}

export function describeHomeActivationLoading(input: {
  topic: string | null;
  streamStatus: HomeConversationStreamStatus;
}): HomeLoadingCopy {
  const title = input.topic ? `Restoring ${input.topic}` : "Restoring conversation";
  if (input.streamStatus === "connecting" || input.streamStatus === "reconnecting") {
    return {
      eyebrow: "Conversation restore",
      title,
      detail:
        "Rebinding the live cursor, durable queue, and public transcript before the room resumes.",
      checkpoints: ["Bind live cursor", "Replay transcript", "Sync queued work"],
    };
  }
  return {
    eyebrow: "Conversation restore",
    title,
    detail:
      "Verifying the active head, public trace, and durable queue before Home unlocks the transcript.",
    checkpoints: ["Verify head", "Replay transcript", "Attach action receipts"],
  };
}

export function describeHomeWelcomeLoading(): HomeLoadingCopy {
  return {
    eyebrow: "New conversation",
    title: "Opening a fresh room",
    detail:
      "Creating the durable session, preserving your first brief, and preparing the transcript to receive it.",
    checkpoints: ["Reserve root session", "Stage first brief", "Attach Home to the room"],
  };
}

export function describeHomeTraceLoading(topic: string | null): HomeLoadingCopy {
  return {
    eyebrow: "Public durable record",
    title: topic ? `Rebuilding trace for ${topic}` : "Rebuilding trace",
    detail:
      "Linking correlation, evidence references, and action receipts from the selected public timeline.",
    checkpoints: ["Read head digest", "Link evidence", "Attach receipts"],
  };
}

export function describeHomeCapabilityLoading(input: {
  query: string;
  scope: "project" | "user";
}): HomeLoadingCopy {
  const query = input.query.trim();
  return {
    eyebrow: input.scope === "user" ? "Shared capability index" : "Project capability index",
    title: query
      ? `Scanning "${query}"`
      : input.scope === "user"
        ? "Loading shared capabilities"
        : "Loading project capabilities",
    detail:
      "Checking installed skills, tools, MCP servers, hooks, and recovery state for this scope.",
    checkpoints: ["Installed", "Needs review", "Recoverable"],
  };
}

export function describeHomeComposerBusy(input: {
  hasActiveSession: boolean;
  submitting: boolean;
  savingQueuedEdit: boolean;
}): HomeComposerBusyCopy {
  if (input.savingQueuedEdit) {
    return {
      active: true,
      label: "Saving slot",
      detail:
        "Updating the latest queued message without changing its targets or attached context.",
    };
  }
  if (!input.submitting) {
    return {
      active: false,
      label: "",
      detail: "",
    };
  }
  if (input.hasActiveSession) {
    return {
      active: true,
      label: "Queueing brief",
      detail: "Preserving this message in the durable queue before participants pick it up.",
    };
  }
  return {
    active: true,
    label: "Opening room",
    detail:
      "Creating the durable conversation shell and staging your first brief for the transcript.",
  };
}

export function describeHomeCapabilityTargetBusy(
  submitting: boolean,
): HomeCapabilityTargetBusyCopy {
  if (!submitting) {
    return {
      footerLabel: "Selection ready",
      detail: "Choose one or more participants. Nothing installs until you review the proposal.",
      ctaLabel: "Review install",
    };
  }
  return {
    footerLabel: "Checking route authority",
    detail:
      "Confirming that this exact conversation head still owns the selected participants before review opens.",
    ctaLabel: "Checking route",
  };
}

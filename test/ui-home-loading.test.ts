import { describe, expect, test } from "bun:test";
import {
  describeHomeActivationLoading,
  describeHomeCapabilityLoading,
  describeHomeCapabilityTargetBusy,
  describeHomeCatalogLoading,
  describeHomeComposerBusy,
  describeHomeTraceLoading,
  describeHomeWelcomeLoading,
} from "../src/ui/src/conversation-home-loading.js";

describe("Home loading copy", () => {
  test("catalog loading reflects search and rail health", () => {
    expect(
      describeHomeCatalogLoading({
        query: "planner",
        health: "ready",
      }),
    ).toMatchObject({
      title: 'Searching for "planner"',
      searchLabel: "Searching",
    });

    expect(
      describeHomeCatalogLoading({
        query: "",
        health: "rebuilding",
      }),
    ).toMatchObject({
      title: "Rebuilding recent conversations",
      searchLabel: "Refreshing rail",
    });
  });

  test("activation and trace loading stay specific to the transcript", () => {
    expect(
      describeHomeActivationLoading({
        topic: "Release hardening",
        streamStatus: "reconnecting",
      }),
    ).toMatchObject({
      title: "Restoring Release hardening",
      checkpoints: ["Bind live cursor", "Replay transcript", "Sync queued work"],
    });

    expect(describeHomeTraceLoading("Release hardening")).toMatchObject({
      title: "Rebuilding trace for Release hardening",
      checkpoints: ["Read head digest", "Link evidence", "Attach receipts"],
    });
  });

  test("composer busy copy distinguishes create, queue, and edit flows", () => {
    expect(
      describeHomeComposerBusy({
        hasActiveSession: false,
        submitting: true,
        savingQueuedEdit: false,
      }),
    ).toEqual({
      active: true,
      blocksSubmit: true,
      label: "Opening room",
      detail:
        "Creating the durable conversation shell and staging your first brief for the transcript.",
    });

    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: true,
        savingQueuedEdit: false,
      }),
    ).toEqual({
      active: true,
      blocksSubmit: true,
      label: "Preparing change",
      detail:
        "Building a reviewed conversation or capability change. No message queue slot is being created.",
    });

    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: true,
        savingQueuedEdit: false,
        queueAdmissionPending: true,
      }),
    ).toMatchObject({
      blocksSubmit: true,
      label: "Preparing change",
    });

    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: false,
        savingQueuedEdit: false,
        queueAdmissionPending: true,
        lifecycle: "NEEDS_INPUT",
      }),
    ).toEqual({
      active: true,
      blocksSubmit: false,
      label: "Adding reply to queue",
      detail:
        "Waiting for the durable queue to accept your clarification. You can keep typing another message.",
    });

    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: false,
        savingQueuedEdit: false,
        queueAdmissionPending: true,
      }),
    ).toEqual({
      active: true,
      blocksSubmit: false,
      label: "Adding message to queue",
      detail:
        "Waiting for durable queue admission. You can keep typing while this message is confirmed.",
    });

    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: false,
        savingQueuedEdit: true,
      }),
    ).toEqual({
      active: true,
      blocksSubmit: true,
      label: "Saving edit",
      detail:
        "Updating the latest queued message without changing its targets or attached context.",
    });
  });

  test("capability states stay contextual", () => {
    expect(
      describeHomeCapabilityLoading({
        query: "",
        scope: "project",
      }),
    ).toMatchObject({
      title: "Loading project capabilities",
      checkpoints: ["Installed", "Needs review", "Recoverable"],
    });

    expect(describeHomeCapabilityTargetBusy(false)).toEqual({
      footerLabel: "Selection ready",
      detail: "Choose one or more participants. Nothing installs until you review the proposal.",
      ctaLabel: "Review install",
    });

    expect(describeHomeCapabilityTargetBusy(true)).toEqual({
      footerLabel: "Checking route authority",
      detail:
        "Confirming that this exact conversation head still owns the selected participants before review opens.",
      ctaLabel: "Checking route",
    });
  });

  test("welcome loading keeps the first-run state specific to conversation creation", () => {
    expect(describeHomeWelcomeLoading()).toEqual({
      eyebrow: "New conversation",
      title: "Opening a fresh room",
      detail:
        "Creating the durable session, preserving your first brief, and preparing the transcript to receive it.",
      checkpoints: ["Reserve root session", "Stage first brief", "Attach Home to the room"],
    });
  });
});

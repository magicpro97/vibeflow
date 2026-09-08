const { describe, expect, test } = await import(String("bun:test"));
import {
  describeHomeComposerDescription,
  describeHomeComposerPlaceholder,
  describeHomeSendLabel,
} from "../conversation-home-loading.js";

describe("conversation home loading copy seams", () => {
  test("composer description follows queue-edit / send-as-new / busy states", () => {
    expect(
      describeHomeComposerDescription({
        queuedMessageEdit: true,
        queueSendAsNew: false,
        busyActive: false,
      }),
    ).toContain("queue-edit-help");
    expect(
      describeHomeComposerDescription({
        queuedMessageEdit: false,
        queueSendAsNew: true,
        busyActive: false,
      }),
    ).toContain("queue-send-as-new-help");
    expect(
      describeHomeComposerDescription({
        queuedMessageEdit: false,
        queueSendAsNew: false,
        busyActive: true,
      }),
    ).toContain("composer-status");
    expect(
      describeHomeComposerDescription({
        queuedMessageEdit: false,
        queueSendAsNew: false,
        busyActive: false,
      }),
    ).not.toContain("queue-edit-help");
  });

  test("composer placeholder follows lifecycle and session", () => {
    expect(describeHomeComposerPlaceholder({ needsInput: true, activeSession: false })).toContain(
      "missing detail",
    );
    expect(describeHomeComposerPlaceholder({ needsInput: false, activeSession: true })).toContain(
      "extend the CLI",
    );
    expect(describeHomeComposerPlaceholder({ needsInput: false, activeSession: false })).toContain(
      "AI team to build",
    );
  });

  test("send label covers every state", () => {
    expect(
      describeHomeSendLabel({
        savingQueuedEdit: true,
        queuedMessageEdit: false,
        queueSendAsNew: false,
        submitting: false,
      }),
    ).toBe("Saving queued message");
    expect(
      describeHomeSendLabel({
        savingQueuedEdit: false,
        queuedMessageEdit: true,
        queueSendAsNew: false,
        submitting: false,
      }),
    ).toBe("Save queued message");
    expect(
      describeHomeSendLabel({
        savingQueuedEdit: false,
        queuedMessageEdit: false,
        queueSendAsNew: true,
        submitting: false,
      }),
    ).toContain("Send preserved draft");
    expect(
      describeHomeSendLabel({
        savingQueuedEdit: false,
        queuedMessageEdit: false,
        queueSendAsNew: false,
        submitting: true,
      }),
    ).toBe("Preparing action");
    expect(
      describeHomeSendLabel({
        savingQueuedEdit: false,
        queuedMessageEdit: false,
        queueSendAsNew: false,
        submitting: false,
      }),
    ).toBe("Send message");
  });
});

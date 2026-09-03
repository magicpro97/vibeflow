import type { HomeQueueAdmissionEntry } from "./conversation-home-message-queue-authority.js";
import { createHomeActionKey } from "./conversation-home-runtime.js";

interface HomeMessageQueueClientLane {
  client_instance_id: string;
  next_wire_order: number;
  next_projection_order: number;
}

export interface HomeMessageQueueClientLaneAllocation {
  clientInstanceId: string;
  wireClientOrder: number;
  projectionOrder: number;
}

const clientInstanceId = (): string => `home-client.${createHomeActionKey()}`.slice(0, 128);

/**
 * Owns browser-local admission lanes independently from UI projection order.
 *
 * A rejected or ambiguous request keeps its exact lane for replay. Later requests are rebound to
 * a fresh lane, so the server's contiguous per-lane order cannot be permanently gapped.
 */
export class HomeMessageQueueClientLanes {
  private readonly initialClientInstanceId = clientInstanceId();
  private readonly byRoot = new Map<string, HomeMessageQueueClientLane>();

  private lane(root: string): HomeMessageQueueClientLane {
    const current = this.byRoot.get(root);
    if (current) return current;
    const created = {
      client_instance_id: this.initialClientInstanceId,
      next_wire_order: 0,
      next_projection_order: 0,
    };
    this.byRoot.set(root, created);
    return created;
  }

  allocate(root: string): HomeMessageQueueClientLaneAllocation {
    const lane = this.lane(root);
    lane.next_wire_order += 1;
    lane.next_projection_order += 1;
    return {
      clientInstanceId: lane.client_instance_id,
      wireClientOrder: lane.next_wire_order,
      projectionOrder: lane.next_projection_order,
    };
  }

  rotateAfterFailure(
    failed: HomeQueueAdmissionEntry,
    candidates: Iterable<HomeQueueAdmissionEntry>,
  ): void {
    const lane = this.lane(failed.root);
    if (lane.client_instance_id !== failed.request.client_instance_id) return;
    const nextClientInstanceId = clientInstanceId();
    const later = [...candidates]
      .filter(
        (entry) =>
          entry !== failed &&
          entry.root === failed.root &&
          entry.request.client_instance_id === failed.request.client_instance_id &&
          entry.projection.client_order > failed.projection.client_order,
      )
      .sort((left, right) => left.projection.client_order - right.projection.client_order);
    later.forEach((entry, index) => {
      entry.request.client_instance_id = nextClientInstanceId;
      entry.request.client_order = index + 1;
    });
    lane.client_instance_id = nextClientInstanceId;
    lane.next_wire_order = later.length;
  }

  rotateAfterOfflineInterruption(root: string, interruptedCount: number): void {
    if (!interruptedCount) return;
    const lane = this.lane(root);
    lane.client_instance_id = clientInstanceId();
    lane.next_wire_order = 0;
  }

  rebindAfterAbandonment(
    failed: HomeQueueAdmissionEntry,
    candidates: Iterable<HomeQueueAdmissionEntry>,
  ): void {
    const lane = this.lane(failed.root);
    const later = [...candidates]
      .filter(
        (entry) =>
          entry.root === failed.root &&
          entry.request.client_instance_id === failed.request.client_instance_id &&
          entry.projection.client_order > failed.projection.client_order,
      )
      .sort((left, right) => left.projection.client_order - right.projection.client_order);
    for (const entry of later) {
      lane.next_wire_order += 1;
      entry.request.client_instance_id = lane.client_instance_id;
      entry.request.client_order = lane.next_wire_order;
    }
  }

  clear(): void {
    this.byRoot.clear();
  }
}

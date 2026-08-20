import { describe, expect, it } from "vitest";
import type {
  OutboxEnvelope,
  OutboxPublisher,
  OutboxRelayStore,
} from "./outbox-relay.service.js";
import { OutboxRelayService } from "./outbox-relay.service.js";

const NOW = new Date("2026-08-17T13:00:00.000Z");

describe("OutboxRelayService", () => {
  it("publishes a claimed event and acknowledges it with the same lease owner", async () => {
    const store = new FakeOutboxStore([event("event-1", 1)]);
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelayService(store, publisher, "worker-1", () => NOW);

    const result = await relay.runBatch(10);

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(publisher.events).toEqual([expect.objectContaining({ id: "event-1" })]);
    expect(store.published).toEqual([
      { eventId: "event-1", workerId: "worker-1", publishedAt: NOW },
    ]);
  });

  it("releases a failed event with exponential backoff", async () => {
    const store = new FakeOutboxStore([event("event-2", 3)]);
    const publisher: OutboxPublisher = {
      publish: async () => {
        throw new Error("broker unavailable");
      },
    };
    const relay = new OutboxRelayService(store, publisher, "worker-2", () => NOW);

    const result = await relay.runBatch();

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(store.failed).toEqual([
      {
        eventId: "event-2",
        workerId: "worker-2",
        nextAttemptAt: new Date("2026-08-17T13:00:04.000Z"),
        error: "broker unavailable",
      },
    ]);
  });

  it("uses a lease expiry boundary and rejects unsafe batch sizes", async () => {
    const store = new FakeOutboxStore([]);
    const relay = new OutboxRelayService(
      store,
      new RecordingPublisher(),
      "worker-3",
      () => NOW,
      30_000,
    );

    await relay.runBatch(25);
    expect(store.claims[0]).toEqual({
      workerId: "worker-3",
      now: NOW,
      leaseExpiredBefore: new Date("2026-08-17T12:59:30.000Z"),
      batchSize: 25,
    });
    await expect(relay.runBatch(0)).rejects.toBeInstanceOf(RangeError);
  });

  it("does not misclassify a database acknowledgement failure as publish failure", async () => {
    const store = new FakeOutboxStore([event("event-3", 1)]);
    store.failAcknowledgement = true;
    const relay = new OutboxRelayService(
      store,
      new RecordingPublisher(),
      "worker-4",
      () => NOW,
    );

    await expect(relay.runBatch()).rejects.toThrow("lease lost");
    expect(store.failed).toHaveLength(0);
  });

  it("passes an explicit event subscription to the store", async () => {
    const store = new FakeOutboxStore([]);
    const relay = new OutboxRelayService(
      store,
      new RecordingPublisher(),
      "digest-worker",
      () => NOW,
      60_000,
      1_000,
      5 * 60_000,
      ["report.weekly.published", "report.weekly.published"],
    );

    await relay.runBatch(5);

    expect(store.claims[0]?.eventTypes).toEqual(["report.weekly.published"]);
  });
});

class RecordingPublisher implements OutboxPublisher {
  events: OutboxEnvelope[] = [];

  async publish(event: OutboxEnvelope) {
    this.events.push(event);
  }
}

class FakeOutboxStore implements OutboxRelayStore {
  failAcknowledgement = false;
  claims: Array<{
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
    eventTypes?: readonly string[];
  }> = [];
  published: Array<{ eventId: string; workerId: string; publishedAt: Date }> = [];
  failed: Array<{
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
    error: string;
  }> = [];

  constructor(private readonly events: OutboxEnvelope[]) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
    eventTypes?: readonly string[];
  }) {
    this.claims.push(input);
    return this.events.slice(0, input.batchSize);
  }

  async markPublished(input: {
    eventId: string;
    workerId: string;
    publishedAt: Date;
  }) {
    if (this.failAcknowledgement) throw new Error("lease lost");
    this.published.push(input);
  }

  async markFailed(input: {
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
    error: string;
  }) {
    this.failed.push(input);
  }
}

function event(id: string, attempts: number): OutboxEnvelope {
  return {
    id,
    eventType: "task.completed",
    aggregateType: "Task",
    aggregateId: "task-1",
    aggregateVersion: 4,
    schemaVersion: 1,
    payload: { taskId: "task-1" },
    occurredAt: NOW,
    attempts,
  };
}

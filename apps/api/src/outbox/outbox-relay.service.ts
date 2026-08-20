import { OutboxLeaseLostError } from "./prisma-outbox-relay.store.js";

export interface OutboxEnvelope {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

export interface OutboxRelayStore {
  claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
    eventTypes?: readonly string[];
  }): Promise<OutboxEnvelope[]>;
  markPublished(input: { eventId: string; workerId: string; publishedAt: Date }): Promise<void>;
  markFailed(input: {
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
    error: string;
  }): Promise<void>;
}

export interface OutboxPublisher {
  publish(event: OutboxEnvelope): Promise<void>;
}

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

export class OutboxRelayService {
  private readonly eventTypes?: readonly string[];

  constructor(
    private readonly store: OutboxRelayStore,
    private readonly publisher: OutboxPublisher,
    private readonly workerId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 60_000,
    private readonly baseRetryMs = 1_000,
    private readonly maxRetryMs = 5 * 60_000,
    eventTypes?: readonly string[],
  ) {
    this.eventTypes = normalizeEventTypes(eventTypes);
  }

  async runBatch(batchSize = 50): Promise<OutboxBatchResult> {
    const claimedAt = this.clock();
    const events = await this.store.claimBatch({
      workerId: this.workerId,
      now: claimedAt,
      leaseExpiredBefore: new Date(claimedAt.getTime() - this.leaseMs),
      batchSize: normalizeBatchSize(batchSize),
      ...(this.eventTypes ? { eventTypes: this.eventTypes } : {}),
    });
    const result: OutboxBatchResult = {
      claimed: events.length,
      published: 0,
      failed: 0,
    };

    for (const event of events) {
      try {
        await this.publisher.publish(event);
      } catch (error) {
        const failedAt = this.clock();
        try {
          await this.store.markFailed({
            eventId: event.id,
            workerId: this.workerId,
            nextAttemptAt: new Date(failedAt.getTime() + this.retryDelay(event.attempts)),
            error: errorMessage(error),
          });
        } catch (acknowledgeError) {
          if (!(acknowledgeError instanceof OutboxLeaseLostError)) throw acknowledgeError;
          this.logLeaseLost(event.id, "markFailed");
        }
        result.failed += 1;
        continue;
      }

      try {
        await this.store.markPublished({
          eventId: event.id,
          workerId: this.workerId,
          publishedAt: this.clock(),
        });
      } catch (acknowledgeError) {
        if (!(acknowledgeError instanceof OutboxLeaseLostError)) throw acknowledgeError;
        // Another worker reclaimed the expired lease: the event will be
        // retried (at-least-once delivery), so the batch must keep going.
        this.logLeaseLost(event.id, "markPublished");
        continue;
      }
      result.published += 1;
    }

    return result;
  }

  private logLeaseLost(eventId: string, stage: "markPublished" | "markFailed") {
    console.warn(
      JSON.stringify({
        event: "outbox.lease-lost",
        workerId: this.workerId,
        eventId,
        stage,
      }),
    );
  }

  private retryDelay(attempts: number) {
    return Math.min(this.baseRetryMs * 2 ** Math.max(0, attempts - 1), this.maxRetryMs);
  }
}

function normalizeBatchSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RangeError("Outbox batch size must be an integer between 1 and 500");
  }
  return value;
}

function normalizeEventTypes(values: readonly string[] | undefined) {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new RangeError("Outbox event type subscription cannot be empty");
  }
  return normalized;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

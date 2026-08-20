import { Prisma, type PrismaClient } from "@prisma/client";
import type { OutboxEnvelope, OutboxRelayStore } from "./outbox-relay.service.js";

export class OutboxLeaseLostError extends Error {
  constructor(readonly eventId: string) {
    super(`Outbox lease for event ${eventId} is no longer owned by this worker`);
    this.name = "OutboxLeaseLostError";
  }
}

export class PrismaOutboxRelayStore implements OutboxRelayStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
    eventTypes?: readonly string[];
  }): Promise<OutboxEnvelope[]> {
    const eventTypeFilter = input.eventTypes
      ? Prisma.sql`AND "event_type" = ANY(${input.eventTypes}::text[])`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ClaimedOutboxRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "outbox_event"
        WHERE "published_at" IS NULL
          AND "next_attempt_at" <= ${input.now}
          AND ("locked_at" IS NULL OR "locked_at" < ${input.leaseExpiredBefore})
          ${eventTypeFilter}
        ORDER BY "occurred_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      )
      UPDATE "outbox_event" AS event
      SET
        "locked_at" = ${input.now},
        "locked_by" = ${input.workerId},
        "attempts" = event."attempts" + 1
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING
        event."id",
        event."event_type",
        event."aggregate_type",
        event."aggregate_id",
        event."aggregate_version",
        event."schema_version",
        event."payload",
        event."occurred_at",
        event."attempts"
    `);
    return rows.map(mapClaimedRow);
  }

  async markPublished(input: {
    eventId: string;
    workerId: string;
    publishedAt: Date;
  }): Promise<void> {
    const updated = await this.prisma.outboxEvent.updateMany({
      where: {
        id: input.eventId,
        lockedBy: input.workerId,
        publishedAt: null,
      },
      data: {
        publishedAt: input.publishedAt,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    if (updated.count !== 1) throw new OutboxLeaseLostError(input.eventId);
  }

  async markFailed(input: {
    eventId: string;
    workerId: string;
    nextAttemptAt: Date;
    error: string;
  }): Promise<void> {
    const updated = await this.prisma.outboxEvent.updateMany({
      where: {
        id: input.eventId,
        lockedBy: input.workerId,
        publishedAt: null,
      },
      data: {
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.error,
        lockedAt: null,
        lockedBy: null,
      },
    });
    if (updated.count !== 1) throw new OutboxLeaseLostError(input.eventId);
  }
}

interface ClaimedOutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  schema_version: number;
  payload: Prisma.JsonValue;
  occurred_at: Date;
  attempts: number;
}

function mapClaimedRow(row: ClaimedOutboxRow): OutboxEnvelope {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    schemaVersion: row.schema_version,
    payload: objectPayload(row.payload),
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  };
}

function objectPayload(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TypeError("Outbox payload must be a JSON object");
}

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  PlacementMonitorJob,
  PlacementMonitorStore,
} from "./placement-monitor.service.js";

export class PlacementMonitorLeaseLostError extends Error {
  constructor(readonly placementId: string) {
    super(`Placement monitor lease for ${placementId} is no longer owned by this worker`);
    this.name = "PlacementMonitorLeaseLostError";
  }
}

export class PrismaPlacementMonitorStore implements PlacementMonitorStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
  }): Promise<PlacementMonitorJob[]> {
    const rows = await this.prisma.$queryRaw<ClaimedPlacementRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "placement"
        WHERE "archived_at" IS NULL
          AND "business_status" = 'active'
          AND "next_check_at" IS NOT NULL
          AND "next_check_at" <= ${input.now}
          AND "monitor_dead_at" IS NULL
          AND (
            "monitor_locked_at" IS NULL
            OR "monitor_locked_at" < ${input.leaseExpiredBefore}
          )
        ORDER BY "next_check_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      )
      UPDATE "placement" AS placement
      SET
        "monitor_locked_at" = ${input.now},
        "monitor_locked_by" = ${input.workerId},
        "monitor_attempts" = placement."monitor_attempts" + 1,
        "monitor_job_key" = COALESCE(
          placement."monitor_job_key",
          'placement-monitor:' || placement."id"::text || ':' ||
            FLOOR(EXTRACT(EPOCH FROM placement."next_check_at") * 1000)::bigint::text
        )
      FROM candidates
      WHERE placement."id" = candidates."id"
      RETURNING
        placement."id",
        placement."next_check_at" AS "scheduled_for",
        placement."monitor_job_key" AS "job_key",
        placement."monitor_attempts" AS "attempts"
    `);
    return rows.map(mapClaimedRow);
  }

  async markCompleted(input: {
    placementId: string;
    workerId: string;
  }): Promise<void> {
    const updated = await this.prisma.placement.updateMany({
      where: {
        id: input.placementId,
        monitorLockedBy: input.workerId,
        monitorDeadAt: null,
      },
      data: {
        monitorLockedAt: null,
        monitorLockedBy: null,
        monitorAttempts: 0,
        monitorJobKey: null,
        monitorLastError: null,
        monitorDeadAt: null,
      },
    });
    if (updated.count !== 1) throw new PlacementMonitorLeaseLostError(input.placementId);
  }

  async markFailed(input: {
    placementId: string;
    workerId: string;
    nextAttemptAt: Date | null;
    error: string;
    deadAt: Date | null;
  }): Promise<void> {
    const updated = await this.prisma.placement.updateMany({
      where: {
        id: input.placementId,
        monitorLockedBy: input.workerId,
        monitorDeadAt: null,
      },
      data: {
        nextCheckAt: input.nextAttemptAt,
        monitorLastError: input.error,
        monitorDeadAt: input.deadAt,
        monitorLockedAt: null,
        monitorLockedBy: null,
      },
    });
    if (updated.count !== 1) throw new PlacementMonitorLeaseLostError(input.placementId);
  }
}

interface ClaimedPlacementRow {
  id: string;
  scheduled_for: Date;
  job_key: string;
  attempts: number;
}

function mapClaimedRow(row: ClaimedPlacementRow): PlacementMonitorJob {
  if (!row.job_key) throw new TypeError(`Placement monitor job ${row.id} has no idempotency key`);
  return {
    placementId: row.id,
    scheduledFor: row.scheduled_for,
    jobKey: row.job_key,
    attempts: row.attempts,
  };
}

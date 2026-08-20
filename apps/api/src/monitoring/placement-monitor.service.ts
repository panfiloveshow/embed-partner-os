import type { PlacementPort } from "../placement.port.js";

export interface PlacementMonitorJob {
  placementId: string;
  scheduledFor: Date;
  jobKey: string;
  attempts: number;
}

export interface PlacementMonitorStore {
  claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
  }): Promise<PlacementMonitorJob[]>;
  markCompleted(input: { placementId: string; workerId: string }): Promise<void>;
  markFailed(input: {
    placementId: string;
    workerId: string;
    nextAttemptAt: Date | null;
    error: string;
    deadAt: Date | null;
  }): Promise<void>;
}

export interface PlacementMonitorBatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

export class PlacementMonitorService {
  constructor(
    private readonly store: PlacementMonitorStore,
    private readonly placements: PlacementPort,
    private readonly workerId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 60_000,
    private readonly baseRetryMs = 60_000,
    private readonly maxRetryMs = 45 * 60_000,
    private readonly maxAttempts = 8,
  ) {
    if (!workerId.trim()) throw new RangeError("Placement monitor worker ID cannot be empty");
    positiveInteger(leaseMs, "Placement monitor lease");
    positiveInteger(baseRetryMs, "Placement monitor base retry");
    positiveInteger(maxRetryMs, "Placement monitor max retry");
    positiveInteger(maxAttempts, "Placement monitor max attempts");
    if (baseRetryMs > maxRetryMs) {
      throw new RangeError("Placement monitor base retry cannot exceed max retry");
    }
  }

  async runBatch(batchSize = 10): Promise<PlacementMonitorBatchResult> {
    const claimedAt = this.clock();
    const jobs = await this.store.claimBatch({
      workerId: this.workerId,
      now: claimedAt,
      leaseExpiredBefore: new Date(claimedAt.getTime() - this.leaseMs),
      batchSize: normalizeBatchSize(batchSize),
    });
    const result: PlacementMonitorBatchResult = {
      claimed: jobs.length,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
    };

    for (const job of jobs) {
      try {
        await this.placements.runL0Check(job.placementId, job.jobKey, "schedule");
      } catch (error) {
        const failedAt = this.clock();
        const deadLettered = job.attempts >= this.maxAttempts;
        await this.store.markFailed({
          placementId: job.placementId,
          workerId: this.workerId,
          nextAttemptAt: deadLettered
            ? null
            : new Date(failedAt.getTime() + this.retryDelay(job.attempts)),
          error: errorMessage(error),
          deadAt: deadLettered ? failedAt : null,
        });
        if (deadLettered) result.deadLettered += 1;
        else result.failed += 1;
        continue;
      }

      await this.store.markCompleted({
        placementId: job.placementId,
        workerId: this.workerId,
      });
      result.succeeded += 1;
    }

    return result;
  }

  private retryDelay(attempts: number) {
    return Math.min(this.baseRetryMs * 2 ** Math.max(0, attempts - 1), this.maxRetryMs);
  }
}

function normalizeBatchSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RangeError("Placement monitor batch size must be an integer between 1 and 500");
  }
  return value;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

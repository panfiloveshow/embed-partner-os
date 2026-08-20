import { describe, expect, it } from "vitest";
import type {
  HealthCheckView,
  PlacementCheckResult,
  PlacementView,
} from "@embed-os/contracts";
import type { PlacementPort } from "../placement.port.js";
import {
  PlacementMonitorService,
  type PlacementMonitorJob,
  type PlacementMonitorStore,
} from "./placement-monitor.service.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("PlacementMonitorService", () => {
  it("runs a claimed scheduled check with its stable job key and acknowledges the lease", async () => {
    const store = new FakePlacementMonitorStore([
      job("placement-1", "placement-monitor:placement-1:1787050800000", 1),
    ]);
    const placements = new RecordingPlacementPort();
    const monitor = new PlacementMonitorService(store, placements, "monitor-1", () => NOW);

    const result = await monitor.runBatch(10);

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0, deadLettered: 0 });
    expect(placements.checks).toEqual([{
      placementId: "placement-1",
      idempotencyKey: "placement-monitor:placement-1:1787050800000",
      source: "schedule",
    }]);
    expect(store.completed).toEqual([{ placementId: "placement-1", workerId: "monitor-1" }]);
  });

  it("releases a failed check with exponential backoff and continues the batch", async () => {
    const store = new FakePlacementMonitorStore([
      job("placement-failed", "placement-monitor:placement-failed:1", 3),
      job("placement-ok", "placement-monitor:placement-ok:2", 1),
    ]);
    const placements = new RecordingPlacementPort(["placement-failed"]);
    const monitor = new PlacementMonitorService(store, placements, "monitor-2", () => NOW);

    const result = await monitor.runBatch();

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1, deadLettered: 0 });
    expect(store.failed).toEqual([{
      placementId: "placement-failed",
      workerId: "monitor-2",
      nextAttemptAt: new Date("2026-08-18T12:04:00.000Z"),
      error: "checker unavailable",
      deadAt: null,
    }]);
    expect(store.completed).toEqual([{ placementId: "placement-ok", workerId: "monitor-2" }]);
  });

  it("moves a check to dead-letter after the maximum attempt", async () => {
    const store = new FakePlacementMonitorStore([
      job("placement-dead", "placement-monitor:placement-dead:1", 8),
    ]);
    const placements = new RecordingPlacementPort(["placement-dead"]);
    const monitor = new PlacementMonitorService(store, placements, "monitor-3", () => NOW);

    const result = await monitor.runBatch();

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 0, deadLettered: 1 });
    expect(store.failed).toEqual([{
      placementId: "placement-dead",
      workerId: "monitor-3",
      nextAttemptAt: null,
      error: "checker unavailable",
      deadAt: NOW,
    }]);
  });

  it("uses the lease expiry boundary and rejects unsafe batch sizes", async () => {
    const store = new FakePlacementMonitorStore([]);
    const monitor = new PlacementMonitorService(
      store,
      new RecordingPlacementPort(),
      "monitor-4",
      () => NOW,
      30_000,
    );

    await monitor.runBatch(25);

    expect(store.claims[0]).toEqual({
      workerId: "monitor-4",
      now: NOW,
      leaseExpiredBefore: new Date("2026-08-18T11:59:30.000Z"),
      batchSize: 25,
    });
    await expect(monitor.runBatch(0)).rejects.toBeInstanceOf(RangeError);
    await expect(monitor.runBatch(501)).rejects.toBeInstanceOf(RangeError);
  });

  it("does not turn a successful check acknowledgement failure into a retry", async () => {
    const store = new FakePlacementMonitorStore([
      job("placement-lease", "placement-monitor:placement-lease:1", 1),
    ]);
    store.failAcknowledgement = true;
    const monitor = new PlacementMonitorService(
      store,
      new RecordingPlacementPort(),
      "monitor-5",
      () => NOW,
    );

    await expect(monitor.runBatch()).rejects.toThrow("lease lost");
    expect(store.failed).toHaveLength(0);
  });
});

class RecordingPlacementPort implements PlacementPort {
  checks: Array<{
    placementId: string;
    idempotencyKey: string;
    source: "manual" | "schedule";
  }> = [];

  constructor(private readonly failures: string[] = []) {}

  list(): PlacementView[] {
    return [];
  }

  register(): PlacementView {
    throw new Error("Not implemented in monitor tests");
  }

  update(): PlacementView {
    throw new Error("Not implemented in monitor tests");
  }

  archive(): PlacementView {
    throw new Error("Not implemented in monitor tests");
  }

  async runL0Check(
    placementId: string,
    idempotencyKey: string,
    source: "manual" | "schedule",
  ): Promise<PlacementCheckResult> {
    this.checks.push({ placementId, idempotencyKey, source });
    if (this.failures.includes(placementId)) throw new Error("checker unavailable");
    return {} as PlacementCheckResult;
  }

  listChecks(): HealthCheckView[] {
    return [];
  }
}

class FakePlacementMonitorStore implements PlacementMonitorStore {
  failAcknowledgement = false;
  claims: Array<{
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
  }> = [];
  completed: Array<{ placementId: string; workerId: string }> = [];
  failed: Array<{
    placementId: string;
    workerId: string;
    nextAttemptAt: Date | null;
    error: string;
    deadAt: Date | null;
  }> = [];

  constructor(private readonly jobs: PlacementMonitorJob[]) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    leaseExpiredBefore: Date;
    batchSize: number;
  }) {
    this.claims.push(input);
    return this.jobs.slice(0, input.batchSize);
  }

  async markCompleted(input: { placementId: string; workerId: string }) {
    if (this.failAcknowledgement) throw new Error("lease lost");
    this.completed.push(input);
  }

  async markFailed(input: {
    placementId: string;
    workerId: string;
    nextAttemptAt: Date | null;
    error: string;
    deadAt: Date | null;
  }) {
    this.failed.push(input);
  }
}

function job(placementId: string, jobKey: string, attempts: number): PlacementMonitorJob {
  return {
    placementId,
    scheduledFor: new Date("2026-08-18T11:00:00.000Z"),
    jobKey,
    attempts,
  };
}

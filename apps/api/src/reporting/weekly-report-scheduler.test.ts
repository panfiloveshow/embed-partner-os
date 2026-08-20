import { describe, expect, it } from "vitest";
import type { GenerateWeeklyReportCommand, WeeklyReportSnapshot } from "@embed-os/contracts";
import type { ReportPort } from "../report.port.js";
import {
  WeeklyReportScheduler,
  latestWeeklyReportRun,
  nextWeeklyReportDue,
} from "./weekly-report-scheduler.js";

describe("weekly report schedule", () => {
  it("switches to the newly completed week exactly at Monday 10:00 Moscow", () => {
    expect(latestWeeklyReportRun(new Date("2026-08-17T06:59:59.999Z"))).toEqual({
      dueAt: new Date("2026-08-10T07:00:00.000Z"),
      idempotencyKey: "weekly-report-scheduled:2026-08-10:weekly-v1",
      command: {
        periodStart: "2026-08-03",
        dataAsOf: "2026-08-10T07:00:00.000Z",
        formulaVersion: "weekly-v1",
      },
    });

    expect(latestWeeklyReportRun(new Date("2026-08-17T07:00:00.000Z"))).toEqual({
      dueAt: new Date("2026-08-17T07:00:00.000Z"),
      idempotencyKey: "weekly-report-scheduled:2026-08-17:weekly-v1",
      command: {
        periodStart: "2026-08-10",
        dataAsOf: "2026-08-17T07:00:00.000Z",
        formulaVersion: "weekly-v1",
      },
    });
  });

  it("calculates the next due instant without relying on the host timezone", () => {
    expect(nextWeeklyReportDue(new Date("2026-08-17T06:59:59.999Z"))).toEqual(
      new Date("2026-08-17T07:00:00.000Z"),
    );
    expect(nextWeeklyReportDue(new Date("2026-08-17T07:00:00.000Z"))).toEqual(
      new Date("2026-08-24T07:00:00.000Z"),
    );
  });

  it("reuses the same command and idempotency key on a catch-up retry", async () => {
    const reports = new RecordingReportPort();
    const scheduler = new WeeklyReportScheduler(
      reports,
      () => new Date("2026-08-18T12:00:00.000Z"),
    );

    await scheduler.runLatestDue();
    await scheduler.runLatestDue();

    expect(reports.calls).toEqual([
      {
        input: {
          periodStart: "2026-08-10",
          dataAsOf: "2026-08-17T07:00:00.000Z",
          formulaVersion: "weekly-v1",
        },
        idempotencyKey: "weekly-report-scheduled:2026-08-17:weekly-v1",
      },
      {
        input: {
          periodStart: "2026-08-10",
          dataAsOf: "2026-08-17T07:00:00.000Z",
          formulaVersion: "weekly-v1",
        },
        idempotencyKey: "weekly-report-scheduled:2026-08-17:weekly-v1",
      },
    ]);
  });
});

class RecordingReportPort implements ReportPort {
  readonly calls: Array<{ input: GenerateWeeklyReportCommand; idempotencyKey: string }> = [];

  async generateWeekly(input: unknown, idempotencyKey: string) {
    this.calls.push({ input: input as GenerateWeeklyReportCommand, idempotencyKey });
    return { id: "snapshot-1" } as WeeklyReportSnapshot;
  }

  getLatestWeekly(): WeeklyReportSnapshot {
    throw new Error("not used");
  }
}

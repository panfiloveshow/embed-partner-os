import type { GenerateWeeklyReportCommand, WeeklyReportSnapshot } from "@embed-os/contracts";
import type { ReportPort } from "../report.port.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1_000;
const MONDAY = 1;
const DUE_HOUR_MOSCOW = 10;

export interface WeeklyReportRun {
  dueAt: Date;
  idempotencyKey: string;
  command: GenerateWeeklyReportCommand;
}

export class WeeklyReportScheduler {
  constructor(
    private readonly reports: ReportPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly formulaVersion = "weekly-v1",
  ) {}

  async runLatestDue(): Promise<WeeklyReportSnapshot> {
    const run = latestWeeklyReportRun(this.clock(), this.formulaVersion);
    return this.reports.generateWeekly(run.command, run.idempotencyKey);
  }
}

export function latestWeeklyReportRun(now: Date, formulaVersion = "weekly-v1"): WeeklyReportRun {
  assertValidDate(now);
  const dueAt = mondayDueForMoscowWeek(now);
  const latestDueAt = now < dueAt ? new Date(dueAt.getTime() - WEEK_MS) : dueAt;
  const periodStart = formatMoscowDate(new Date(latestDueAt.getTime() - WEEK_MS));
  const dueDate = formatMoscowDate(latestDueAt);
  return {
    dueAt: latestDueAt,
    idempotencyKey: `weekly-report-scheduled:${dueDate}:${formulaVersion}`,
    command: {
      periodStart,
      dataAsOf: latestDueAt.toISOString(),
      formulaVersion,
    },
  };
}

export function nextWeeklyReportDue(now: Date): Date {
  assertValidDate(now);
  const dueAt = mondayDueForMoscowWeek(now);
  return now < dueAt ? dueAt : new Date(dueAt.getTime() + WEEK_MS);
}

function mondayDueForMoscowWeek(now: Date): Date {
  const moscow = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  const daysSinceMonday = (moscow.getUTCDay() - MONDAY + 7) % 7;
  const localDueAsUtc = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate() - daysSinceMonday,
    DUE_HOUR_MOSCOW,
  );
  return new Date(localDueAsUtc - MOSCOW_OFFSET_MS);
}

function formatMoscowDate(date: Date): string {
  return new Date(date.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

function assertValidDate(date: Date) {
  if (Number.isNaN(date.getTime()))
    throw new RangeError("Scheduler clock returned an invalid date");
}

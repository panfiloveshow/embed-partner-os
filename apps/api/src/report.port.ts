import type { WeeklyReportSnapshot } from "@embed-os/contracts";

export const REPORT_PORT = Symbol("REPORT_PORT");

export interface ReportPort {
  generateWeekly(
    input: unknown,
    idempotencyKey: string,
  ): WeeklyReportSnapshot | Promise<WeeklyReportSnapshot>;
  getLatestWeekly(): WeeklyReportSnapshot | Promise<WeeklyReportSnapshot>;
}

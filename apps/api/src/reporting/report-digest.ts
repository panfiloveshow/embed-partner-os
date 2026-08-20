import type { WeeklyReportPayload } from "@embed-os/contracts";

export type ReportDigestItem =
  | {
      kind: "decision";
      title: string;
      owner: string;
      dueAt: string;
      affectedCount: number;
    }
  | {
      kind: "risk";
      title: string;
      owner: string;
      severity: "high" | "medium";
      ageDays: number;
    };

export interface WeeklyReportPublishedEventPayload {
  snapshotId: string;
  teamId: string;
  teamName: string;
  periodStart: string;
  periodEnd: string;
  revision: number;
  reportPath: string;
  exceptionCount: number;
  digestItems: ReportDigestItem[];
}

export function buildWeeklyReportDigestItems(payload: WeeklyReportPayload): ReportDigestItem[] {
  const decisions: ReportDigestItem[] = payload.decisions.map((decision) => ({
    kind: "decision",
    title: decision.question,
    owner: decision.owner,
    dueAt: decision.dueAt,
    affectedCount: decision.affectedCount,
  }));
  const risks: ReportDigestItem[] = payload.exceptions.map((exception) => ({
    kind: "risk",
    title: `${exception.organizationName}: ${exception.title}`,
    owner: exception.ownerName,
    severity: exception.severity,
    ageDays: exception.ageDays,
  }));
  return [...decisions, ...risks].slice(0, 7);
}

export function buildWeeklyReportPublishedEventPayload(input: {
  snapshotId: string;
  teamId: string;
  teamName: string;
  periodStart: string;
  periodEnd: string;
  revision: number;
  payload: WeeklyReportPayload;
}): WeeklyReportPublishedEventPayload {
  return {
    snapshotId: input.snapshotId,
    teamId: input.teamId,
    teamName: input.teamName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    revision: input.revision,
    reportPath: "/reports/weekly/snapshots/latest",
    exceptionCount: input.payload.exceptions.length,
    digestItems: buildWeeklyReportDigestItems(input.payload),
  };
}

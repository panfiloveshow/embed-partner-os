import { describe, expect, it } from "vitest";
import { weeklyReportPeriod } from "@embed-os/domain";
import {
  buildWeeklyReportPayload,
  weeklyReportChecksum,
  type WeeklyReportSource,
} from "./weekly-report.js";
import {
  buildWeeklyReportDigestItems,
  buildWeeklyReportPublishedEventPayload,
} from "../reporting/report-digest.js";

const source: WeeklyReportSource = {
  opportunities: [
    {
      id: "opp-1",
      organizationId: "org-1",
      organizationName: "Медиа",
      ownerName: "Анна",
      stageCode: "S4",
      stageLabel: "Диалог",
      status: "ACTIVE",
      nextTaskId: "task-1",
      createdAt: new Date("2026-08-10T08:00:00+03:00"),
      stageEnteredAt: new Date("2026-08-01T08:00:00+03:00"),
    },
    {
      id: "opp-2",
      organizationId: "org-2",
      organizationName: "Спорт",
      ownerName: "Анна",
      stageCode: "S2",
      stageLabel: "Квалифицирован",
      status: "ACTIVE",
      nextTaskId: null,
      createdAt: new Date("2026-08-03T08:00:00+03:00"),
      stageEnteredAt: new Date("2026-08-10T08:00:00+03:00"),
    },
  ],
  stageEvents: [
    { opportunityId: "opp-1", toStage: "S4", occurredAt: new Date("2026-08-12T12:00:00+03:00") },
    { opportunityId: "opp-2", toStage: "S2", occurredAt: new Date("2026-08-10T12:00:00+03:00") },
  ],
  tasks: [
    {
      id: "task-1",
      opportunityId: "opp-1",
      organizationId: "org-1",
      organizationName: "Медиа",
      ownerName: "Анна",
      title: "Ответить партнёру",
      status: "OPEN",
      dueAt: new Date("2026-08-13T12:00:00+03:00"),
      completedAt: null,
    },
  ],
  slaIncidents: [],
};

describe("weekly report payload", () => {
  it("builds results, execution and management exceptions without inventing network data", () => {
    const payload = buildWeeklyReportPayload(
      source,
      weeklyReportPeriod("2026-08-10"),
      new Date("2026-08-17T10:00:00+03:00"),
    );

    expect(payload.result.find(({ key }) => key === "discovered")).toMatchObject({
      value: 1,
      previousWeekValue: 1,
      changeVsPreviousWeek: 0,
    });
    expect(payload.result.find(({ key }) => key === "dialogues")?.value).toBe(1);
    expect(payload.result.find(({ key }) => key === "activeLaunches")).toMatchObject({
      value: null,
      completeness: "unavailable",
    });
    expect(payload.execution.nextActionCoverage).toEqual({ covered: 1, total: 2, percent: 50 });
    expect(payload.execution.overdueTasks).toBe(1);
    expect(payload.network.activePlacements).toBeNull();
    expect(payload.exceptions.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["overdue-task", "missing-next-action", "stage-stall"]),
    );
    expect(payload.decisions).toHaveLength(3);
    const digestItems = buildWeeklyReportDigestItems(payload);
    expect(digestItems).toHaveLength(7);
    expect(digestItems[0]).toMatchObject({ kind: "decision", affectedCount: 1 });
    expect(digestItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "risk", owner: "Анна" })]),
    );
    expect(
      buildWeeklyReportPublishedEventPayload({
        snapshotId: "snapshot-1",
        teamId: "team-1",
        teamName: "Команда внедрения",
        periodStart: "2026-08-09T21:00:00.000Z",
        periodEnd: "2026-08-16T20:59:59.999Z",
        revision: 1,
        payload,
      }),
    ).toMatchObject({
      snapshotId: "snapshot-1",
      exceptionCount: payload.exceptions.length,
      digestItems,
    });
  });

  it("produces a stable checksum for the same source and cut-off", () => {
    const period = weeklyReportPeriod("2026-08-10");
    const asOf = new Date("2026-08-17T10:00:00+03:00");
    const first = buildWeeklyReportPayload(source, period, asOf);
    const second = buildWeeklyReportPayload(source, period, asOf);

    expect(weeklyReportChecksum(second)).toBe(weeklyReportChecksum(first));
  });

  it("shows an escalated SLA incident as a high-priority leader exception without a duplicate stall", () => {
    const payload = buildWeeklyReportPayload(
      {
        ...source,
        slaIncidents: [
          {
            id: "sla-1",
            opportunityId: "opp-1",
            organizationId: "org-1",
            organizationName: "Медиа",
            ownerName: "Анна",
            stageLabel: "Диалог",
            activityMarkerAt: new Date("2026-08-01T08:00:00+03:00"),
            escalatedAt: new Date("2026-08-15T08:00:00+03:00"),
          },
        ],
      },
      weeklyReportPeriod("2026-08-10"),
      new Date("2026-08-17T10:00:00+03:00"),
    );

    expect(payload.funnel.topStalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sla-escalation",
          opportunityId: "opp-1",
          severity: "high",
        }),
      ]),
    );
    expect(
      payload.funnel.topStalls.filter(({ opportunityId }) => opportunityId === "opp-1"),
    ).toHaveLength(1);
  });
});

import { createHash } from "node:crypto";
import type {
  WeeklyReportException,
  WeeklyReportMetric,
  WeeklyReportMetricKey,
  WeeklyReportPayload,
} from "@embed-os/contracts";
import type { WeeklyReportPeriod } from "@embed-os/domain";

const DAY_MS = 24 * 60 * 60 * 1_000;
const STAGE_ORDER = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "SX"];
const RESULT_DEFINITIONS: Array<{
  key: Exclude<WeeklyReportMetricKey, "discovered" | "activeLaunches">;
  label: string;
  stageCode: string;
}> = [
  { key: "qualified", label: "Квалифицировано", stageCode: "S2" },
  { key: "dialogues", label: "Вступило в диалог", stageCode: "S4" },
  { key: "integrations", label: "Перешло в интеграцию", stageCode: "S7" },
  { key: "pilots", label: "Перешло в пилот", stageCode: "S8" },
];

export interface WeeklyReportOpportunitySource {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerName: string;
  stageCode: string;
  stageLabel: string;
  status: string;
  nextTaskId: string | null;
  createdAt: Date;
  stageEnteredAt: Date;
}

export interface WeeklyReportStageEventSource {
  opportunityId: string;
  toStage: string;
  occurredAt: Date;
}

export interface WeeklyReportTaskSource {
  id: string;
  opportunityId: string;
  organizationId: string;
  organizationName: string;
  ownerName: string;
  title: string;
  status: string;
  dueAt: Date;
  completedAt: Date | null;
}

export interface WeeklyReportSlaIncidentSource {
  id: string;
  opportunityId: string;
  organizationId: string;
  organizationName: string;
  ownerName: string;
  stageLabel: string;
  activityMarkerAt: Date;
  escalatedAt: Date;
}

export interface WeeklyReportSource {
  opportunities: WeeklyReportOpportunitySource[];
  stageEvents: WeeklyReportStageEventSource[];
  tasks: WeeklyReportTaskSource[];
  slaIncidents: WeeklyReportSlaIncidentSource[];
}

export function buildWeeklyReportPayload(
  source: WeeklyReportSource,
  period: WeeklyReportPeriod,
  dataAsOf: Date,
): WeeklyReportPayload {
  const opportunities = [...source.opportunities].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const active = opportunities.filter((opportunity) => opportunity.status !== "CLOSED");
  const result: WeeklyReportMetric[] = [
    metricFromCreatedOpportunities("discovered", "Найдено", opportunities, period),
    ...RESULT_DEFINITIONS.map((definition) =>
      metricFromStageEvents(definition, source.stageEvents, period),
    ),
    {
      key: "activeLaunches",
      label: "Активные запуски",
      value: null,
      previousWeekValue: null,
      fourWeekAverage: null,
      changeVsPreviousWeek: null,
      completeness: "unavailable",
    },
  ];

  const activeByStage = new Map<string, WeeklyReportOpportunitySource[]>();
  for (const opportunity of active) {
    const bucket = activeByStage.get(opportunity.stageCode) ?? [];
    bucket.push(opportunity);
    activeByStage.set(opportunity.stageCode, bucket);
  }
  const stages = [...activeByStage.entries()]
    .sort(([left], [right]) => stageIndex(left) - stageIndex(right) || left.localeCompare(right))
    .map(([code, stageOpportunities]) => ({
      code,
      label: stageOpportunities[0]?.stageLabel ?? code,
      opportunities: stageOpportunities.length,
      medianAgeDays: median(
        stageOpportunities.map((opportunity) => ageInDays(opportunity.stageEnteredAt, dataAsOf)),
      ),
    }));

  const slaEscalations = source.slaIncidents
    .filter((incident) => incident.escalatedAt <= dataAsOf)
    .sort(
      (left, right) =>
        left.activityMarkerAt.getTime() - right.activityMarkerAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .map((incident): WeeklyReportException => ({
      code: "sla-escalation",
      severity: "high",
      organizationId: incident.organizationId,
      organizationName: incident.organizationName,
      opportunityId: incident.opportunityId,
      ownerName: incident.ownerName,
      title: `SLA стадии «${incident.stageLabel}» нарушен и эскалирован`,
      ageDays: ageInDays(incident.activityMarkerAt, dataAsOf),
    }));
  const escalatedOpportunityIds = new Set(
    slaEscalations.map((exception) => exception.opportunityId),
  );
  const stageStalls = active
    .filter((opportunity) => !escalatedOpportunityIds.has(opportunity.id))
    .map((opportunity) => ({
      opportunity,
      ageDays: ageInDays(opportunity.stageEnteredAt, dataAsOf),
    }))
    .filter(({ ageDays }) => ageDays >= 7)
    .sort(
      (left, right) =>
        right.ageDays - left.ageDays || left.opportunity.id.localeCompare(right.opportunity.id),
    )
    .slice(0, 10)
    .map(({ opportunity, ageDays }): WeeklyReportException => ({
      code: "stage-stall",
      severity: ageDays >= 14 ? "high" : "medium",
      organizationId: opportunity.organizationId,
      organizationName: opportunity.organizationName,
      opportunityId: opportunity.id,
      ownerName: opportunity.ownerName,
      title: `Стадия «${opportunity.stageLabel}» без перехода`,
      ageDays,
    }));
  const topStalls = [...slaEscalations, ...stageStalls].sort(compareExceptions).slice(0, 10);

  const overdueTasks = source.tasks
    .filter((task) => task.status === "OPEN" && task.dueAt < dataAsOf)
    .sort(
      (left, right) =>
        left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id),
    );
  const overdueExceptions = overdueTasks.map((task): WeeklyReportException => ({
    code: "overdue-task",
    severity: ageInDays(task.dueAt, dataAsOf) >= 3 ? "high" : "medium",
    organizationId: task.organizationId,
    organizationName: task.organizationName,
    opportunityId: task.opportunityId,
    ownerName: task.ownerName,
    title: task.title,
    ageDays: ageInDays(task.dueAt, dataAsOf),
  }));
  const missingNextAction = active
    .filter((opportunity) => opportunity.nextTaskId === null)
    .map((opportunity): WeeklyReportException => ({
      code: "missing-next-action",
      severity: "high",
      organizationId: opportunity.organizationId,
      organizationName: opportunity.organizationName,
      opportunityId: opportunity.id,
      ownerName: opportunity.ownerName,
      title: "У активной возможности отсутствует следующее действие",
      ageDays: ageInDays(opportunity.stageEnteredAt, dataAsOf),
    }));
  const exceptions = [...overdueExceptions, ...missingNextAction, ...topStalls]
    .sort(compareExceptions)
    .slice(0, 10);
  const covered = active.length - missingNextAction.length;
  const decisionDueAt = new Date(dataAsOf.getTime() + DAY_MS).toISOString();
  const decisions: WeeklyReportPayload["decisions"] = [];
  if (overdueTasks.length > 0) {
    decisions.push({
      code: "resolve-overdue",
      question: "Какие просроченные действия нужно эскалировать или перераспределить?",
      owner: "Руководитель команды",
      dueAt: decisionDueAt,
      affectedCount: overdueTasks.length,
    });
  }
  if (missingNextAction.length > 0) {
    decisions.push({
      code: "assign-next-action",
      question: "Кому назначить следующий шаг по возможностям без действия?",
      owner: "Руководитель команды",
      dueAt: decisionDueAt,
      affectedCount: missingNextAction.length,
    });
  }
  if (topStalls.length > 0) {
    decisions.push({
      code: "review-stalls",
      question: "Какие зависшие возможности продолжаем, ставим на паузу или закрываем?",
      owner: "Руководитель команды",
      dueAt: decisionDueAt,
      affectedCount: topStalls.length,
    });
  }

  return {
    result,
    funnel: {
      activeOpportunities: active.length,
      stages,
      topStalls,
    },
    execution: {
      nextActionCoverage: {
        covered,
        total: active.length,
        percent: active.length === 0 ? null : Math.round((covered / active.length) * 1_000) / 10,
      },
      completedTasks: source.tasks.filter(
        (task) =>
          task.status === "COMPLETED" &&
          task.completedAt !== null &&
          task.completedAt >= period.start &&
          task.completedAt <= period.end,
      ).length,
      overdueTasks: overdueTasks.length,
      rescheduleReasons: [],
      rescheduleDataCompleteness: "unavailable",
    },
    network: {
      activePlacements: null,
      launchedThisWeek: null,
      disabledThisWeek: null,
      technicalDegradations: null,
      recoveries: null,
      completeness: "unavailable",
    },
    exceptions,
    decisions,
    dataQuality: {
      completeness: "partial",
      availableSources: ["Opportunity", "StageHistory", "Task", "OpportunitySlaIncident"],
      unavailableSources: ["Placement", "HealthCheck", "TaskRescheduleHistory"],
      notes: [
        "Запуски не считаются до появления Placement и успешной обязательной проверки.",
        "Отсутствующие технические и продуктовые данные показаны как недоступные, а не как ноль.",
      ],
    },
  };
}

export function weeklyReportChecksum(payload: WeeklyReportPayload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function metricFromCreatedOpportunities(
  key: "discovered",
  label: string,
  opportunities: WeeklyReportOpportunitySource[],
  period: WeeklyReportPeriod,
): WeeklyReportMetric {
  const count = (start: Date, end: Date) =>
    opportunities.filter(({ createdAt }) => createdAt >= start && createdAt <= end).length;
  return metricWithHistory(key, label, count, period);
}

function metricFromStageEvents(
  definition: (typeof RESULT_DEFINITIONS)[number],
  events: WeeklyReportStageEventSource[],
  period: WeeklyReportPeriod,
): WeeklyReportMetric {
  const count = (start: Date, end: Date) =>
    new Set(
      events
        .filter(
          ({ toStage, occurredAt }) =>
            toStage === definition.stageCode && occurredAt >= start && occurredAt <= end,
        )
        .map(({ opportunityId }) => opportunityId),
    ).size;
  return metricWithHistory(definition.key, definition.label, count, period);
}

function metricWithHistory(
  key: Exclude<WeeklyReportMetricKey, "activeLaunches">,
  label: string,
  count: (start: Date, end: Date) => number,
  period: WeeklyReportPeriod,
): WeeklyReportMetric {
  const value = count(period.start, period.end);
  const previousPeriod = shiftPeriod(period, -7);
  const previousWeekValue = count(previousPeriod.start, previousPeriod.end);
  const history = [1, 2, 3, 4].map((week) => {
    const historicalPeriod = shiftPeriod(period, -7 * week);
    return count(historicalPeriod.start, historicalPeriod.end);
  });
  const fourWeekAverage = Math.round((history.reduce((sum, item) => sum + item, 0) / 4) * 10) / 10;
  return {
    key,
    label,
    value,
    previousWeekValue,
    fourWeekAverage,
    changeVsPreviousWeek: value - previousWeekValue,
    completeness: "complete",
  };
}

function shiftPeriod(period: WeeklyReportPeriod, days: number): WeeklyReportPeriod {
  const offset = days * DAY_MS;
  return {
    start: new Date(period.start.getTime() + offset),
    end: new Date(period.end.getTime() + offset),
  };
}

function stageIndex(stageCode: string) {
  const index = STAGE_ORDER.indexOf(stageCode);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function ageInDays(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY_MS));
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] ?? null)
    : Math.round((((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2) * 10) / 10;
}

function compareExceptions(left: WeeklyReportException, right: WeeklyReportException) {
  const severity = { high: 0, medium: 1 } as const;
  return (
    severity[left.severity] - severity[right.severity] ||
    right.ageDays - left.ageDays ||
    left.opportunityId.localeCompare(right.opportunityId) ||
    left.code.localeCompare(right.code)
  );
}

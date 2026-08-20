import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { WeeklyReportSnapshot } from "@embed-os/contracts";
import { parseGenerateWeeklyReportCommand, weeklyReportPeriod } from "@embed-os/domain";
import { IdempotencyConflictError, weeklyReportRequestHash } from "./application/idempotency.js";
import {
  buildWeeklyReportPayload,
  weeklyReportChecksum,
  type WeeklyReportSource,
} from "./application/weekly-report.js";
import type { ReportPort } from "./report.port.js";
import { TodayService } from "./today.service.js";

@Injectable()
export class ReportService implements ReportPort {
  private readonly snapshots: WeeklyReportSnapshot[] = [];
  private readonly exactSnapshots = new Map<string, WeeklyReportSnapshot>();
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: WeeklyReportSnapshot }
  >();

  constructor(@Inject(TodayService) private readonly today: TodayService) {}

  generateWeekly(input: unknown, idempotencyKey: string): WeeklyReportSnapshot {
    const command = parseGenerateWeeklyReportCommand(input);
    const requestHash = weeklyReportRequestHash(command);
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return replay.response;
    }

    const exactKey = `${command.periodStart}:${command.dataAsOf}:${command.formulaVersion}`;
    const exact = this.exactSnapshots.get(exactKey);
    if (exact) {
      this.idempotency.set(idempotencyKey, { requestHash, response: exact });
      return exact;
    }

    const today = this.today.getToday();
    const period = weeklyReportPeriod(command.periodStart);
    const dataAsOf = new Date(command.dataAsOf);
    const payload = buildWeeklyReportPayload(
      memorySource(today.actions, period.start, dataAsOf),
      period,
      dataAsOf,
    );
    const revision =
      this.snapshots.filter((snapshot) => snapshot.periodStart === period.start.toISOString())
        .length + 1;
    const id = randomUUID();
    const snapshot: WeeklyReportSnapshot = {
      id,
      teamId: "team-implementation",
      teamName: today.teamName,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      dataAsOf: command.dataAsOf,
      revision,
      formulaVersion: command.formulaVersion,
      generatedAt: new Date().toISOString(),
      generatedBy: { id: today.currentUser.id, name: today.currentUser.name },
      payloadUri: `memory://report-snapshot/${id}`,
      checksum: weeklyReportChecksum(payload),
      payload,
    };
    this.snapshots.push(snapshot);
    this.exactSnapshots.set(exactKey, snapshot);
    this.idempotency.set(idempotencyKey, { requestHash, response: snapshot });
    return snapshot;
  }

  getLatestWeekly(): WeeklyReportSnapshot {
    const latest = [...this.snapshots].sort(
      (left, right) =>
        right.periodStart.localeCompare(left.periodStart) || right.revision - left.revision,
    )[0];
    if (!latest) throw new NotFoundException("Недельные снимки ещё не опубликованы");
    return latest;
  }
}

function memorySource(
  actions: ReturnType<TodayService["getToday"]>["actions"],
  periodStart: Date,
  dataAsOf: Date,
): WeeklyReportSource {
  const opportunities = actions.map((action, index) => ({
    id: action.opportunityId,
    organizationId: action.organizationId,
    organizationName: action.organizationName,
    ownerName: action.ownerName,
    stageCode: action.stageCode,
    stageLabel: action.stageLabel,
    status: action.group === "waiting" ? "WAITING" : "ACTIVE",
    nextTaskId: action.id,
    createdAt: new Date(periodStart.getTime() - (index % 5) * 7 * 24 * 60 * 60 * 1_000),
    stageEnteredAt: new Date(
      Math.min(dataAsOf.getTime(), new Date(action.dueAt ?? dataAsOf).getTime()) -
        (7 + (index % 9)) * 24 * 60 * 60 * 1_000,
    ),
  }));
  const stageEvents = opportunities.slice(0, 5).map((opportunity, index) => ({
    opportunityId: opportunity.id,
    toStage: opportunity.stageCode,
    occurredAt: new Date(periodStart.getTime() + (index + 1) * 12 * 60 * 60 * 1_000),
  }));
  const tasks = actions.map((action) => ({
    id: action.id,
    opportunityId: action.opportunityId,
    organizationId: action.organizationId,
    organizationName: action.organizationName,
    ownerName: action.ownerName,
    title: action.title,
    status: "OPEN",
    dueAt: new Date(action.dueAt ?? dataAsOf),
    completedAt: null,
  }));
  return { opportunities, stageEvents, tasks, slaIncidents: [] };
}

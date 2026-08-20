import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ReportSnapshot } from "@prisma/client";
import type { WeeklyReportPayload, WeeklyReportSnapshot } from "@embed-os/contracts";
import { parseGenerateWeeklyReportCommand, weeklyReportPeriod } from "@embed-os/domain";
import { IdempotencyInProgressError, weeklyReportRequestHash } from "../application/idempotency.js";
import {
  buildWeeklyReportPayload,
  weeklyReportChecksum,
  type WeeklyReportSource,
} from "../application/weekly-report.js";
import { buildWeeklyReportPublishedEventPayload } from "../reporting/report-digest.js";
import type { ReportPort } from "../report.port.js";
import { completeIdempotency, reserveOrReplay } from "./idempotency-gateway.js";
import { PersistenceActorService, requireActorTeam } from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

type SnapshotRecord = ReportSnapshot & {
  team: { id: string; name: string };
  generatedBy: { id: string; displayName: string };
};

@Injectable()
export class PostgresReportService implements ReportPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async generateWeekly(input: unknown, idempotencyKey: string): Promise<WeeklyReportSnapshot> {
    const command = parseGenerateWeeklyReportCommand(input);
    const requestHash = weeklyReportRequestHash(command);
    const period = weeklyReportPeriod(command.periodStart);
    const dataAsOf = new Date(command.dataAsOf);
    const reservationId = randomUUID();
    const now = new Date();

    return this.prisma.$transaction(
      async (transaction) => {
        // Weekly snapshots are generated both by HTTP requests and by the
        // weekly report worker, which runs without a session.
        const actor = await this.actors.currentOrSystem(transaction);
        const teamId = requireActorTeam(actor);
        const teamName = actor.teamName ?? "Без команды";

        const replay = await reserveOrReplay(transaction, {
          recordId: reservationId,
          actorId: actor.id,
          operation: "report.weekly.generate",
          requestKey: idempotencyKey,
          requestHash,
          now,
        });
        if (replay !== null) {
          const parsed = parseSnapshot(replay);
          if (!parsed) throw new IdempotencyInProgressError(idempotencyKey);
          return parsed;
        }

        await transaction.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`weekly-report:${teamId}:${command.periodStart}`}, 0)
          )
        `);
        const exact = await transaction.reportSnapshot.findFirst({
          where: {
            teamId,
            periodStart: period.start,
            periodEnd: period.end,
            dataAsOf,
            formulaVersion: command.formulaVersion,
          },
          include: { team: true, generatedBy: true },
        });
        if (exact) {
          const response = mapSnapshot(exact);
          await completeIdempotency(transaction, {
            recordId: reservationId,
            responseStatus: 201,
            responseJson: toJson(response),
            completedAt: now,
          });
          return response;
        }

        const previousRevision = await transaction.reportSnapshot.findFirst({
          where: {
            teamId,
            periodStart: period.start,
            periodEnd: period.end,
          },
          orderBy: { revision: "desc" },
          select: { revision: true },
        });
        const revision = (previousRevision?.revision ?? 0) + 1;
        const source = await loadWeeklySource(transaction, teamId, period.start, dataAsOf);
        const payload = buildWeeklyReportPayload(source, period, dataAsOf);
        const checksum = weeklyReportChecksum(payload);
        const snapshotId = randomUUID();
        const payloadUri = `postgres://report-snapshot/${snapshotId}`;
        const created = await transaction.reportSnapshot.create({
          data: {
            id: snapshotId,
            teamId,
            generatedById: actor.id,
            periodStart: period.start,
            periodEnd: period.end,
            dataAsOf,
            revision,
            formulaVersion: command.formulaVersion,
            payloadUri,
            checksum,
            payload: toJson(payload),
            generatedAt: now,
          },
          include: { team: true, generatedBy: true },
        });
        const response = mapSnapshot(created);
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: actor.id,
            action: "report.weekly.publish",
            entityType: "ReportSnapshot",
            entityId: snapshotId,
            afterJson: toJson({
              teamId,
              periodStart: response.periodStart,
              periodEnd: response.periodEnd,
              dataAsOf: response.dataAsOf,
              revision,
              formulaVersion: command.formulaVersion,
              checksum,
            }),
            occurredAt: now,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "report.weekly.published",
            aggregateType: "ReportSnapshot",
            aggregateId: snapshotId,
            aggregateVersion: revision,
            schemaVersion: 1,
            payload: toJson(
              buildWeeklyReportPublishedEventPayload({
                snapshotId,
                teamId,
                teamName,
                periodStart: response.periodStart,
                periodEnd: response.periodEnd,
                revision,
                payload,
              }),
            ),
            occurredAt: now,
          },
        });
        await completeIdempotency(transaction, {
          recordId: reservationId,
          responseStatus: 201,
          responseJson: toJson(response),
          completedAt: now,
        });
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async getLatestWeekly(): Promise<WeeklyReportSnapshot> {
    const actor = await this.actors.current();
    const teamId = requireActorTeam(actor);
    const latest = await this.prisma.reportSnapshot.findFirst({
      where: { teamId },
      orderBy: [{ periodStart: "desc" }, { revision: "desc" }],
      include: { team: true, generatedBy: true },
    });
    if (!latest) throw new NotFoundException("Недельные снимки ещё не опубликованы");
    return mapSnapshot(latest);
  }
}

async function loadWeeklySource(
  transaction: Prisma.TransactionClient,
  teamId: string,
  periodStart: Date,
  dataAsOf: Date,
): Promise<WeeklyReportSource> {
  const historyStart = new Date(periodStart.getTime() - 28 * 24 * 60 * 60 * 1_000);
  const [opportunities, stageEvents, tasks, slaIncidents] = await Promise.all([
    transaction.opportunity.findMany({
      where: {
        archivedAt: null,
        createdAt: { lte: dataAsOf },
        owner: { teamId },
      },
      include: {
        organization: { select: { id: true, name: true } },
        owner: { select: { displayName: true } },
        stageHistory: {
          where: { occurredAt: { lte: dataAsOf } },
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { occurredAt: true },
        },
      },
      orderBy: { id: "asc" },
    }),
    transaction.stageHistory.findMany({
      where: {
        occurredAt: { gte: historyStart, lte: dataAsOf },
        opportunity: { archivedAt: null, owner: { teamId } },
      },
      select: { opportunityId: true, toStage: true, occurredAt: true },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    }),
    transaction.task.findMany({
      where: {
        createdAt: { lte: dataAsOf },
        opportunity: { archivedAt: null, owner: { teamId } },
        OR: [{ status: "OPEN" }, { completedAt: { gte: periodStart, lte: dataAsOf } }],
      },
      include: {
        opportunity: {
          include: {
            organization: { select: { id: true, name: true } },
          },
        },
        owner: { select: { displayName: true } },
      },
      orderBy: { id: "asc" },
    }),
    transaction.opportunitySlaIncident.findMany({
      where: {
        status: "open",
        escalatedAt: { not: null, lte: dataAsOf },
        opportunity: { archivedAt: null, owner: { teamId } },
      },
      include: {
        opportunity: {
          include: {
            organization: { select: { id: true, name: true } },
            owner: { select: { displayName: true } },
          },
        },
      },
      orderBy: [{ activityMarkerAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    opportunities: opportunities.map((opportunity) => ({
      id: opportunity.id,
      organizationId: opportunity.organization.id,
      organizationName: opportunity.organization.name,
      ownerName: opportunity.owner.displayName,
      stageCode: opportunity.stageCode,
      stageLabel: opportunity.stageLabel,
      status: opportunity.status,
      nextTaskId: opportunity.nextTaskId,
      createdAt: opportunity.createdAt,
      stageEnteredAt: opportunity.stageHistory[0]?.occurredAt ?? opportunity.createdAt,
    })),
    stageEvents,
    tasks: tasks.map((task) => ({
      id: task.id,
      opportunityId: task.opportunityId,
      organizationId: task.opportunity.organization.id,
      organizationName: task.opportunity.organization.name,
      ownerName: task.owner.displayName,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
    })),
    slaIncidents: slaIncidents.map((incident) => ({
      id: incident.id,
      opportunityId: incident.opportunityId,
      organizationId: incident.opportunity.organization.id,
      organizationName: incident.opportunity.organization.name,
      ownerName: incident.opportunity.owner.displayName,
      stageLabel: incident.opportunity.stageLabel,
      activityMarkerAt: incident.activityMarkerAt,
      escalatedAt: incident.escalatedAt!,
    })),
  };
}

function mapSnapshot(record: SnapshotRecord): WeeklyReportSnapshot {
  return {
    id: record.id,
    teamId: record.teamId,
    teamName: record.team.name,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    dataAsOf: record.dataAsOf.toISOString(),
    revision: record.revision,
    formulaVersion: record.formulaVersion,
    generatedAt: record.generatedAt.toISOString(),
    generatedBy: {
      id: record.generatedBy.id,
      name: record.generatedBy.displayName,
    },
    payloadUri: record.payloadUri,
    checksum: record.checksum,
    payload: record.payload as unknown as WeeklyReportPayload,
  };
}

function parseSnapshot(value: unknown): WeeklyReportSnapshot | null {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { checksum?: unknown }).checksum !== "string" ||
    typeof (value as { revision?: unknown }).revision !== "number" ||
    typeof (value as { payload?: unknown }).payload !== "object"
  ) {
    return null;
  }
  return value as WeeklyReportSnapshot;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

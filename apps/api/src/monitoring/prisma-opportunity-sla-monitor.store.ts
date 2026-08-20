import { randomUUID } from "node:crypto";
import {
  OpportunityStatus,
  Prisma,
  TaskStatus,
  type PrismaClient,
} from "@prisma/client";
import type {
  OpportunitySlaCandidate,
  OpportunitySlaMonitorStore,
} from "./opportunity-sla-monitor.service.js";

export const AUTOMATION_USER_ID = "00000000-0000-4000-8000-000000000004";
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_THRESHOLDS: Record<string, number> = {
  S0: 2,
  S1: 2,
  S2: 3,
  S3: 3,
  S4: 5,
  S5: 5,
  S6: 5,
  S7: 7,
  S8: 7,
  S9: 14,
  S10: 14,
};

export class PrismaOpportunitySlaMonitorStore implements OpportunitySlaMonitorStore {
  private candidateCursor: string | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  async listCandidates(input: { now: Date; batchSize: number }): Promise<OpportunitySlaCandidate[]> {
    let opportunities = await this.loadCandidateRows(this.candidateCursor, input.batchSize);
    if (opportunities.length === 0 && this.candidateCursor !== null) {
      this.candidateCursor = null;
      opportunities = await this.loadCandidateRows(null, input.batchSize);
    }
    this.candidateCursor = opportunities.at(-1)?.id ?? null;

    return opportunities.flatMap((opportunity): OpportunitySlaCandidate[] => {
      const config = slaConfig(opportunity.processDefinition.schemaJson, opportunity.stageCode);
      if (!config && opportunity.slaIncidents.length === 0) return [];
      const incident = opportunity.slaIncidents[0] ?? null;
      return [{
        id: opportunity.id,
        organizationId: opportunity.organization.id,
        organizationName: opportunity.organization.name,
        ownerId: opportunity.owner.id,
        ownerName: opportunity.owner.displayName,
        ownerEmail: opportunity.owner.email,
        teamId: opportunity.owner.teamId,
        teamName: opportunity.owner.team?.name ?? null,
        stageCode: opportunity.stageCode,
        stageLabel: opportunity.stageLabel,
        status: opportunity.status,
        createdAt: opportunity.createdAt,
        lastInteractionAt: opportunity.interactions[0]?.occurredAt ?? null,
        lastStageChangeAt: opportunity.stageHistory[0]?.occurredAt ?? null,
        thresholdDays: incident?.thresholdDays ?? config?.thresholdDays ?? 30,
        escalationAfterDays: incident?.escalationAfterDays ?? config?.escalationAfterDays ?? 3,
        activeIncident: incident ? {
          id: incident.id,
          activityMarkerAt: incident.activityMarkerAt,
          ownerNotifiedAt: incident.ownerNotifiedAt,
          escalatedAt: incident.escalatedAt,
        } : null,
      }];
    });
  }

  private loadCandidateRows(afterId: string | null, batchSize: number) {
    return this.prisma.opportunity.findMany({
      where: {
        id: afterId === null ? undefined : { gt: afterId },
        archivedAt: null,
        OR: [
          { status: { not: OpportunityStatus.CLOSED } },
          { slaIncidents: { some: { status: "open" } } },
        ],
      },
      include: {
        organization: { select: { id: true, name: true } },
        owner: {
          select: {
            id: true,
            displayName: true,
            email: true,
            teamId: true,
            team: { select: { name: true } },
          },
        },
        processDefinition: { select: { schemaJson: true } },
        interactions: {
          select: { occurredAt: true },
          orderBy: { occurredAt: "desc" },
          take: 1,
        },
        stageHistory: {
          select: { occurredAt: true },
          orderBy: { occurredAt: "desc" },
          take: 1,
        },
        slaIncidents: {
          where: { status: "open" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
  }

  async openIncident(input: Parameters<OpportunitySlaMonitorStore["openIncident"]>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const current = await currentOpportunity(transaction, input.candidate.id);
        if (!current || current.status !== OpportunityStatus.ACTIVE) return false;
        const marker = activityMarker(current.createdAt, current.interactions, current.stageHistory);
        if (marker.getTime() !== input.evaluation.activityMarkerAt.getTime()) return false;
        if (input.occurredAt < input.evaluation.thresholdReachedAt) return false;
        if (current.slaIncidents.length > 0) return false;

        const incidentId = randomUUID();
        const taskId = randomUUID();
        await transaction.opportunitySlaIncident.create({
          data: {
            id: incidentId,
            opportunityId: current.id,
            stageCode: current.stageCode,
            activityMarkerAt: marker,
            thresholdDays: input.candidate.thresholdDays,
            escalationAfterDays: input.candidate.escalationAfterDays,
            status: "open",
            ownerNotifiedAt: input.occurredAt,
          },
        });
        await transaction.task.create({
          data: {
            id: taskId,
            opportunityId: current.id,
            ownerId: current.ownerId,
            type: "sla_reaction",
            title: `Разобрать зависание: ${current.stageLabel}`,
            dueAt: input.occurredAt,
            priorityScore: 95,
            priorityReasons: [{ code: "inactivity", label: `Нет активности ${input.candidate.thresholdDays} дн.` }],
            status: TaskStatus.OPEN,
            source: "sla-monitor",
          },
        });
        await transaction.opportunitySlaIncident.update({
          where: { id: incidentId },
          data: { taskId },
        });
        await transaction.auditLog.create({
          data: {
            id: randomUUID(),
            actorId: AUTOMATION_USER_ID,
            action: "opportunity.sla.opened",
            entityType: "OpportunitySlaIncident",
            entityId: incidentId,
            beforeJson: Prisma.JsonNull,
            afterJson: {
              opportunityId: current.id,
              taskId,
              stageCode: current.stageCode,
              activityMarkerAt: marker.toISOString(),
              thresholdDays: input.candidate.thresholdDays,
            },
            occurredAt: input.occurredAt,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            id: randomUUID(),
            eventType: "opportunity.stale",
            aggregateType: "OpportunitySlaIncident",
            aggregateId: incidentId,
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: notificationPayload(input.candidate, incidentId, taskId, input),
            occurredAt: input.occurredAt,
          },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false;
      }
      throw error;
    }
  }

  async escalateIncident(input: Parameters<OpportunitySlaMonitorStore["escalateIncident"]>[0]) {
    return this.prisma.$transaction(async (transaction) => {
      const incident = await transaction.opportunitySlaIncident.findUnique({
        where: { id: input.incidentId },
        include: {
          opportunity: {
            include: {
              interactions: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
              stageHistory: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
            },
          },
        },
      });
      if (!incident || incident.status !== "open" || incident.escalatedAt) return false;
      const opportunity = incident.opportunity;
      const marker = activityMarker(opportunity.createdAt, opportunity.interactions, opportunity.stageHistory);
      const escalationDueAt = new Date(
        incident.ownerNotifiedAt.getTime() + incident.escalationAfterDays * DAY_MS,
      );
      if (
        opportunity.status !== OpportunityStatus.ACTIVE ||
        marker.getTime() !== incident.activityMarkerAt.getTime() ||
        input.occurredAt < escalationDueAt
      ) return false;

      const updated = await transaction.opportunitySlaIncident.updateMany({
        where: { id: incident.id, status: "open", escalatedAt: null },
        data: { escalatedAt: input.occurredAt },
      });
      if (updated.count !== 1) return false;
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: AUTOMATION_USER_ID,
          action: "opportunity.sla.escalated",
          entityType: "OpportunitySlaIncident",
          entityId: incident.id,
          beforeJson: { escalatedAt: null },
          afterJson: {
            escalatedAt: input.occurredAt.toISOString(),
            violationAgeDays: input.evaluation.violationAgeDays,
          },
          occurredAt: input.occurredAt,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          id: randomUUID(),
          eventType: "opportunity.sla_escalated",
          aggregateType: "OpportunitySlaIncident",
          aggregateId: incident.id,
          aggregateVersion: 2,
          schemaVersion: 1,
          payload: notificationPayload(
            input.candidate,
            incident.id,
            incident.taskId,
            input,
          ),
          occurredAt: input.occurredAt,
        },
      });
      return true;
    });
  }

  async resolveIncident(input: Parameters<OpportunitySlaMonitorStore["resolveIncident"]>[0]) {
    return this.prisma.$transaction(async (transaction) => {
      const incident = await transaction.opportunitySlaIncident.findUnique({
        where: { id: input.incidentId },
        select: { id: true, status: true, taskId: true, escalatedAt: true },
      });
      if (!incident || incident.status !== "open") return false;
      const updated = await transaction.opportunitySlaIncident.updateMany({
        where: { id: incident.id, status: "open" },
        data: { status: "resolved", resolvedAt: input.occurredAt },
      });
      if (updated.count !== 1) return false;
      if (incident.taskId) {
        await transaction.task.updateMany({
          where: { id: incident.taskId, status: TaskStatus.OPEN },
          data: {
            status: TaskStatus.CANCELLED,
            outcome: "SLA-инцидент закрыт после изменения состояния",
            version: { increment: 1 },
          },
        });
      }
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: AUTOMATION_USER_ID,
          action: "opportunity.sla.resolved",
          entityType: "OpportunitySlaIncident",
          entityId: incident.id,
          beforeJson: { status: "open", escalatedAt: incident.escalatedAt?.toISOString() ?? null },
          afterJson: { status: "resolved", resolvedAt: input.occurredAt.toISOString() },
          occurredAt: input.occurredAt,
        },
      });
      return true;
    });
  }
}

async function currentOpportunity(
  transaction: Prisma.TransactionClient,
  opportunityId: string,
) {
  return transaction.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      interactions: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
      stageHistory: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
      slaIncidents: { where: { status: "open" }, select: { id: true }, take: 1 },
    },
  });
}

function activityMarker(
  createdAt: Date,
  interactions: Array<{ occurredAt: Date }>,
  stageHistory: Array<{ occurredAt: Date }>,
) {
  const values = [createdAt, interactions[0]?.occurredAt, stageHistory[0]?.occurredAt]
    .filter((value): value is Date => value instanceof Date);
  return values.reduce((latest, value) => value > latest ? value : latest, createdAt);
}

function slaConfig(value: Prisma.JsonValue, stageCode: string) {
  const fallback = DEFAULT_THRESHOLDS[stageCode];
  if (!isRecord(value) || !isRecord(value.sla)) {
    return fallback ? { thresholdDays: fallback, escalationAfterDays: 3 } : null;
  }
  const sla = value.sla;
  const configuredThreshold = isRecord(sla.thresholds) ? sla.thresholds[stageCode] : undefined;
  const thresholdDays = validDays(configuredThreshold) ?? fallback;
  if (!thresholdDays) return null;
  return {
    thresholdDays,
    escalationAfterDays: validDays(sla.escalationAfterDays) ?? 3,
  };
}

function notificationPayload(
  candidate: OpportunitySlaCandidate,
  incidentId: string,
  taskId: string | null,
  input: { evaluation: { violationAgeDays: number }; occurredAt: Date },
): Prisma.InputJsonObject {
  return {
    incidentId,
    opportunityId: candidate.id,
    organizationId: candidate.organizationId,
    organizationName: candidate.organizationName,
    ownerId: candidate.ownerId,
    ownerName: candidate.ownerName,
    ownerEmail: candidate.ownerEmail,
    teamId: candidate.teamId,
    teamName: candidate.teamName,
    stageCode: candidate.stageCode,
    stageLabel: candidate.stageLabel,
    thresholdDays: candidate.thresholdDays,
    violationAgeDays: input.evaluation.violationAgeDays,
    taskId,
    detectedAt: input.occurredAt.toISOString(),
    opportunityPath: `/?opportunity=${encodeURIComponent(candidate.id)}`,
  };
}

function validDays(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 365
    ? value as number
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

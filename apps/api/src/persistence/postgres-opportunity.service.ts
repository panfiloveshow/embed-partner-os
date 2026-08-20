import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { OpportunityStatus, Prisma, TaskStatus } from "@prisma/client";
import type {
  FunnelOpportunity,
  FunnelPayload,
  OpportunityStageCode,
  OpportunityRiskFlag,
  OpportunityStageTransitionResult,
  TransitionOpportunityStageCommand,
} from "@embed-os/contracts";
import {
  assertOpportunityStageReady,
  assertOpportunityTransitionAllowed,
  DomainRuleError,
  opportunityStageLabel,
  parseOpportunityStageData,
  parseTransitionOpportunityStageCommand,
} from "@embed-os/domain";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  opportunityStageRequestHash,
} from "../application/idempotency.js";
import type { OpportunityPort } from "../opportunity.port.js";
import {
  OpportunityNotFoundError,
  OpportunityVersionConflictError,
} from "../opportunity.service.js";
import {
  opportunityScope,
  PersistenceActorService,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

@Injectable()
export class PostgresOpportunityService implements OpportunityPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async list(): Promise<FunnelPayload> {
    const now = new Date();
    const actor = await this.actors.current();
    const where: Prisma.OpportunityWhereInput = {
      archivedAt: null,
      ...opportunityScope(actor),
    };
    const [records, total, grouped] = await Promise.all([
      this.prisma.opportunity.findMany({
        where,
        orderBy: [{ stageCode: "asc" }, { score: "desc" }, { id: "asc" }],
        take: FUNNEL_PAGE_LIMIT + 1,
        include: {
          organization: {
            select: {
              name: true,
              domains: {
                where: { archivedAt: null },
                orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                select: { hostNormalized: true },
                take: 1,
              },
            },
          },
          owner: { select: { id: true, displayName: true } },
          nextTask: { select: { id: true, title: true, dueAt: true, status: true } },
          interactions: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            select: { occurredAt: true },
            take: 1,
          },
          stageHistory: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            select: { occurredAt: true },
            take: 1,
          },
        },
      }),
      this.prisma.opportunity.count({ where }),
      this.prisma.opportunity.groupBy({
        by: ["stageCode"],
        where,
        _count: { _all: true },
      }),
    ]);
    const opportunities: FunnelOpportunity[] = records
      .slice(0, FUNNEL_PAGE_LIMIT)
      .map((opportunity) => {
        const stageCode = knownStage(opportunity.stageCode);
        const nextTask = opportunity.nextTask?.status === TaskStatus.OPEN
          ? opportunity.nextTask
          : null;
        return {
          id: opportunity.id,
          version: opportunity.version,
          processVersion: opportunity.processVersion,
          organizationId: opportunity.organizationId,
          organizationName: opportunity.organization.name,
          domain: opportunity.organization.domains[0]?.hostNormalized ?? "—",
          type: opportunity.type,
          stageCode,
          stageLabel: opportunity.stageLabel || opportunityStageLabel(stageCode),
          status: opportunity.status,
          partnerScore: opportunity.score,
          owner: { id: opportunity.owner.id, name: opportunity.owner.displayName },
          nextAction: nextTask
            ? { id: nextTask.id, title: nextTask.title, dueAt: nextTask.dueAt.toISOString() }
            : null,
          lastInteractionAt: opportunity.interactions[0]?.occurredAt.toISOString() ?? null,
          stageAgeDays: elapsedDays(
            opportunity.stageHistory[0]?.occurredAt ?? opportunity.createdAt,
            now,
          ),
          riskFlags: postgresRiskFlags(opportunity, nextTask, now),
        };
      });

    return {
      generatedAt: now.toISOString(),
      teamName: actor.scopeMode === "all"
        ? "Все команды"
        : actor.scopeMode === "team"
          ? actor.teamName ?? "Моя команда"
          : actor.displayName,
      total,
      truncated: records.length > FUNNEL_PAGE_LIMIT,
      processVersions: [...new Set(opportunities.map(({ processVersion }) => processVersion))]
        .sort((left, right) => left - right),
      stageCounts: grouped
        .map(({ stageCode, _count }) => {
          const code = knownStage(stageCode);
          return { code, label: opportunityStageLabel(code), count: _count._all };
        })
        .sort((left, right) => left.code.localeCompare(right.code)),
      opportunities,
    };
  }

  async transition(
    opportunityId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<OpportunityStageTransitionResult> {
    const command = parseTransitionOpportunityStageCommand(input);
    const requestHash = opportunityStageRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const replay = await reserveIdempotency(transaction, {
        reservationId,
        actorId: actor.id,
        operation: `opportunity.stage-transition:${opportunityId}`,
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parseTransitionReplay(replay, idempotencyKey);
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`opportunity:${opportunityId}`}, 0))
      `);
      const current = await transaction.opportunity.findFirst({
        where: { id: opportunityId, archivedAt: null, ...opportunityScope(actor) },
        include: {
          processDefinition: true,
          organization: {
            select: {
              segment: true,
              domains: {
                where: { archivedAt: null },
                orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                select: { hostNormalized: true },
                take: 1,
              },
              contactLinks: {
                where: {
                  validTo: null,
                  contact: { archivedAt: null, mergedIntoId: null },
                },
                select: { id: true },
                take: 1,
              },
            },
          },
          interactions: {
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            select: { occurredAt: true, type: true, outcome: true, contactId: true },
            take: 1,
          },
          placements: {
            where: {
              archivedAt: null,
              businessStatus: "active",
            },
            select: {
              id: true,
              ownerId: true,
              healthStatus: true,
              launchedAt: true,
              lastCheckAt: true,
            },
          },
          stageHistory: {
            where: { toStage: "SX" },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 1,
          },
        },
      });
      if (!current) throw new OpportunityNotFoundError(opportunityId);
      if (current.version !== command.version) {
        throw new OpportunityVersionConflictError(current.version);
      }
      const fromStageCode = knownStage(current.stageCode);
      const publishedStages = processStages(current.processDefinition.schemaJson);
      if (
        current.processDefinition.status !== "PUBLISHED" ||
        !publishedStages.has(fromStageCode) ||
        !publishedStages.has(command.toStageCode)
      ) {
        throw new DomainRuleError("BR-017", "Переход отсутствует в опубликованной версии воронки", {
          toStageCode: `Проверьте ProcessDefinition v${current.processVersion}`,
        });
      }
      const resumeStageCode = current.stageCode === "SX"
        ? knownStageOrNull(current.stageHistory[0]?.fromStage)
        : null;
      assertOpportunityTransitionAllowed(fromStageCode, command.toStageCode, resumeStageCode);
      assertLifecycleDates(command, now);
      const stageData = {
        ...parseOpportunityStageData(current.stageData),
        ...(command.stageData ?? {}),
      };
      const latestInteraction = current.interactions[0] ?? null;
      assertOpportunityStageReady(command.toStageCode, stageData, {
        primaryDomain: current.organization.domains[0]?.hostNormalized ?? null,
        topic: current.organization.segment,
        score: current.score,
        ownerId: current.ownerId,
        hasNextAction: current.nextTaskId !== null,
        hasContactOrChannel:
          current.organization.contactLinks.length > 0 || latestInteraction !== null,
        latestInteraction: latestInteraction
          ? {
              occurredAt: latestInteraction.occurredAt.toISOString(),
              type: latestInteraction.type,
              outcome: latestInteraction.outcome,
            }
          : null,
        hasActivePlacement: current.placements.length > 0,
        hasLaunchedPlacement: current.placements.some(({ launchedAt }) => launchedAt !== null),
        hasHealthyMonitoredPlacement: current.placements.some((placement) =>
          placement.healthStatus === "healthy" &&
          placement.launchedAt !== null &&
          placement.lastCheckAt !== null,
        ),
        hasPlacementOwner: current.placements.some(({ ownerId }) => ownerId.length > 0),
      });

      if (command.toStageCode === "SX" && current.nextTaskId && command.reviewAt) {
        await transaction.task.updateMany({
          where: { id: current.nextTaskId, status: TaskStatus.OPEN },
          data: {
            type: "review",
            title: truncate(`Вернуться к паузе: ${command.pauseReason ?? command.reason}`, 200),
            dueAt: new Date(command.reviewAt),
            version: { increment: 1 },
          },
        });
      }
      if (command.toStageCode === "SL") {
        await transaction.task.updateMany({
          where: { opportunityId, status: TaskStatus.OPEN },
          data: {
            status: TaskStatus.CANCELLED,
            outcome: `Возможность закрыта: ${command.closeReason ?? command.reason}`,
            completedAt: now,
            version: { increment: 1 },
          },
        });
      }

      const nextStatus = statusFor(command.toStageCode);
      const updated = await transaction.opportunity.updateMany({
        where: { id: opportunityId, version: current.version, archivedAt: null },
        data: {
          stageCode: command.toStageCode,
          stageLabel: opportunityStageLabel(command.toStageCode),
          stageData: toJson(stageData),
          status: nextStatus,
          nextTaskId: command.toStageCode === "SL" ? null : current.nextTaskId,
          waitingReason: command.toStageCode === "SX" ? command.pauseReason : null,
          waitingFor: command.toStageCode === "SX" ? "Владелец возможности" : null,
          reviewAt: command.reviewAt ? new Date(command.reviewAt) : null,
          closeReason: command.toStageCode === "SL" ? command.closeReason : null,
          closeComment: command.toStageCode === "SL" ? command.closeComment : null,
          returnAt: command.returnAt ? new Date(command.returnAt) : null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new OpportunityVersionConflictError(current.version + 1);

      const response: OpportunityStageTransitionResult = {
        opportunityId,
        processVersion: current.processVersion,
        fromStageCode,
        toStageCode: command.toStageCode,
        stageLabel: opportunityStageLabel(command.toStageCode),
        status: nextStatus,
        stageData,
        version: current.version + 1,
        occurredAt: now.toISOString(),
      };
      await transaction.stageHistory.create({
        data: {
          id: randomUUID(),
          opportunityId,
          actorId: actor.id,
          fromStage: fromStageCode,
          toStage: command.toStageCode,
          reason: command.reason,
          occurredAt: now,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "opportunity.stage-transition",
          entityType: "Opportunity",
          entityId: opportunityId,
          beforeJson: toJson({
            stageCode: fromStageCode,
            stageLabel: current.stageLabel,
            status: current.status,
            stageData: current.stageData,
            version: current.version,
          }),
          afterJson: toJson({
            stageCode: response.toStageCode,
            stageLabel: response.stageLabel,
            status: response.status,
            version: response.version,
            reason: command.reason,
            pauseReason: command.pauseReason ?? null,
            reviewAt: command.reviewAt ?? null,
            closeReason: command.closeReason ?? null,
            closeComment: command.closeComment ?? null,
            returnAt: command.returnAt ?? null,
            neverReturn: command.neverReturn ?? false,
            stageData,
          }),
          occurredAt: now,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          id: randomUUID(),
          eventType: "opportunity.stage_changed",
          aggregateType: "Opportunity",
          aggregateId: opportunityId,
          aggregateVersion: response.version,
          schemaVersion: 1,
          payload: toJson({
            opportunityId,
            processVersion: current.processVersion,
            fromStageCode,
            toStageCode: command.toStageCode,
            actorId: actor.id,
            reason: command.reason,
            stageData,
          }),
          occurredAt: now,
        },
      });
      await completeIdempotency(transaction, reservationId, response, now);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

const FUNNEL_PAGE_LIMIT = 200;

function elapsedDays(startedAt: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000));
}

function postgresRiskFlags(
  opportunity: {
    status: OpportunityStatus;
    technicalRisk: boolean;
  },
  nextTask: { dueAt: Date } | null,
  now: Date,
): OpportunityRiskFlag[] {
  const flags: OpportunityRiskFlag[] = [];
  if (nextTask && nextTask.dueAt < now && opportunity.status === OpportunityStatus.ACTIVE) {
    flags.push("overdue");
  }
  if (!nextTask && opportunity.status === OpportunityStatus.ACTIVE) {
    flags.push("missing-next-action");
  }
  if (
    opportunity.status === OpportunityStatus.WAITING ||
    opportunity.status === OpportunityStatus.PAUSED
  ) {
    flags.push("waiting");
  }
  if (opportunity.technicalRisk) flags.push("technical-risk");
  return flags;
}

function assertLifecycleDates(command: TransitionOpportunityStageCommand, now: Date) {
  if (command.reviewAt && new Date(command.reviewAt) <= now) {
    throw new DomainRuleError("BR-003", "Переход стадии заблокирован", {
      reviewAt: "Дата пересмотра должна быть в будущем",
    });
  }
  if (command.returnAt && new Date(command.returnAt) <= now) {
    throw new DomainRuleError("BR-006", "Закрытие возможности заблокировано", {
      returnAt: "Дата возможного возврата должна быть в будущем",
    });
  }
}

function knownStage(value: string): OpportunityStageCode {
  const stage = knownStageOrNull(value);
  if (!stage) {
    throw new DomainRuleError("BR-017", "Текущая стадия отсутствует в поддерживаемой схеме", {
      stageCode: value,
    });
  }
  return stage;
}

function knownStageOrNull(value: string | undefined): OpportunityStageCode | null {
  return value && /^(?:S(?:[0-9]|10|X|L))$/.test(value)
    ? value as OpportunityStageCode
    : null;
}

function processStages(value: Prisma.JsonValue) {
  if (!isRecord(value) || !Array.isArray(value.stages)) return new Set<OpportunityStageCode>();
  return new Set(value.stages.flatMap((stage) => {
    if (typeof stage === "string") {
      const known = knownStageOrNull(stage);
      return known ? [known] : [];
    }
    if (isRecord(stage) && typeof stage.code === "string") {
      const known = knownStageOrNull(stage.code);
      return known ? [known] : [];
    }
    return [];
  }));
}

function statusFor(stage: OpportunityStageCode): OpportunityStatus {
  if (stage === "SX") return OpportunityStatus.PAUSED;
  if (stage === "SL") return OpportunityStatus.CLOSED;
  return OpportunityStatus.ACTIVE;
}

async function reserveIdempotency(
  transaction: Prisma.TransactionClient,
  input: {
    reservationId: string;
    actorId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  },
): Promise<Prisma.JsonValue | null> {
  const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "idempotency_record" (
      "id", "actor_id", "operation", "request_key", "request_hash", "created_at", "expires_at"
    ) VALUES (
      ${input.reservationId}::uuid,
      ${input.actorId}::uuid,
      ${input.operation},
      ${input.idempotencyKey},
      ${input.requestHash},
      ${input.now},
      ${new Date(input.now.getTime() + 24 * 60 * 60 * 1_000)}
    )
    ON CONFLICT ("actor_id", "operation", "request_key") DO NOTHING
    RETURNING "id"
  `);
  if (inserted.length > 0) return null;
  const existing = await transaction.idempotencyRecord.findUnique({
    where: {
      actorId_operation_requestKey: {
        actorId: input.actorId,
        operation: input.operation,
        requestKey: input.idempotencyKey,
      },
    },
  });
  if (!existing) throw new IdempotencyInProgressError(input.idempotencyKey);
  if (existing.requestHash !== input.requestHash) throw new IdempotencyConflictError(input.idempotencyKey);
  if (existing.responseJson === null) throw new IdempotencyInProgressError(input.idempotencyKey);
  return existing.responseJson;
}

async function completeIdempotency(
  transaction: Prisma.TransactionClient,
  reservationId: string,
  response: OpportunityStageTransitionResult,
  now: Date,
) {
  await transaction.idempotencyRecord.update({
    where: { id: reservationId },
    data: {
      responseStatus: 200,
      responseJson: toJson(response),
      completedAt: now,
    },
  });
}

function parseTransitionReplay(value: Prisma.JsonValue, key: string) {
  if (
    !isRecord(value) ||
    typeof value.opportunityId !== "string" ||
    typeof value.toStageCode !== "string" ||
    typeof value.version !== "number"
  ) {
    throw new IdempotencyInProgressError(key);
  }
  return value as unknown as OpportunityStageTransitionResult;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  Prisma,
  TaskStatus,
  type Alert,
  type HealthCheck,
} from "@prisma/client";
import type {
  ArchivePlacementCommand,
  HealthCheckView,
  PlacementAlertView,
  PlacementCheckResult,
  PlacementView,
  UpdatePlacementCommand,
} from "@embed-os/contracts";
import {
  applyPlacementHealthCheck,
  DomainRuleError,
  parseArchivePlacementCommand,
  parseRegisterPlacementCommand,
  parseUpdatePlacementCommand,
} from "@embed-os/domain";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  placementArchiveRequestHash,
  placementCheckRequestHash,
  placementRequestHash,
  placementUpdateRequestHash,
} from "../application/idempotency.js";
import type { L0CheckObservation } from "../monitoring/l0-embed-checker.js";
import { L0_CHECKER, type L0Checker } from "../monitoring/l0-checker.port.js";
import type { PlacementPort } from "../placement.port.js";
import {
  PlacementContextNotFoundError,
  PlacementNotFoundError,
  PlacementVersionConflictError,
} from "../placement.service.js";
import {
  opportunityScope,
  placementScope,
  PersistenceActorService,
} from "./persistence-actor.service.js";
import { PrismaService } from "./prisma.service.js";

@Injectable()
export class PostgresPlacementService implements PlacementPort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(L0_CHECKER) private readonly checker: L0Checker,
    @Inject(PersistenceActorService) private readonly actors: PersistenceActorService,
  ) {}

  async list(): Promise<PlacementView[]> {
    const actor = await this.actors.current();
    const placements = await this.prisma.placement.findMany({
      where: { archivedAt: null, ...placementScope(actor) },
      include: placementRelations,
      orderBy: [{ organization: { name: "asc" } }, { id: "asc" }],
    });
    return placements.map(mapPlacement);
  }

  async register(input: unknown, idempotencyKey: string): Promise<PlacementView> {
    const command = parseRegisterPlacementCommand(input);
    const requestHash = placementRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const replay = await reserveIdempotency(transaction, {
        reservationId,
        actorId: actor.id,
        operation: "placement.register",
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parsePlacementReplay(replay, idempotencyKey);

      const opportunity = await transaction.opportunity.findFirst({
        where: {
          id: command.opportunityId,
          organizationId: command.organizationId,
          archivedAt: null,
          ...opportunityScope(actor),
        },
        include: {
          organization: { select: { name: true } },
          owner: { select: { id: true, displayName: true } },
        },
      });
      if (!opportunity) throw new PlacementContextNotFoundError();
      const duplicate = await transaction.placement.findFirst({
        where: {
          opportunityId: opportunity.id,
          pageUrl: command.pageUrl,
          environment: command.environment,
          archivedAt: null,
        },
        include: placementRelations,
      });
      if (duplicate) {
        throw new DomainRuleError(
          "EMB-001",
          "Такое размещение уже зарегистрировано",
          { pageUrl: "URL уже существует для этой возможности и среды" },
        );
      }
      const placementId = randomUUID();
      const created = await transaction.placement.create({
        data: {
          id: placementId,
          organizationId: opportunity.organizationId,
          opportunityId: opportunity.id,
          ownerId: opportunity.owner.id,
          pageUrl: command.pageUrl,
          urlPattern: command.urlPattern,
          embedType: command.embedType,
          environment: command.environment,
          businessStatus: command.businessStatus,
          healthStatus: "unchecked",
          launchedAt: command.launchedAt ? new Date(command.launchedAt) : null,
          nextCheckAt: command.businessStatus === "active" ? now : null,
        },
        include: placementRelations,
      });
      const response = mapPlacement(created);
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "placement.register",
          entityType: "Placement",
          entityId: placementId,
          afterJson: toJson(response),
          occurredAt: now,
        },
      });
      await transaction.outboxEvent.create({
        data: {
          id: randomUUID(),
          eventType: "placement.registered",
          aggregateType: "Placement",
          aggregateId: placementId,
          aggregateVersion: 1,
          schemaVersion: 1,
          payload: toJson({
            placementId,
            opportunityId: opportunity.id,
            organizationId: opportunity.organizationId,
            businessStatus: command.businessStatus,
          }),
          occurredAt: now,
        },
      });
      await completeIdempotency(transaction, reservationId, response, now);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async update(
    placementId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<PlacementView> {
    const command = parseUpdatePlacementCommand(input);
    const requestHash = placementUpdateRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const replay = await reserveIdempotency(transaction, {
        reservationId,
        actorId: actor.id,
        operation: `placement.update:${placementId}`,
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parsePlacementReplay(replay, idempotencyKey);
      await lockPlacement(transaction, placementId);
      const current = await transaction.placement.findFirst({
        where: { id: placementId, archivedAt: null, ...placementScope(actor) },
        include: placementRelations,
      });
      if (!current) throw new PlacementNotFoundError(placementId);
      if (current.version !== command.version) {
        throw new PlacementVersionConflictError(current.version);
      }
      const next = resolvePlacementUpdate(current, command, now);
      if (next.pageUrl !== current.pageUrl || next.environment !== current.environment) {
        const duplicate = await transaction.placement.findFirst({
          where: {
            id: { not: placementId },
            opportunityId: current.opportunityId,
            pageUrl: next.pageUrl,
            environment: next.environment,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new DomainRuleError(
            "EMB-001",
            "Такое размещение уже зарегистрировано",
            { pageUrl: "URL уже существует для этой возможности и среды" },
          );
        }
      }
      if (next.businessStatus === "ended") {
        await closePlacementAlert(transaction, current.alerts[0] ?? null, now);
      }
      const updated = await transaction.placement.update({
        where: { id: placementId },
        data: {
          pageUrl: next.pageUrl,
          urlPattern: next.urlPattern,
          embedType: next.embedType,
          environment: next.environment,
          businessStatus: next.businessStatus,
          launchedAt: next.launchedAt,
          nextCheckAt: next.nextCheckAt,
          monitorLockedAt: null,
          monitorLockedBy: null,
          monitorAttempts: 0,
          monitorJobKey: null,
          monitorLastError: null,
          monitorDeadAt: null,
          version: { increment: 1 },
        },
        include: placementRelations,
      });
      await syncOpportunityTechnicalRisk(transaction, current.opportunityId);
      const response = mapPlacement(updated);
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "placement.update",
          entityType: "Placement",
          entityId: placementId,
          beforeJson: toJson(mutablePlacementSnapshot(mapPlacement(current))),
          afterJson: toJson({
            ...mutablePlacementSnapshot(response),
            reason: command.reason,
          }),
          occurredAt: now,
        },
      });
      await createOutboxEvent(transaction, {
        eventType: "placement.updated",
        aggregateType: "Placement",
        aggregateId: placementId,
        aggregateVersion: response.version,
        payload: {
          placementId,
          changedFields: Object.keys(command).filter((field) => field !== "version" && field !== "reason"),
          businessStatus: response.businessStatus,
          reason: command.reason,
        },
        occurredAt: now,
      });
      await completeIdempotency(transaction, reservationId, response, now, 200);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async archive(
    placementId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<PlacementView> {
    const command = parseArchivePlacementCommand(input);
    const requestHash = placementArchiveRequestHash(command);
    const reservationId = randomUUID();
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const actor = await this.actors.current(transaction);
      const replay = await reserveIdempotency(transaction, {
        reservationId,
        actorId: actor.id,
        operation: `placement.archive:${placementId}`,
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parsePlacementReplay(replay, idempotencyKey);
      await lockPlacement(transaction, placementId);
      const current = await transaction.placement.findFirst({
        where: { id: placementId, archivedAt: null, ...placementScope(actor) },
        include: placementRelations,
      });
      if (!current) throw new PlacementNotFoundError(placementId);
      if (current.version !== command.version) {
        throw new PlacementVersionConflictError(current.version);
      }
      await closePlacementAlert(transaction, current.alerts[0] ?? null, now);
      const updated = await transaction.placement.update({
        where: { id: placementId },
        data: {
          businessStatus: "ended",
          archivedAt: now,
          nextCheckAt: null,
          monitorLockedAt: null,
          monitorLockedBy: null,
          monitorAttempts: 0,
          monitorJobKey: null,
          monitorLastError: null,
          monitorDeadAt: null,
          version: { increment: 1 },
        },
        include: placementRelations,
      });
      await syncOpportunityTechnicalRisk(transaction, current.opportunityId);
      const response = mapPlacement(updated);
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "placement.archive",
          entityType: "Placement",
          entityId: placementId,
          beforeJson: toJson(mutablePlacementSnapshot(mapPlacement(current))),
          afterJson: toJson({ archivedAt: now.toISOString(), reason: command.reason }),
          occurredAt: now,
        },
      });
      await createOutboxEvent(transaction, {
        eventType: "placement.archived",
        aggregateType: "Placement",
        aggregateId: placementId,
        aggregateVersion: response.version,
        payload: { placementId, reason: command.reason },
        occurredAt: now,
      });
      await completeIdempotency(transaction, reservationId, response, now, 200);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async runL0Check(
    placementId: string,
    idempotencyKey: string,
    source: "manual" | "schedule",
  ): Promise<PlacementCheckResult> {
    const actor = await this.actors.current();
    const requestHash = placementCheckRequestHash(placementId, source);
    const operation = `placement.l0-check:${placementId}`;
    const existingRequest = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorId_operation_requestKey: {
          actorId: actor.id,
          operation,
          requestKey: idempotencyKey,
        },
      },
    });
    if (existingRequest) {
      if (existingRequest.requestHash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      if (existingRequest.responseJson === null) {
        throw new IdempotencyInProgressError(idempotencyKey);
      }
      return parsePlacementCheckReplay(existingRequest.responseJson, idempotencyKey);
    }
    const target = await this.prisma.placement.findFirst({
      where: { id: placementId, archivedAt: null, ...placementScope(actor) },
      select: { pageUrl: true },
    });
    if (!target) throw new PlacementNotFoundError(placementId);
    const observation = await this.checker.check(target.pageUrl);
    const reservationId = randomUUID();
    const now = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const replay = await reserveIdempotency(transaction, {
        reservationId,
        actorId: actor.id,
        operation,
        idempotencyKey,
        requestHash,
        now,
      });
      if (replay !== null) return parsePlacementCheckReplay(replay, idempotencyKey);
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`placement-check:${placementId}`}, 0))
      `);
      const current = await transaction.placement.findFirst({
        where: { id: placementId, archivedAt: null, ...placementScope(actor) },
        include: placementRelations,
      });
      if (!current) throw new PlacementNotFoundError(placementId);
      if (current.businessStatus !== "active") {
        throw new DomainRuleError(
          "EMB-004",
          "L0-проверка доступна только для активного размещения",
          { businessStatus: "Переведите размещение в активное состояние" },
        );
      }
      const activeAlert = current.alerts[0] ?? null;
      const transition = applyPlacementHealthCheck(
        {
          healthStatus: current.healthStatus as PlacementView["healthStatus"],
          consecutiveFailures: current.consecutiveFailures,
          firstFailureAt: current.firstFailureAt,
          lastSuccessAt: current.lastSuccessAt,
          activeAlert: activeAlert !== null,
        },
        { result: observation.result, checkedAt: observation.checkedAt },
      );
      const checkId = randomUUID();
      const check = await transaction.healthCheck.create({
        data: {
          id: checkId,
          placementId,
          checkedAt: observation.checkedAt,
          result: observation.result,
          pageHttpStatus: observation.pageHttpStatus,
          embedHttpStatus: observation.embedHttpStatus,
          playerFound: observation.playerFound,
          embedUrl: observation.embedUrl,
          evidenceUri: null,
          errorCode: observation.errorCode,
          durationMs: observation.durationMs,
          source,
          idempotencyKey,
          requestHash,
          detailsJson: {},
        },
      });
      const updated = await transaction.placement.update({
        where: { id: placementId },
        data: {
          healthStatus: transition.state.healthStatus,
          consecutiveFailures: transition.state.consecutiveFailures,
          firstFailureAt: transition.state.firstFailureAt,
          lastSuccessAt: transition.state.lastSuccessAt,
          lastCheckAt: observation.checkedAt,
          nextCheckAt: transition.nextCheckAt,
          version: { increment: 1 },
        },
      });

      let nextAlert: Alert | null = activeAlert;
      if (transition.alertAction === "open") {
        const taskId = randomUUID();
        await transaction.task.create({
          data: {
            id: taskId,
            opportunityId: current.opportunityId,
            ownerId: current.ownerId,
            type: "technical-placement",
            title: `Исправить RUTUBE embed: ${current.organization.name}`,
            dueAt: transition.nextCheckAt,
            priorityScore: 100,
            priorityReasons: [{ code: "technical-alert", label: "Две ошибки L0-проверки" }],
            status: TaskStatus.OPEN,
            source: "embed-monitor",
          },
        });
        nextAlert = await transaction.alert.create({
          data: {
            id: randomUUID(),
            placementId,
            ownerId: current.ownerId,
            technicalTaskId: taskId,
            type: "placement-health",
            status: "open",
            severity: "high",
            firstFailureAt: transition.state.firstFailureAt ?? observation.checkedAt,
            openedAt: observation.checkedAt,
          },
        });
        await createOutboxEvent(transaction, {
          eventType: "placement.alert.opened",
          aggregateType: "Alert",
          aggregateId: nextAlert.id,
          aggregateVersion: 1,
          payload: { placementId, alertId: nextAlert.id, technicalTaskId: taskId },
          occurredAt: observation.checkedAt,
        });
      } else if (transition.alertAction === "close" && activeAlert) {
        nextAlert = await transaction.alert.update({
          where: { id: activeAlert.id },
          data: { status: "closed", closedAt: observation.checkedAt },
        });
        if (activeAlert.technicalTaskId) {
          await transaction.task.updateMany({
            where: { id: activeAlert.technicalTaskId, status: TaskStatus.OPEN },
            data: {
              status: TaskStatus.COMPLETED,
              outcome: "Работоспособность подтверждена L0-проверкой",
              completedAt: observation.checkedAt,
              version: { increment: 1 },
            },
          });
        }
        await createOutboxEvent(transaction, {
          eventType: "placement.alert.closed",
          aggregateType: "Alert",
          aggregateId: activeAlert.id,
          aggregateVersion: 2,
          payload: { placementId, alertId: activeAlert.id },
          occurredAt: observation.checkedAt,
        });
      }

      const remainingRisk = await transaction.placement.count({
        where: {
          opportunityId: current.opportunityId,
          archivedAt: null,
          businessStatus: "active",
          healthStatus: { not: "healthy" },
        },
      });
      await transaction.opportunity.update({
        where: { id: current.opportunityId },
        data: { technicalRisk: remainingRisk > 0 },
      });

      const checkView = mapHealthCheck(check);
      const placementRecord: PlacementRecord = {
        ...current,
        ...updated,
        healthChecks: [check],
        alerts: nextAlert?.status === "open" ? [nextAlert] : [],
      };
      const placementView = mapPlacement(placementRecord);
      const alertChange = transition.alertAction === "open"
        ? "opened"
        : transition.alertAction === "close"
          ? "closed"
          : "none";
      const response: PlacementCheckResult = { placement: placementView, check: checkView, alertChange };
      await transaction.auditLog.create({
        data: {
          id: randomUUID(),
          actorId: actor.id,
          action: "placement.l0-check",
          entityType: "Placement",
          entityId: placementId,
          beforeJson: toJson({
            healthStatus: current.healthStatus,
            consecutiveFailures: current.consecutiveFailures,
          }),
          afterJson: toJson({
            healthStatus: updated.healthStatus,
            consecutiveFailures: updated.consecutiveFailures,
            result: observation.result,
            alertChange,
          }),
          occurredAt: observation.checkedAt,
        },
      });
      await createOutboxEvent(transaction, {
        eventType: "placement.health.checked",
        aggregateType: "Placement",
        aggregateId: placementId,
        aggregateVersion: updated.version,
        payload: {
          placementId,
          checkId,
          result: observation.result,
          healthStatus: updated.healthStatus,
          alertChange,
        },
        occurredAt: observation.checkedAt,
      });
      await completeIdempotency(transaction, reservationId, response, observation.checkedAt);
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listChecks(placementId: string): Promise<HealthCheckView[]> {
    const actor = await this.actors.current();
    const placement = await this.prisma.placement.findFirst({
      where: { id: placementId, archivedAt: null, ...placementScope(actor) },
      select: { id: true },
    });
    if (!placement) throw new PlacementNotFoundError(placementId);
    const checks = await this.prisma.healthCheck.findMany({
      where: { placementId },
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    });
    return checks.map(mapHealthCheck);
  }
}

const placementRelations = Prisma.validator<Prisma.PlacementInclude>()({
  organization: { select: { name: true } },
  owner: { select: { displayName: true } },
  healthChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
  alerts: { where: { status: "open" }, orderBy: { openedAt: "desc" }, take: 1 },
});

type PlacementRecord = Prisma.PlacementGetPayload<{ include: typeof placementRelations }>;

function mapPlacement(record: PlacementRecord): PlacementView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    organizationName: record.organization.name,
    opportunityId: record.opportunityId,
    ownerId: record.ownerId,
    ownerName: record.owner.displayName,
    pageUrl: record.pageUrl,
    urlPattern: record.urlPattern,
    embedType: record.embedType as PlacementView["embedType"],
    environment: record.environment as PlacementView["environment"],
    businessStatus: record.businessStatus as PlacementView["businessStatus"],
    healthStatus: record.healthStatus as PlacementView["healthStatus"],
    launchedAt: record.launchedAt?.toISOString() ?? null,
    consecutiveFailures: record.consecutiveFailures,
    firstFailureAt: record.firstFailureAt?.toISOString() ?? null,
    lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
    lastCheckAt: record.lastCheckAt?.toISOString() ?? null,
    nextCheckAt: record.nextCheckAt?.toISOString() ?? null,
    version: record.version,
    lastCheck: record.healthChecks[0] ? mapHealthCheck(record.healthChecks[0]) : null,
    activeAlert: record.alerts[0] ? mapAlert(record.alerts[0]) : null,
  };
}

function mapHealthCheck(check: HealthCheck): HealthCheckView {
  return {
    id: check.id,
    placementId: check.placementId,
    checkedAt: check.checkedAt.toISOString(),
    result: check.result as HealthCheckView["result"],
    pageHttpStatus: check.pageHttpStatus,
    embedHttpStatus: check.embedHttpStatus,
    playerFound: check.playerFound,
    embedUrl: check.embedUrl,
    evidenceUri: check.evidenceUri,
    errorCode: check.errorCode,
    durationMs: check.durationMs,
    source: check.source as HealthCheckView["source"],
  };
}

function mapAlert(alert: Alert): PlacementAlertView {
  return {
    id: alert.id,
    status: alert.status as PlacementAlertView["status"],
    severity: alert.severity as PlacementAlertView["severity"],
    firstFailureAt: alert.firstFailureAt.toISOString(),
    openedAt: alert.openedAt.toISOString(),
    closedAt: alert.closedAt?.toISOString() ?? null,
    technicalTaskId: alert.technicalTaskId,
  };
}

function resolvePlacementUpdate(
  current: PlacementRecord,
  command: UpdatePlacementCommand,
  now: Date,
) {
  const businessStatus = command.businessStatus ?? current.businessStatus;
  const launchedAt = Object.hasOwn(command, "launchedAt")
    ? command.launchedAt ? new Date(command.launchedAt) : null
    : current.launchedAt;
  if (businessStatus === "active" && !launchedAt) {
    throw new DomainRuleError(
      "EMB-001",
      "Для активного размещения укажите дату запуска",
      { launchedAt: "Дата запуска обязательна для активного размещения" },
    );
  }
  const monitoringTargetChanged = command.pageUrl !== undefined ||
    command.urlPattern !== undefined ||
    command.embedType !== undefined ||
    command.environment !== undefined;
  const shouldCheckNow = businessStatus === "active" && (
    current.businessStatus !== "active" || current.nextCheckAt === null || monitoringTargetChanged
  );
  return {
    pageUrl: command.pageUrl ?? current.pageUrl,
    urlPattern: command.urlPattern ?? current.urlPattern,
    embedType: command.embedType ?? current.embedType,
    environment: command.environment ?? current.environment,
    businessStatus,
    launchedAt,
    nextCheckAt: businessStatus === "active"
      ? shouldCheckNow ? now : current.nextCheckAt
      : null,
  };
}

function mutablePlacementSnapshot(placement: PlacementView) {
  return {
    pageUrl: placement.pageUrl,
    urlPattern: placement.urlPattern,
    embedType: placement.embedType,
    environment: placement.environment,
    businessStatus: placement.businessStatus,
    launchedAt: placement.launchedAt,
    nextCheckAt: placement.nextCheckAt,
    version: placement.version,
  };
}

async function lockPlacement(transaction: Prisma.TransactionClient, placementId: string) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`placement-check:${placementId}`}, 0))
  `);
}

async function closePlacementAlert(
  transaction: Prisma.TransactionClient,
  alert: Alert | null,
  now: Date,
) {
  if (!alert) return;
  await transaction.alert.update({
    where: { id: alert.id },
    data: { status: "closed", closedAt: now },
  });
  if (alert.technicalTaskId) {
    await transaction.task.updateMany({
      where: { id: alert.technicalTaskId, status: TaskStatus.OPEN },
      data: {
        status: TaskStatus.COMPLETED,
        outcome: "Мониторинг размещения завершён изменением жизненного цикла",
        completedAt: now,
        version: { increment: 1 },
      },
    });
  }
  await createOutboxEvent(transaction, {
    eventType: "placement.alert.closed",
    aggregateType: "Alert",
    aggregateId: alert.id,
    aggregateVersion: 2,
    payload: { placementId: alert.placementId, alertId: alert.id, reason: "lifecycle-change" },
    occurredAt: now,
  });
}

async function syncOpportunityTechnicalRisk(
  transaction: Prisma.TransactionClient,
  opportunityId: string,
) {
  const remainingRisk = await transaction.placement.count({
    where: {
      opportunityId,
      archivedAt: null,
      businessStatus: "active",
      healthStatus: { not: "healthy" },
    },
  });
  await transaction.opportunity.update({
    where: { id: opportunityId },
    data: { technicalRisk: remainingRisk > 0 },
  });
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
  if (existing.requestHash !== input.requestHash) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
  if (existing.responseJson === null) throw new IdempotencyInProgressError(input.idempotencyKey);
  return existing.responseJson;
}

async function completeIdempotency(
  transaction: Prisma.TransactionClient,
  reservationId: string,
  response: PlacementView | PlacementCheckResult,
  completedAt: Date,
  responseStatus = 201,
) {
  await transaction.idempotencyRecord.update({
    where: { id: reservationId },
    data: {
      responseStatus,
      responseJson: toJson(response),
      completedAt,
    },
  });
}

async function createOutboxEvent(
  transaction: Prisma.TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
) {
  await transaction.outboxEvent.create({
    data: {
      id: randomUUID(),
      ...input,
      schemaVersion: 1,
      payload: toJson(input.payload),
    },
  });
}

function parsePlacementReplay(value: Prisma.JsonValue, key: string): PlacementView {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pageUrl !== "string") {
    throw new IdempotencyInProgressError(key);
  }
  return value as unknown as PlacementView;
}

function parsePlacementCheckReplay(value: Prisma.JsonValue, key: string): PlacementCheckResult {
  if (!isRecord(value) || !isRecord(value.placement) || !isRecord(value.check)) {
    throw new IdempotencyInProgressError(key);
  }
  return value as unknown as PlacementCheckResult;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

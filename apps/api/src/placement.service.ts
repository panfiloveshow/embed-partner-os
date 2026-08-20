import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
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
  placementCheckRequestHash,
  placementArchiveRequestHash,
  placementRequestHash,
  placementUpdateRequestHash,
} from "./application/idempotency.js";
import type { L0CheckObservation } from "./monitoring/l0-embed-checker.js";
import { L0_CHECKER, type L0Checker } from "./monitoring/l0-checker.port.js";
import type { PlacementPort } from "./placement.port.js";
import { TodayService } from "./today.service.js";

export class PlacementNotFoundError extends Error {
  readonly code = "PLACEMENT_NOT_FOUND";
  constructor(readonly placementId: string) {
    super(`Размещение ${placementId} не найдено`);
    this.name = "PlacementNotFoundError";
  }
}

export class PlacementContextNotFoundError extends Error {
  readonly code = "PLACEMENT_CONTEXT_NOT_FOUND";
  constructor() {
    super("Организация и возможность не найдены в доступной области команды");
    this.name = "PlacementContextNotFoundError";
  }
}

export class PlacementVersionConflictError extends Error {
  readonly code = "PLACEMENT_VERSION_CONFLICT";
  constructor(readonly currentVersion: number) {
    super(`Размещение уже изменено. Актуальная версия: ${currentVersion}`);
    this.name = "PlacementVersionConflictError";
  }
}

@Injectable()
export class PlacementService implements PlacementPort {
  private readonly placements = new Map<string, PlacementView>();
  private readonly checks = new Map<string, HealthCheckView[]>();
  private readonly archivedPlacementIds = new Set<string>();
  private readonly registerIdempotency = new Map<
    string,
    { requestHash: string; response: PlacementView }
  >();
  private readonly checkIdempotency = new Map<
    string,
    { requestHash: string; response: PlacementCheckResult }
  >();
  private readonly updateIdempotency = new Map<
    string,
    { requestHash: string; response: PlacementView }
  >();
  private readonly archiveIdempotency = new Map<
    string,
    { requestHash: string; response: PlacementView }
  >();

  constructor(
    @Inject(TodayService) private readonly today: TodayService,
    @Inject(L0_CHECKER) private readonly checker: L0Checker,
  ) {}

  list(): PlacementView[] {
    return [...this.placements.values()]
      .filter(({ id }) => !this.archivedPlacementIds.has(id))
      .sort((left, right) => left.organizationName.localeCompare(right.organizationName))
      .map((placement) => structuredClone(placement));
  }

  update(placementId: string, input: unknown, idempotencyKey: string): PlacementView {
    const command = parseUpdatePlacementCommand(input);
    const requestHash = placementUpdateRequestHash(command);
    const scope = `${placementId}:${idempotencyKey}`;
    const replay = this.updateIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const current = this.activePlacement(placementId);
    if (current.version !== command.version) {
      throw new PlacementVersionConflictError(current.version);
    }
    let updated = applyPlacementUpdate(current, command, new Date());
    if (updated.businessStatus === "ended" && current.activeAlert) {
      if (current.activeAlert.technicalTaskId) {
        this.today.resolveTechnicalPlacementTask(current.activeAlert.technicalTaskId);
      }
      updated = { ...updated, activeAlert: null };
    }
    this.placements.set(placementId, updated);
    this.updateIdempotency.set(scope, { requestHash, response: structuredClone(updated) });
    return structuredClone(updated);
  }

  archive(placementId: string, input: unknown, idempotencyKey: string): PlacementView {
    const command = parseArchivePlacementCommand(input);
    const requestHash = placementArchiveRequestHash(command);
    const scope = `${placementId}:${idempotencyKey}`;
    const replay = this.archiveIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const current = this.activePlacement(placementId);
    if (current.version !== command.version) {
      throw new PlacementVersionConflictError(current.version);
    }
    if (current.activeAlert?.technicalTaskId) {
      this.today.resolveTechnicalPlacementTask(current.activeAlert.technicalTaskId);
    }
    const archived: PlacementView = {
      ...current,
      businessStatus: "ended",
      nextCheckAt: null,
      activeAlert: null,
      version: current.version + 1,
    };
    this.placements.set(placementId, archived);
    this.archivedPlacementIds.add(placementId);
    this.archiveIdempotency.set(scope, { requestHash, response: structuredClone(archived) });
    return structuredClone(archived);
  }

  register(input: unknown, idempotencyKey: string): PlacementView {
    const command = parseRegisterPlacementCommand(input);
    const requestHash = placementRequestHash(command);
    const replay = this.registerIdempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const context = this.today.getPlacementContext(command.organizationId, command.opportunityId);
    if (!context) throw new PlacementContextNotFoundError();
    const now = new Date();
    const placement: PlacementView = {
      id: randomUUID(),
      organizationId: command.organizationId,
      organizationName: context.organizationName,
      opportunityId: command.opportunityId,
      ownerId: context.ownerId,
      ownerName: context.ownerName,
      pageUrl: command.pageUrl,
      urlPattern: command.urlPattern,
      embedType: command.embedType,
      environment: command.environment,
      businessStatus: command.businessStatus,
      healthStatus: "unchecked",
      launchedAt: command.launchedAt ?? null,
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastSuccessAt: null,
      lastCheckAt: null,
      nextCheckAt: command.businessStatus === "active" ? now.toISOString() : null,
      version: 1,
      lastCheck: null,
      activeAlert: null,
    };
    this.placements.set(placement.id, placement);
    this.checks.set(placement.id, []);
    this.registerIdempotency.set(idempotencyKey, {
      requestHash,
      response: structuredClone(placement),
    });
    return structuredClone(placement);
  }

  async runL0Check(
    placementId: string,
    idempotencyKey: string,
    source: "manual" | "schedule",
  ): Promise<PlacementCheckResult> {
    const requestHash = placementCheckRequestHash(placementId, source);
    const scope = `${placementId}:${idempotencyKey}`;
    const replay = this.checkIdempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const current = this.activePlacement(placementId);
    if (current.businessStatus !== "active") {
      throw new DomainRuleError(
        "EMB-004",
        "L0-проверка доступна только для активного размещения",
        { businessStatus: "Переведите размещение в активное состояние" },
      );
    }
    const observation = await this.checker.check(current.pageUrl);
    const transition = applyPlacementHealthCheck(
      {
        healthStatus: current.healthStatus,
        consecutiveFailures: current.consecutiveFailures,
        firstFailureAt: current.firstFailureAt ? new Date(current.firstFailureAt) : null,
        lastSuccessAt: current.lastSuccessAt ? new Date(current.lastSuccessAt) : null,
        activeAlert: current.activeAlert !== null,
      },
      { result: observation.result, checkedAt: observation.checkedAt },
    );
    const check = toHealthCheck(placementId, source, observation);
    let activeAlert = current.activeAlert;
    if (transition.alertAction === "open") {
      const technicalTaskId = `task-technical-${randomUUID()}`;
      this.today.createTechnicalPlacementTask({
        taskId: technicalTaskId,
        organizationId: current.organizationId,
        opportunityId: current.opportunityId,
        organizationName: current.organizationName,
        dueAt: transition.nextCheckAt.toISOString(),
      });
      activeAlert = {
        id: randomUUID(),
        status: "open",
        severity: "high",
        firstFailureAt: transition.state.firstFailureAt?.toISOString() ?? check.checkedAt,
        openedAt: check.checkedAt,
        closedAt: null,
        technicalTaskId,
      };
    } else if (transition.alertAction === "close" && activeAlert) {
      if (activeAlert.technicalTaskId) {
        this.today.resolveTechnicalPlacementTask(activeAlert.technicalTaskId);
      }
      activeAlert = null;
    }
    const updated: PlacementView = {
      ...current,
      healthStatus: transition.state.healthStatus,
      consecutiveFailures: transition.state.consecutiveFailures,
      firstFailureAt: transition.state.firstFailureAt?.toISOString() ?? null,
      lastSuccessAt: transition.state.lastSuccessAt?.toISOString() ?? null,
      lastCheckAt: check.checkedAt,
      nextCheckAt: transition.nextCheckAt.toISOString(),
      version: current.version + 1,
      lastCheck: check,
      activeAlert,
    };
    this.placements.set(placementId, updated);
    this.checks.get(placementId)?.push(check);
    const response: PlacementCheckResult = {
      placement: structuredClone(updated),
      check: structuredClone(check),
      alertChange: transition.alertAction === "open"
        ? "opened"
        : transition.alertAction === "close"
          ? "closed"
          : "none",
    };
    this.checkIdempotency.set(scope, { requestHash, response: structuredClone(response) });
    return response;
  }

  listChecks(placementId: string): HealthCheckView[] {
    this.activePlacement(placementId);
    return structuredClone(this.checks.get(placementId) ?? []);
  }

  private activePlacement(placementId: string): PlacementView {
    const placement = this.placements.get(placementId);
    if (!placement || this.archivedPlacementIds.has(placementId)) {
      throw new PlacementNotFoundError(placementId);
    }
    return placement;
  }
}

function applyPlacementUpdate(
  current: PlacementView,
  command: UpdatePlacementCommand,
  now: Date,
): PlacementView {
  const businessStatus = command.businessStatus ?? current.businessStatus;
  const launchedAt = Object.hasOwn(command, "launchedAt")
    ? command.launchedAt ?? null
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
    ...current,
    ...(command.pageUrl !== undefined ? { pageUrl: command.pageUrl } : {}),
    ...(command.urlPattern !== undefined ? { urlPattern: command.urlPattern } : {}),
    ...(command.embedType !== undefined ? { embedType: command.embedType } : {}),
    ...(command.environment !== undefined ? { environment: command.environment } : {}),
    businessStatus,
    launchedAt,
    nextCheckAt: businessStatus === "active"
      ? shouldCheckNow ? now.toISOString() : current.nextCheckAt
      : null,
    version: current.version + 1,
  };
}

function toHealthCheck(
  placementId: string,
  source: "manual" | "schedule",
  observation: L0CheckObservation,
): HealthCheckView {
  return {
    id: randomUUID(),
    placementId,
    checkedAt: observation.checkedAt.toISOString(),
    result: observation.result,
    pageHttpStatus: observation.pageHttpStatus,
    embedHttpStatus: observation.embedHttpStatus,
    playerFound: observation.playerFound,
    embedUrl: observation.embedUrl,
    evidenceUri: null,
    errorCode: observation.errorCode,
    durationMs: observation.durationMs,
    source,
  };
}

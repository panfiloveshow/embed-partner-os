import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  FunnelOpportunity,
  FunnelPayload,
  OpportunityStageCode,
  OpportunityRiskFlag,
  OpportunityStageTransitionResult,
} from "@embed-os/contracts";
import {
  assertOpportunityStageReady,
  assertOpportunityTransitionAllowed,
  DomainRuleError,
  opportunityStageLabel,
  parseTransitionOpportunityStageCommand,
} from "@embed-os/domain";
import {
  IdempotencyConflictError,
  opportunityStageRequestHash,
} from "./application/idempotency.js";
import { OPPORTUNITY_PORT, type OpportunityPort } from "./opportunity.port.js";
import { PLACEMENT_PORT, type PlacementPort } from "./placement.port.js";
import { TodayService } from "./today.service.js";

export class OpportunityNotFoundError extends Error {
  readonly code = "OPPORTUNITY_NOT_FOUND";
  constructor(readonly opportunityId: string) {
    super(`Возможность ${opportunityId} не найдена`);
    this.name = "OpportunityNotFoundError";
  }
}

export class OpportunityVersionConflictError extends Error {
  readonly code = "OPPORTUNITY_VERSION_CONFLICT";
  constructor(readonly currentVersion: number) {
    super(`Возможность уже изменена. Актуальная версия: ${currentVersion}`);
    this.name = "OpportunityVersionConflictError";
  }
}

@Injectable()
export class OpportunityService implements OpportunityPort {
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: OpportunityStageTransitionResult }
  >();
  private readonly resumeStages = new Map<string, OpportunityStageCode>();

  constructor(
    @Inject(TodayService) private readonly today: TodayService,
    @Inject(PLACEMENT_PORT) private readonly placements: PlacementPort,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(): Promise<FunnelPayload> {
    const today = this.today.getToday();
    const generatedAt = this.clock();
    const opportunities = uniqueOpportunities(today.actions).map((action): FunnelOpportunity => ({
      id: action.opportunityId,
      version: action.opportunityVersion,
      processVersion: action.processVersion,
      organizationId: action.organizationId,
      organizationName: action.organizationName,
      domain: action.domain,
      type: "EMBED",
      stageCode: action.stageCode as OpportunityStageCode,
      stageLabel: action.stageLabel,
      status: action.opportunityStatus,
      partnerScore: action.partnerScore ?? 0,
      owner: { id: today.currentUser.id, name: action.ownerName },
      nextAction: action.dueAt
        ? { id: action.id, title: action.title, dueAt: action.dueAt }
        : null,
      lastInteractionAt: action.lastInteraction?.occurredAt ?? null,
      stageAgeDays: null,
      riskFlags: riskFlagsForAction(action, generatedAt),
    })).sort((left, right) =>
      left.stageCode.localeCompare(right.stageCode) ||
      right.partnerScore - left.partnerScore ||
      left.organizationName.localeCompare(right.organizationName, "ru")
    );
    const stageCounts = countStages(opportunities);

    return {
      generatedAt: generatedAt.toISOString(),
      teamName: today.teamName,
      total: opportunities.length,
      truncated: false,
      processVersions: [...new Set(opportunities.map(({ processVersion }) => processVersion))]
        .sort((left, right) => left - right),
      stageCounts,
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
    const scope = `${opportunityId}:${idempotencyKey}`;
    const replay = this.idempotency.get(scope);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);
      return structuredClone(replay.response);
    }
    const current = this.today.getOpportunityStageContext(opportunityId);
    if (!current) throw new OpportunityNotFoundError(opportunityId);
    if (current.version !== command.version) {
      throw new OpportunityVersionConflictError(current.version);
    }
    const fromStageCode = current.stageCode as OpportunityStageCode;
    assertOpportunityTransitionAllowed(
      fromStageCode,
      command.toStageCode,
      this.resumeStages.get(opportunityId) ?? null,
    );
    const now = this.clock();
    assertLifecycleDates(command, now);
    const stageData = { ...current.stageData, ...(command.stageData ?? {}) };
    const placements = command.toStageCode === "S9"
      ? (await this.placements.list()).filter((placement) => placement.opportunityId === opportunityId)
      : [];
    const activePlacements = placements.filter(({ businessStatus }) => businessStatus === "active");
    assertOpportunityStageReady(command.toStageCode, stageData, {
      primaryDomain: current.primaryDomain,
      topic: current.topic,
      score: current.score,
      ownerId: current.ownerId,
      hasNextAction: current.hasNextAction,
      hasContactOrChannel: current.hasContactOrChannel,
      latestInteraction: current.latestInteraction,
      hasActivePlacement: activePlacements.length > 0,
      hasLaunchedPlacement: activePlacements.some(({ launchedAt }) => launchedAt !== null),
      hasHealthyMonitoredPlacement: activePlacements.some((placement) =>
        placement.healthStatus === "healthy" &&
        placement.launchedAt !== null &&
        placement.lastCheckAt !== null,
      ),
      hasPlacementOwner: activePlacements.some(({ ownerId }) => ownerId.length > 0),
    });
    if (command.toStageCode === "SX") this.resumeStages.set(opportunityId, fromStageCode);
    else if (fromStageCode === "SX") this.resumeStages.delete(opportunityId);

    const response: OpportunityStageTransitionResult = {
      opportunityId,
      processVersion: current.processVersion,
      fromStageCode,
      toStageCode: command.toStageCode,
      stageLabel: opportunityStageLabel(command.toStageCode),
      status: statusFor(command.toStageCode),
      stageData,
      version: current.version + 1,
      occurredAt: now.toISOString(),
    };
    this.today.applyOpportunityStageTransition(response, command);
    this.idempotency.set(scope, { requestHash, response: structuredClone(response) });
    return structuredClone(response);
  }
}

function uniqueOpportunities(actions: ReturnType<TodayService["getToday"]>["actions"]) {
  const unique = new Map<string, (typeof actions)[number]>();
  for (const action of actions) {
    const current = unique.get(action.opportunityId);
    if (!current || action.priorityScore > current.priorityScore) {
      unique.set(action.opportunityId, action);
    }
  }
  return [...unique.values()];
}

function riskFlagsForAction(
  action: ReturnType<TodayService["getToday"]>["actions"][number],
  now: Date,
): OpportunityRiskFlag[] {
  const flags: OpportunityRiskFlag[] = [];
  if (action.dueAt && new Date(action.dueAt) < now && action.group !== "waiting") {
    flags.push("overdue");
  }
  if (!action.dueAt && action.opportunityStatus === "ACTIVE") flags.push("missing-next-action");
  if (
    action.group === "waiting" ||
    action.opportunityStatus === "WAITING" ||
    action.opportunityStatus === "PAUSED"
  ) {
    flags.push("waiting");
  }
  if (action.priorityReasons.some(({ code }) => code === "technical-risk")) {
    flags.push("technical-risk");
  }
  return flags;
}

function countStages(opportunities: FunnelOpportunity[]) {
  const counts = new Map<OpportunityStageCode, number>();
  for (const opportunity of opportunities) {
    counts.set(opportunity.stageCode, (counts.get(opportunity.stageCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, label: opportunityStageLabel(code), count }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function assertLifecycleDates(
  command: ReturnType<typeof parseTransitionOpportunityStageCommand>,
  now: Date,
) {
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

function statusFor(stage: OpportunityStageCode) {
  if (stage === "SX") return "PAUSED" as const;
  if (stage === "SL") return "CLOSED" as const;
  return "ACTIVE" as const;
}

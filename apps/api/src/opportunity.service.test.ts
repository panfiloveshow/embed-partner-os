import { describe, expect, it } from "vitest";
import type { L0CheckObservation } from "./monitoring/l0-embed-checker.js";
import { OpportunityService, OpportunityVersionConflictError } from "./opportunity.service.js";
import { PlacementService } from "./placement.service.js";
import { TodayService } from "./today.service.js";

describe("OpportunityService", () => {
  it("returns one shared funnel dataset with stage totals and risk flags", async () => {
    const today = new TodayService();
    const placements = new PlacementService(today, new SequenceChecker([]));
    const service = new OpportunityService(today, placements, fixedClock);

    const funnel = await service.list();

    expect(funnel).toMatchObject({
      generatedAt: fixedClock().toISOString(),
      teamName: "Команда внедрения",
      total: 16,
      truncated: false,
      processVersions: [1],
    });
    expect(funnel.stageCounts.reduce((sum, stage) => sum + stage.count, 0)).toBe(16);
    expect(funnel.opportunities.find(({ id }) => id === "opp-task-2")).toMatchObject({
      organizationName: "Спорт Онлайн",
      stageCode: "S7",
      nextAction: { id: "task-2", title: "Предоставить тестовый доступ" },
      riskFlags: ["overdue", "technical-risk"],
    });
    expect(funnel.opportunities.find(({ id }) => id === "opp-task-13")?.riskFlags).toContain(
      "waiting",
    );
  });

  it("moves to the next stage idempotently and rejects a stale version", async () => {
    const today = new TodayService();
    const placements = new PlacementService(today, new SequenceChecker([]));
    const service = new OpportunityService(today, placements, fixedClock);
    const command = { version: 1, toStageCode: "S8", reason: "Тестовый embed готов" };

    const first = await service.transition("opp-task-1", command, "stage-transition-0001");
    const replay = await service.transition("opp-task-1", command, "stage-transition-0001");

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      opportunityId: "opp-task-1",
      fromStageCode: "S7",
      toStageCode: "S8",
      stageLabel: "Пилот",
      stageData: expect.objectContaining({
        successCriteria: expect.any(String),
        metricsSource: "RUTUBE Analytics",
      }),
      version: 2,
    });
    expect(
      today.getToday().actions.find(({ opportunityId }) => opportunityId === "opp-task-1"),
    ).toMatchObject({ stageCode: "S8", opportunityVersion: 2 });
    await expect(
      service.transition(
        "opp-task-1",
        {
          version: 1,
          toStageCode: "S9",
          reason: "Устаревшая форма",
        },
        "stage-transition-0002",
      ),
    ).rejects.toBeInstanceOf(OpportunityVersionConflictError);
  });

  it("blocks S9 until an active placement has a successful check", async () => {
    const today = new TodayService();
    const placements = new PlacementService(today, new SequenceChecker([healthyObservation()]));
    const service = new OpportunityService(today, placements, fixedClock);
    await service.transition(
      "opp-task-1",
      {
        version: 1,
        toStageCode: "S8",
        reason: "Пилот начат",
      },
      "stage-transition-0010",
    );

    await expect(
      service.transition(
        "opp-task-1",
        {
          version: 2,
          toStageCode: "S9",
          reason: "Запуск",
        },
        "stage-transition-0011",
      ),
    ).rejects.toMatchObject({ code: "BR-007" });

    const placement = placements.register(
      {
        organizationId: "org-task-1",
        opportunityId: "opp-task-1",
        pageUrl: "https://medianovosti.ru/active-rutube",
        embedType: "video",
        environment: "production",
        businessStatus: "active",
        launchedAt: "2026-08-18T08:00:00+03:00",
      },
      "placement-register-stage-0001",
    );
    await placements.runL0Check(placement.id, "placement-check-stage-0001", "manual");

    await expect(
      service.transition(
        "opp-task-1",
        {
          version: 2,
          toStageCode: "S9",
          reason: "Работоспособность подтверждена",
        },
        "stage-transition-0012",
      ),
    ).resolves.toMatchObject({
      toStageCode: "S9",
      stageLabel: "Активный",
      version: 3,
    });
  });

  it("returns the exact missing data for the target stage", async () => {
    const today = new TodayService();
    const placements = new PlacementService(today, new SequenceChecker([]));
    const service = new OpportunityService(today, placements, fixedClock);

    await expect(
      service.transition(
        "opp-task-9",
        {
          version: 1,
          toStageCode: "S3",
          reason: "Первое письмо отправлено",
        },
        "stage-transition-required-0001",
      ),
    ).rejects.toMatchObject({
      code: "BR-003",
      fieldErrors: {
        interactionOutcome: "Зафиксируйте результат контакта",
      },
    });
  });
});

class SequenceChecker {
  constructor(private readonly observations: L0CheckObservation[]) {}
  async check() {
    const next = this.observations.shift();
    if (!next) throw new Error("No observation configured");
    return next;
  }
}

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1_000;

/**
 * Seed actions are shifted to the current Moscow day at load time, so the
 * deterministic clock is pinned to "the day after the seed anchor, 13:00 MSK".
 */
function fixedClock() {
  const moscowNow = new Date(Date.now() + MOSCOW_UTC_OFFSET_MS);
  return new Date(
    Date.UTC(moscowNow.getUTCFullYear(), moscowNow.getUTCMonth(), moscowNow.getUTCDate() + 1, 13) -
      MOSCOW_UTC_OFFSET_MS,
  );
}

function healthyObservation(): L0CheckObservation {
  return {
    checkedAt: fixedClock(),
    result: "healthy",
    pageHttpStatus: 200,
    embedHttpStatus: 200,
    playerFound: true,
    embedUrl: "https://rutube.ru/play/embed/video-id",
    errorCode: null,
    durationMs: 20,
  };
}

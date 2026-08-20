import { describe, expect, it } from "vitest";
import type { L0CheckResult } from "@embed-os/contracts";
import type { L0CheckObservation } from "./monitoring/l0-embed-checker.js";
import { PlacementService, PlacementVersionConflictError } from "./placement.service.js";
import { TodayService } from "./today.service.js";

describe("PlacementService", () => {
  it("registers a placement idempotently in the matching opportunity context", () => {
    const service = new PlacementService(new TodayService(), new SequenceChecker([]));
    const command = activePlacement();

    const first = service.register(command, "placement-register-0001");
    const replay = service.register(command, "placement-register-0001");

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      organizationId: "org-task-1",
      opportunityId: "opp-task-1",
      organizationName: "Медиа Новости",
      healthStatus: "unchecked",
      businessStatus: "active",
      consecutiveFailures: 0,
    });
    expect(service.list()).toHaveLength(1);
  });

  it("opens one technical alert and task after two failures, then closes both on recovery", async () => {
    const today = new TodayService();
    const checker = new SequenceChecker([
      observation("failed", "2026-08-18T09:00:00.000Z"),
      observation("failed", "2026-08-18T09:15:00.000Z"),
      observation("healthy", "2026-08-18T10:00:00.000Z"),
    ]);
    const service = new PlacementService(today, checker);
    const placement = service.register(activePlacement(), "placement-register-0002");

    const first = await service.runL0Check(placement.id, "placement-check-0001", "manual");
    expect(first).toMatchObject({
      alertChange: "none",
      placement: { healthStatus: "degraded", consecutiveFailures: 1, activeAlert: null },
    });

    const second = await service.runL0Check(placement.id, "placement-check-0002", "manual");
    const replay = await service.runL0Check(placement.id, "placement-check-0002", "manual");
    expect(replay).toEqual(second);
    expect(second).toMatchObject({
      alertChange: "opened",
      placement: {
        healthStatus: "failed",
        consecutiveFailures: 2,
        activeAlert: { status: "open", technicalTaskId: expect.any(String) },
      },
    });
    expect(today.getToday().actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: second.placement.activeAlert?.technicalTaskId }),
      ]),
    );

    const recovered = await service.runL0Check(placement.id, "placement-check-0003", "manual");
    expect(recovered).toMatchObject({
      alertChange: "closed",
      placement: { healthStatus: "healthy", consecutiveFailures: 0, activeAlert: null },
    });
    expect(
      today
        .getToday()
        .actions.some(({ id }) => id === second.placement.activeAlert?.technicalTaskId),
    ).toBe(false);
    expect(service.listChecks(placement.id)).toHaveLength(3);
  });

  it("pauses and resumes monitoring idempotently with optimistic versioning", () => {
    const service = new PlacementService(new TodayService(), new SequenceChecker([]));
    const placement = service.register(activePlacement(), "placement-register-0003");

    const paused = service.update(
      placement.id,
      {
        version: placement.version,
        businessStatus: "paused",
        reason: "Пауза по запросу партнёра",
      },
      "placement-update-0001",
    );
    const replay = service.update(
      placement.id,
      {
        version: placement.version,
        businessStatus: "paused",
        reason: "Пауза по запросу партнёра",
      },
      "placement-update-0001",
    );

    expect(replay).toEqual(paused);
    expect(paused).toMatchObject({ businessStatus: "paused", nextCheckAt: null, version: 2 });
    expect(() =>
      service.update(
        placement.id,
        {
          version: 1,
          businessStatus: "active",
          reason: "Повторный запуск",
        },
        "placement-update-0002",
      ),
    ).toThrowError(PlacementVersionConflictError);

    const resumed = service.update(
      placement.id,
      {
        version: paused.version,
        businessStatus: "active",
        reason: "Повторный запуск",
      },
      "placement-update-0003",
    );
    expect(resumed.businessStatus).toBe("active");
    expect(resumed.nextCheckAt).not.toBeNull();
    expect(resumed.version).toBe(3);
  });

  it("soft-archives a placement idempotently and removes it from active APIs", () => {
    const service = new PlacementService(new TodayService(), new SequenceChecker([]));
    const placement = service.register(activePlacement(), "placement-register-0004");
    const command = { version: placement.version, reason: "Размещение демонтировано" };

    const archived = service.archive(placement.id, command, "placement-archive-0001");
    const replay = service.archive(placement.id, command, "placement-archive-0001");

    expect(replay).toEqual(archived);
    expect(archived).toMatchObject({ businessStatus: "ended", nextCheckAt: null, version: 2 });
    expect(service.list()).toEqual([]);
    expect(() => service.listChecks(placement.id)).toThrowError(/не найдено/);
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

function activePlacement() {
  return {
    organizationId: "org-task-1",
    opportunityId: "opp-task-1",
    pageUrl: "https://medianovosti.ru/articles/video",
    embedType: "video",
    environment: "production",
    businessStatus: "active",
    launchedAt: "2026-08-18T08:00:00+03:00",
  };
}

function observation(result: L0CheckResult, checkedAt: string): L0CheckObservation {
  return {
    checkedAt: new Date(checkedAt),
    result,
    pageHttpStatus: result === "healthy" ? 200 : 500,
    embedHttpStatus: result === "healthy" ? 200 : null,
    playerFound: result === "healthy",
    embedUrl: result === "healthy" ? "https://rutube.ru/play/embed/video-id" : null,
    errorCode: result === "healthy" ? null : "PAGE_HTTP_ERROR",
    durationMs: 20,
  };
}

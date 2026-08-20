import { describe, expect, it } from "vitest";
import type { PlacementView } from "@embed-os/contracts";
import { filterPlacements, sortPlacementChecks, summarizePlacements } from "./placements.js";

describe("placement registry model", () => {
  it("summarizes active placements without treating unchecked as healthy", () => {
    const placements = [
      placement("healthy", "active"),
      placement("failed", "active"),
      placement("degraded", "active"),
      placement("unchecked", "active"),
      placement("healthy", "paused"),
    ];

    expect(summarizePlacements(placements)).toEqual({
      active: 4,
      healthy: 1,
      attention: 2,
      unchecked: 1,
    });
  });

  it("filters by partner or URL, health status and environment", () => {
    const placements = [
      {
        ...placement("healthy", "active"),
        organizationName: "Спорт Онлайн",
        pageUrl: "https://sport.ru/live",
      },
      {
        ...placement("failed", "active"),
        organizationName: "Медиа Новости",
        pageUrl: "https://news.ru/video",
      },
      {
        ...placement("healthy", "active"),
        organizationName: "Тест",
        pageUrl: "https://stage.ru",
        environment: "staging" as const,
      },
    ];

    expect(
      filterPlacements(placements, {
        query: "новости",
        status: "failed",
        environment: "production",
      }).map(({ organizationName }) => organizationName),
    ).toEqual(["Медиа Новости"]);
  });

  it("sorts health checks newest first without mutating the source", () => {
    const checks = [
      { id: "old", checkedAt: "2026-08-18T08:00:00.000Z" },
      { id: "new", checkedAt: "2026-08-18T14:30:00.000Z" },
    ];

    expect(sortPlacementChecks(checks).map(({ id }) => id)).toEqual(["new", "old"]);
    expect(checks.map(({ id }) => id)).toEqual(["old", "new"]);
  });
});

function placement(
  healthStatus: PlacementView["healthStatus"],
  businessStatus: PlacementView["businessStatus"],
): PlacementView {
  return {
    id: `${healthStatus}-${businessStatus}-${Math.random()}`,
    organizationId: "org-1",
    organizationName: "Партнёр",
    opportunityId: "opp-1",
    ownerId: "owner-1",
    ownerName: "Анна Соколова",
    pageUrl: "https://example.ru/video",
    urlPattern: "https://example.ru/video",
    embedType: "video",
    environment: "production",
    businessStatus,
    healthStatus,
    launchedAt: "2026-08-18T08:00:00.000Z",
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastSuccessAt: null,
    lastCheckAt: null,
    nextCheckAt: null,
    version: 1,
    lastCheck: null,
    activeAlert: null,
  };
}

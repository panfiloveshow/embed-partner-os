import type { HealthCheckView, PlacementView } from "@embed-os/contracts";

export interface PlacementFilters {
  query: string;
  status: "all" | PlacementView["healthStatus"];
  environment: "all" | PlacementView["environment"];
}

export function summarizePlacements(placements: PlacementView[]) {
  const active = placements.filter(({ businessStatus }) => businessStatus === "active");
  return {
    active: active.length,
    healthy: active.filter(({ healthStatus }) => healthStatus === "healthy").length,
    attention: active.filter(
      ({ healthStatus }) => healthStatus !== "healthy" && healthStatus !== "unchecked",
    ).length,
    unchecked: active.filter(({ healthStatus }) => healthStatus === "unchecked").length,
  };
}

export function filterPlacements(
  placements: PlacementView[],
  filters: PlacementFilters,
): PlacementView[] {
  const query = filters.query.trim().toLocaleLowerCase("ru");
  return placements.filter((placement) => {
    const matchesQuery =
      !query ||
      placement.organizationName.toLocaleLowerCase("ru").includes(query) ||
      placement.pageUrl.toLocaleLowerCase("ru").includes(query);
    const matchesStatus = filters.status === "all" || placement.healthStatus === filters.status;
    const matchesEnvironment =
      filters.environment === "all" || placement.environment === filters.environment;
    return matchesQuery && matchesStatus && matchesEnvironment;
  });
}

export function sortPlacementChecks<T extends Pick<HealthCheckView, "checkedAt">>(
  checks: T[],
): T[] {
  return [...checks].sort(
    (left, right) => new Date(right.checkedAt).getTime() - new Date(left.checkedAt).getTime(),
  );
}

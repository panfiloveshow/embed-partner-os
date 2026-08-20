import type {
  ArchivePlacementCommand,
  HealthCheckView,
  PlacementCheckResult,
  PlacementView,
  UpdatePlacementCommand,
} from "@embed-os/contracts";

export const PLACEMENT_PORT = Symbol("PLACEMENT_PORT");

export interface PlacementPort {
  list(): PlacementView[] | Promise<PlacementView[]>;
  register(input: unknown, idempotencyKey: string): PlacementView | Promise<PlacementView>;
  update(
    placementId: string,
    input: unknown,
    idempotencyKey: string,
  ): PlacementView | Promise<PlacementView>;
  archive(
    placementId: string,
    input: ArchivePlacementCommand | unknown,
    idempotencyKey: string,
  ): PlacementView | Promise<PlacementView>;
  runL0Check(
    placementId: string,
    idempotencyKey: string,
    source: "manual" | "schedule",
  ): Promise<PlacementCheckResult>;
  listChecks(placementId: string): HealthCheckView[] | Promise<HealthCheckView[]>;
}

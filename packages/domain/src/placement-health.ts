import type { L0CheckResult, PlacementHealthStatus } from "@embed-os/contracts";

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface PlacementHealthState {
  healthStatus: PlacementHealthStatus;
  consecutiveFailures: number;
  firstFailureAt: Date | null;
  lastSuccessAt: Date | null;
  activeAlert: boolean;
}

export interface PlacementHealthTransition {
  state: PlacementHealthState;
  alertAction: "none" | "open" | "close";
  nextCheckAt: Date;
}

export function applyPlacementHealthCheck(
  current: PlacementHealthState,
  check: { result: L0CheckResult; checkedAt: Date },
): PlacementHealthTransition {
  if (Number.isNaN(check.checkedAt.getTime())) {
    throw new RangeError("Health check timestamp is invalid");
  }

  if (check.result === "healthy") {
    return {
      state: {
        healthStatus: "healthy",
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastSuccessAt: check.checkedAt,
        activeAlert: false,
      },
      alertAction: current.activeAlert ? "close" : "none",
      nextCheckAt: new Date(check.checkedAt.getTime() + 6 * HOUR_MS),
    };
  }

  if (check.result === "failed") {
    const consecutiveFailures = current.consecutiveFailures + 1;
    const shouldOpen = consecutiveFailures >= 2 && !current.activeAlert;
    return {
      state: {
        healthStatus: consecutiveFailures >= 2 ? "failed" : "degraded",
        consecutiveFailures,
        firstFailureAt: current.firstFailureAt ?? check.checkedAt,
        lastSuccessAt: current.lastSuccessAt,
        activeAlert: current.activeAlert || shouldOpen,
      },
      alertAction: shouldOpen ? "open" : "none",
      nextCheckAt: new Date(
        check.checkedAt.getTime() + (consecutiveFailures === 1 ? 15 : 45) * MINUTE_MS,
      ),
    };
  }

  return {
    state: {
      healthStatus: "degraded",
      consecutiveFailures: 0,
      firstFailureAt: current.activeAlert ? current.firstFailureAt : null,
      lastSuccessAt: current.lastSuccessAt,
      activeAlert: current.activeAlert,
    },
    alertAction: "none",
    nextCheckAt: new Date(check.checkedAt.getTime() + 6 * HOUR_MS),
  };
}

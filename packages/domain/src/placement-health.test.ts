import { describe, expect, it } from "vitest";
import { applyPlacementHealthCheck, type PlacementHealthState } from "./placement-health.js";

const INITIAL: PlacementHealthState = {
  healthStatus: "unchecked",
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastSuccessAt: null,
  activeAlert: false,
};

describe("placement health state", () => {
  it("opens an alert only after the second consecutive confirmed failure", () => {
    const first = applyPlacementHealthCheck(INITIAL, {
      result: "failed",
      checkedAt: new Date("2026-08-18T09:00:00.000Z"),
    });
    expect(first).toMatchObject({
      alertAction: "none",
      nextCheckAt: new Date("2026-08-18T09:15:00.000Z"),
      state: {
        healthStatus: "degraded",
        consecutiveFailures: 1,
        firstFailureAt: new Date("2026-08-18T09:00:00.000Z"),
      },
    });

    const second = applyPlacementHealthCheck(first.state, {
      result: "failed",
      checkedAt: new Date("2026-08-18T09:15:00.000Z"),
    });
    expect(second).toMatchObject({
      alertAction: "open",
      nextCheckAt: new Date("2026-08-18T10:00:00.000Z"),
      state: { healthStatus: "failed", consecutiveFailures: 2, activeAlert: true },
    });
  });

  it("does not count blocked or unknown checks as confirmed failures", () => {
    const afterFailure = applyPlacementHealthCheck(INITIAL, {
      result: "failed",
      checkedAt: new Date("2026-08-18T09:00:00.000Z"),
    });
    const blocked = applyPlacementHealthCheck(afterFailure.state, {
      result: "blocked",
      checkedAt: new Date("2026-08-18T09:15:00.000Z"),
    });
    const failedAgain = applyPlacementHealthCheck(blocked.state, {
      result: "failed",
      checkedAt: new Date("2026-08-18T10:00:00.000Z"),
    });

    expect(blocked.state).toMatchObject({ healthStatus: "degraded", consecutiveFailures: 0 });
    expect(failedAgain).toMatchObject({
      alertAction: "none",
      state: { consecutiveFailures: 1 },
    });
  });

  it("closes an active alert after a successful recovery", () => {
    const result = applyPlacementHealthCheck(
      {
        healthStatus: "failed",
        consecutiveFailures: 3,
        firstFailureAt: new Date("2026-08-18T09:00:00.000Z"),
        lastSuccessAt: null,
        activeAlert: true,
      },
      { result: "healthy", checkedAt: new Date("2026-08-18T12:00:00.000Z") },
    );

    expect(result).toEqual({
      state: {
        healthStatus: "healthy",
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastSuccessAt: new Date("2026-08-18T12:00:00.000Z"),
        activeAlert: false,
      },
      alertAction: "close",
      nextCheckAt: new Date("2026-08-18T18:00:00.000Z"),
    });
  });
});

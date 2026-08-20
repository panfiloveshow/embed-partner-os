import { describe, expect, it } from "vitest";
import { evaluateOpportunitySla } from "./opportunity-sla.js";

const BASE = {
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
  lastInteractionAt: new Date("2026-08-10T09:00:00.000Z"),
  lastStageChangeAt: new Date("2026-08-08T09:00:00.000Z"),
  thresholdDays: 5,
  escalationAfterDays: 3,
  activeIncident: null,
};

describe("opportunity SLA", () => {
  it("opens one incident when the stage threshold is reached", () => {
    expect(
      evaluateOpportunitySla({
        ...BASE,
        now: new Date("2026-08-15T09:00:00.000Z"),
      }),
    ).toMatchObject({
      action: "open",
      activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
      thresholdReachedAt: new Date("2026-08-15T09:00:00.000Z"),
      violationAgeDays: 0,
    });
  });

  it("does not duplicate an active incident before escalation is due", () => {
    expect(
      evaluateOpportunitySla({
        ...BASE,
        now: new Date("2026-08-17T09:00:00.000Z"),
        activeIncident: {
          id: "incident-1",
          activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
          ownerNotifiedAt: new Date("2026-08-15T09:00:00.000Z"),
          escalatedAt: null,
        },
      }).action,
    ).toBe("none");
  });

  it("escalates only once after a prolonged violation", () => {
    const input = {
      ...BASE,
      now: new Date("2026-08-18T09:00:00.000Z"),
      activeIncident: {
        id: "incident-1",
        activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
        ownerNotifiedAt: new Date("2026-08-15T09:00:00.000Z"),
        escalatedAt: null,
      },
    };
    expect(evaluateOpportunitySla(input).action).toBe("escalate");
    expect(
      evaluateOpportunitySla({
        ...input,
        activeIncident: {
          ...input.activeIncident,
          escalatedAt: new Date("2026-08-18T09:00:00.000Z"),
        },
      }).action,
    ).toBe("none");
  });

  it("resolves the incident after activity or leaving the active state", () => {
    const activeIncident = {
      id: "incident-1",
      activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
      ownerNotifiedAt: new Date("2026-08-15T09:00:00.000Z"),
      escalatedAt: null,
    };
    expect(
      evaluateOpportunitySla({
        ...BASE,
        now: new Date("2026-08-18T09:00:00.000Z"),
        lastInteractionAt: new Date("2026-08-18T08:00:00.000Z"),
        activeIncident,
      }).action,
    ).toBe("resolve");
    expect(
      evaluateOpportunitySla({
        ...BASE,
        status: "WAITING",
        now: new Date("2026-08-18T09:00:00.000Z"),
        activeIncident,
      }).action,
    ).toBe("resolve");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  OpportunitySlaMonitorService,
  type OpportunitySlaCandidate,
  type OpportunitySlaMonitorStore,
} from "./opportunity-sla-monitor.service.js";

const NOW = new Date("2026-08-20T09:00:00.000Z");

describe("opportunity SLA monitor", () => {
  it("opens one owner warning and does not invent duplicates", async () => {
    const store = fakeStore([candidate()]);
    const monitor = new OpportunitySlaMonitorService(store, () => NOW);

    await expect(monitor.runBatch()).resolves.toEqual({
      scanned: 1,
      opened: 1,
      escalated: 0,
      resolved: 0,
    });
    expect(store.openIncident).toHaveBeenCalledOnce();
    expect(store.escalateIncident).not.toHaveBeenCalled();
  });

  it("escalates a prolonged incident once", async () => {
    const store = fakeStore([
      candidate({
        activeIncident: {
          id: "incident-1",
          activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
          ownerNotifiedAt: new Date("2026-08-17T09:00:00.000Z"),
          escalatedAt: null,
        },
      }),
    ]);
    const monitor = new OpportunitySlaMonitorService(store, () => NOW);

    const result = await monitor.runBatch();

    expect(result.escalated).toBe(1);
    expect(store.escalateIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "incident-1",
      }),
    );
  });

  it("resolves the old incident when new activity changes the marker", async () => {
    const store = fakeStore([
      candidate({
        lastInteractionAt: new Date("2026-08-20T08:00:00.000Z"),
        activeIncident: {
          id: "incident-1",
          activityMarkerAt: new Date("2026-08-10T09:00:00.000Z"),
          ownerNotifiedAt: new Date("2026-08-17T09:00:00.000Z"),
          escalatedAt: null,
        },
      }),
    ]);
    const monitor = new OpportunitySlaMonitorService(store, () => NOW);

    const result = await monitor.runBatch();

    expect(result.resolved).toBe(1);
    expect(store.resolveIncident).toHaveBeenCalledOnce();
  });
});

function candidate(overrides: Partial<OpportunitySlaCandidate> = {}): OpportunitySlaCandidate {
  return {
    id: "opportunity-1",
    organizationId: "organization-1",
    organizationName: "Медиа",
    ownerId: "owner-1",
    ownerName: "Анна Соколова",
    ownerEmail: "anna@example.test",
    teamId: "team-1",
    teamName: "Команда внедрения",
    stageCode: "S4",
    stageLabel: "Диалог",
    status: "ACTIVE",
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    lastInteractionAt: new Date("2026-08-10T09:00:00.000Z"),
    lastStageChangeAt: new Date("2026-08-08T09:00:00.000Z"),
    thresholdDays: 5,
    escalationAfterDays: 3,
    activeIncident: null,
    ...overrides,
  };
}

function fakeStore(candidates: OpportunitySlaCandidate[]): OpportunitySlaMonitorStore {
  return {
    listCandidates: vi.fn(async () => candidates),
    openIncident: vi.fn(async () => true),
    escalateIncident: vi.fn(async () => true),
    resolveIncident: vi.fn(async () => true),
  };
}

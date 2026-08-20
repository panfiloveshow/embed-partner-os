import { describe, expect, it } from "vitest";
import type { RadarPort } from "../radar.port.js";
import {
  RadarRecheckScheduler,
  radarRecheckKey,
  type RadarRecheckStore,
} from "./radar-recheck-scheduler.js";

describe("RadarRecheckScheduler", () => {
  it("inspects every due candidate with a stable time-slot key", async () => {
    const calls: Array<{ id: string; key: string }> = [];
    const store: RadarRecheckStore = {
      async listDue() {
        return [{ id: "candidate-1" }, { id: "candidate-2" }];
      },
    };
    const radar = {
      async inspect(id: string, key: string) {
        calls.push({ id, key });
        return {};
      },
    } as unknown as RadarPort;
    const now = new Date("2026-08-20T12:00:00.000Z");
    const intervalMs = 7 * 24 * 60 * 60_000;

    const result = await new RadarRecheckScheduler(store, radar, () => now).runBatch(intervalMs, 25);

    expect(result).toEqual({ selected: 2, inspected: 2, failed: 0 });
    expect(calls).toEqual([
      { id: "candidate-1", key: radarRecheckKey("candidate-1", now, intervalMs) },
      { id: "candidate-2", key: radarRecheckKey("candidate-2", now, intervalMs) },
    ]);
  });

  it("continues the batch when one site cannot be inspected", async () => {
    const store: RadarRecheckStore = { async listDue() { return [{ id: "bad" }, { id: "ok" }]; } };
    const radar = {
      async inspect(id: string) {
        if (id === "bad") throw new Error("site unavailable");
        return {};
      },
    } as unknown as RadarPort;

    await expect(new RadarRecheckScheduler(store, radar).runBatch(60_000, 10)).resolves.toEqual({
      selected: 2,
      inspected: 1,
      failed: 1,
    });
  });
});

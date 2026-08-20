import { describe, expect, it } from "vitest";
import { defaultWeeklyReportCommand } from "./reporting.js";

describe("defaultWeeklyReportCommand", () => {
  it("selects the previous completed Moscow week", () => {
    expect(defaultWeeklyReportCommand(new Date("2026-08-18T08:30:00.000Z"))).toEqual({
      periodStart: "2026-08-10",
      dataAsOf: "2026-08-18T08:30:00.000Z",
      formulaVersion: "weekly-v1",
    });
  });

  it("keeps the previous week when run early on Monday Moscow time", () => {
    expect(defaultWeeklyReportCommand(new Date("2026-08-17T06:00:00.000Z")).periodStart).toBe(
      "2026-08-10",
    );
  });
});

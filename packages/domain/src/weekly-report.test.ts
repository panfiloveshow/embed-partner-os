import { describe, expect, it } from "vitest";
import { DomainRuleError } from "./task-completion.js";
import {
  parseGenerateWeeklyReportCommand,
  weeklyReportPeriod,
} from "./weekly-report.js";

describe("weekly report command", () => {
  it("normalizes data_as_of and builds Moscow Monday-to-Sunday bounds", () => {
    expect(
      parseGenerateWeeklyReportCommand({
        periodStart: "2026-08-10",
        dataAsOf: "2026-08-17T10:00:00+03:00",
        formulaVersion: "weekly-v1",
      }),
    ).toEqual({
      periodStart: "2026-08-10",
      dataAsOf: "2026-08-17T07:00:00.000Z",
      formulaVersion: "weekly-v1",
    });

    expect(weeklyReportPeriod("2026-08-10")).toEqual({
      start: new Date("2026-08-09T21:00:00.000Z"),
      end: new Date("2026-08-16T20:59:59.999Z"),
    });
  });

  it("requires a Monday and an explicit timezone", () => {
    expect(() =>
      parseGenerateWeeklyReportCommand({
        periodStart: "2026-08-11",
        dataAsOf: "2026-08-17T10:00:00",
        formulaVersion: "weekly-v1",
      }),
    ).toThrowError(DomainRuleError);
  });

  it("does not publish before the reporting week ends", () => {
    try {
      parseGenerateWeeklyReportCommand({
        periodStart: "2026-08-10",
        dataAsOf: "2026-08-16T20:00:00+03:00",
        formulaVersion: "weekly-v1",
      });
      throw new Error("Expected report validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainRuleError);
      expect((error as DomainRuleError).fieldErrors.dataAsOf).toMatch(
        /окончания отчётной недели/i,
      );
    }
  });
});

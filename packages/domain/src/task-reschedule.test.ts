import { describe, expect, it } from "vitest";
import { DomainRuleError } from "./task-completion.js";
import { parseRescheduleTaskCommand } from "./task-reschedule.js";

describe("parseRescheduleTaskCommand", () => {
  it("normalizes a new deadline and mandatory reason", () => {
    expect(
      parseRescheduleTaskCommand({
        dueAt: "2026-08-20T12:00:00+03:00",
        reason: "  Ждём данные от партнёра  ",
      }),
    ).toEqual({
      dueAt: "2026-08-20T09:00:00.000Z",
      reason: "Ждём данные от партнёра",
    });
  });

  it("rejects a transfer without a reason", () => {
    expect(() =>
      parseRescheduleTaskCommand({
        dueAt: "2026-08-20T12:00:00+03:00",
        reason: " ",
      }),
    ).toThrowError(DomainRuleError);
  });

  it("rejects an invalid deadline", () => {
    expect(() =>
      parseRescheduleTaskCommand({
        dueAt: "tomorrow",
        reason: "Партнёр попросил вернуться позже",
      }),
    ).toThrowError(/дат/i);
  });
});
